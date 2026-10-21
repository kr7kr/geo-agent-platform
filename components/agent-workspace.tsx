"use client";

import {
  ArrowRight,
  Braces,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Database,
  GitBranch,
  LocateFixed,
  MapPinned,
  Network,
  Orbit,
  Play,
  Radar,
  ScanSearch,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  type LucideIcon,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Decision, ResolveResponse } from "@/lib/agent/types";
import { SpatialMap } from "./spatial-map";

declare global {
  interface Document {
    modelContext?: {
      registerTool: (
        tool: {
          name: string;
          title: string;
          description: string;
          inputSchema: object;
          annotations: {
            readOnlyHint: boolean;
            untrustedContentHint: boolean;
          };
          execute: (input: unknown) => Promise<unknown>;
        },
        options?: { signal?: AbortSignal },
      ) => void | Promise<void>;
    };
  }
}

const SAMPLES = [
  "北京市海淀区北京大学东门",
  "北航附近的麦当劳",
  "北矿大附近",
  "安理附近的咖啡店",
  "西安交大",
  "望京SOHO东侧约300米",
  "火星基地附近",
];

const decisionStyle: Record<
  Decision,
  { label: string; className: string }
> = {
  RESOLVED: {
    label: "精确定位",
    className: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  },
  COARSE: {
    label: "范围推断",
    className: "border-amber-400/25 bg-amber-400/10 text-amber-200",
  },
  ABSTAIN: {
    label: "主动拒答",
    className: "border-rose-400/25 bg-rose-400/10 text-rose-200",
  },
  NEED_CLARIFICATION: {
    label: "需要澄清",
    className: "border-violet-400/25 bg-violet-400/10 text-violet-200",
  },
};

const stepIcons = [ScanSearch, Database, Network, GitBranch, Orbit];

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function shortRunId(runId: string) {
  return runId.split("-")[0].toUpperCase();
}

interface RunHistoryEntry {
  runId: string;
  inputText: string;
  decision: Decision;
  selectedName: string | null;
  createdAt: string;
}

type McpStatus = "checking" | "online" | "offline";

const DEFAULT_MCP_TOOLS = [
  "geo.resolve_text",
  "geo.retrieve_knowledge",
  "geo.entity_link",
  "geo.search_text",
  "geo.resolve_anchor",
  "geo.search_around",
  "geo.distance",
];

const MCP_TOOL_LABELS: Record<string, string> = {
  "geo.resolve_text": "完整空间 Agent",
  "geo.retrieve_knowledge": "地理知识图谱 RAG",
  "geo.entity_link": "口语实体链接",
  "geo.search_text": "文本 POI 搜索",
  "geo.resolve_anchor": "锚点解析",
  "geo.search_around": "周边 POI 搜索",
  "geo.distance": "WGS84 距离",
  "agent.semantic_plan": "语义规划",
  "agent.tool_router": "工具规划",
  "agent.intent_router": "条件路由",
  "agent.query_rewrite": "查询改写",
  "agent.rank_candidates": "证据融合排序",
  "agent.verify_evidence": "证据验证",
  "agent.reflect_evidence": "证据反思重检",
  "agent.decision": "决策与拒答",
  "agent.adaptive_s2": "自适应 S2 空间化",
};

function readRunHistory(): RunHistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = window.localStorage.getItem("geolink:run-history");
    return stored ? (JSON.parse(stored) as RunHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

export function AgentWorkspace({
  initialResult,
}: {
  initialResult: ResolveResponse;
}) {
  const [text, setText] = useState(initialResult.inputText);
  const [result, setResult] = useState(initialResult);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<"trace" | "candidates">(
    "trace",
  );
  const [history, setHistory] = useState<RunHistoryEntry[]>([]);
  const [feedback, setFeedback] = useState<"positive" | "negative" | null>(null);
  const [mcpStatus, setMcpStatus] = useState<McpStatus>("checking");
  const [mcpTools, setMcpTools] = useState<string[]>(DEFAULT_MCP_TOOLS);

  useEffect(() => {
    const timer = window.setTimeout(() => setHistory(readRunHistory()), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/mcp", { headers: { Accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) throw new Error("MCP endpoint unavailable");
        const payload = (await response.json()) as { tools?: unknown };
        const names = Array.isArray(payload.tools)
          ? payload.tools.filter((tool): tool is string => typeof tool === "string")
          : [];
        if (cancelled) return;
        setMcpStatus("online");
        if (names.length) setMcpTools(names);
      })
      .catch(() => {
        if (!cancelled) setMcpStatus("offline");
      });
    return () => { cancelled = true; };
  }, []);

  const runAgent = useCallback(async (inputText: string) => {
    const normalized = inputText.trim();
    if (!normalized) {
      setError("请先输入一段包含地点或空间关系的中文文本。");
      return null;
    }

    setIsRunning(true);
    setError(null);
    try {
      const response = await fetch("/api/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: normalized }),
      });
      const payload = (await response.json()) as ResolveResponse & {
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error ?? "Agent 运行失败");
      setResult(payload);
      setFeedback(null);
      const entry: RunHistoryEntry = {
        runId: payload.runId,
        inputText: normalized,
        decision: payload.decision,
        selectedName: payload.selectedCandidate?.name ?? null,
        createdAt: new Date().toISOString(),
      };
      setHistory((current) => {
        const next = [entry, ...current.filter((item) => item.inputText !== normalized)].slice(0, 8);
        try {
          window.localStorage.setItem("geolink:run-history", JSON.stringify(next));
        } catch {
          // Ignore quota/privacy mode failures.
        }
        return next;
      });
      return payload;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Agent 运行失败");
      return null;
    } finally {
      setIsRunning(false);
    }
  }, []);

  function recordFeedback(value: "positive" | "negative") {
    setFeedback(value);
    void fetch("/api/cases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caseId: result.runId, feedback: value }),
    }).catch(() => undefined);
    try {
      window.localStorage.setItem(`geolink:feedback:${result.runId}`, JSON.stringify({
        runId: result.runId,
        inputText: result.inputText,
        decision: result.decision,
        value,
        createdAt: new Date().toISOString(),
      }));
    } catch {
      // Feedback remains visible for the current run even if storage is blocked.
    }
  }

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();

    void Promise.resolve(
      context.registerTool(
        {
          name: "resolve_geographic_text",
          title: "解析中文地理文本",
          description:
            "运行当前页面的空间推理 Agent，并在地图上显示实体候选和自适应 S2 网格。",
          inputSchema: {
            type: "object",
            properties: {
              text: { type: "string", minLength: 1, maxLength: 2000 },
            },
            required: ["text"],
            additionalProperties: false,
          },
          annotations: {
            readOnlyHint: true,
            untrustedContentHint: true,
          },
          async execute(input) {
            const candidate = input as { text?: unknown };
            if (
              typeof candidate.text !== "string" ||
              !candidate.text.trim()
            ) {
              throw new Error("text 必须是非空字符串");
            }
            setText(candidate.text);
            const next = await runAgent(candidate.text);
            if (!next) throw new Error("空间推理未完成");
            return {
              runId: next.runId,
              decision: next.decision,
              confidence: next.confidence,
              selected: next.selectedCandidate?.name ?? null,
              s2Level: next.spatial?.level ?? null,
              s2Cells: next.spatial?.cellIds ?? [],
            };
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => undefined);

    return () => lifecycle.abort();
  }, [runAgent]);

  const decision = decisionStyle[result.decision];
  const primaryCandidate =
    result.selectedCandidate ?? result.candidates[0] ?? null;
  const uncertainty = useMemo(
    () => result.spatial?.combinedUncertainty ?? 1 - result.confidence,
    [result],
  );
  const traceToolCalls = useMemo(
    () => result.steps.map((item, index) => ({
      key: `${item.id}-${index}`,
      id: item.id,
      tool: item.tool,
      status: item.status,
    })),
    [result.steps],
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    void runAgent(text);
  }

  return (
    <main className="min-h-screen bg-[#050b12] text-slate-100">
      <header className="border-b border-white/[0.07] bg-[#07111b]/90 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1680px] items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center rounded-xl border border-cyan-300/20 bg-cyan-300/[0.08] text-cyan-200">
              <Radar className="h-[19px] w-[19px]" />
            </div>
            <div>
              <div className="flex items-baseline gap-2">
                <span className="font-semibold tracking-tight">GeoLink</span>
                <span className="text-xs font-medium text-cyan-300/80">
                  S2 AGENT
                </span>
              </div>
              <p className="text-xs text-slate-500">
                中文地理文本空间推理工作台
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs">
            <Link href="/evaluation" className="hidden rounded-full border border-white/[0.08] px-3 py-1.5 text-slate-400 transition hover:border-cyan-300/25 hover:text-cyan-200 sm:inline">
              评测仪表盘
            </Link>
            <span className="hidden items-center gap-2 rounded-full border border-white/[0.08] px-3 py-1.5 text-slate-400 sm:flex">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  result.provenance.retrievalMode === "amap-online"
                    ? "bg-emerald-400"
                    : "bg-amber-300"
                }`}
              />
              {result.provenance.retrievalMode === "amap-online"
                ? "高德 POI 在线"
                : "演示索引"}
            </span>
            <span className="hidden rounded-full border border-white/[0.08] px-3 py-1.5 text-slate-500 lg:inline">
              LLM · {result.provenance.llmMode === "disabled" ? "规则模式" : result.provenance.llmMode}
            </span>
            <span className="rounded-full border border-white/[0.08] px-3 py-1.5 font-mono text-slate-500">
              RUN {shortRunId(result.runId)}
            </span>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-[1680px] px-4 py-5 sm:px-6 lg:px-8">
        <form
          onSubmit={submit}
          className="rounded-2xl border border-white/[0.08] bg-[#0a1521] shadow-[0_24px_80px_rgba(0,0,0,0.22)]"
        >
          <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3 text-sm text-slate-400 sm:px-5">
            <Sparkles className="h-4 w-4 text-cyan-300" />
            <span>
              输入一段中文地理文本，Agent 将自主选择工具并形成可审计空间结论
            </span>
          </div>
          <div className="flex flex-col gap-3 p-3 sm:flex-row sm:items-end sm:p-4">
            <Textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                  event.preventDefault();
                  void runAgent(text);
                }
              }}
              aria-label="待解析的中文地理文本"
              placeholder="例如：望京SOHO东侧约300米，靠近阜通东大街……"
              className="min-h-[84px] flex-1 resize-none border-white/[0.08] bg-[#07111b] px-4 py-3 text-base leading-7 text-slate-100 placeholder:text-slate-600 focus-visible:border-cyan-300/40 focus-visible:ring-cyan-300/15"
            />
            <Button
              type="submit"
              disabled={isRunning}
              className="h-12 min-w-36 rounded-xl bg-cyan-300 px-5 font-semibold text-slate-950 hover:bg-cyan-200"
            >
              {isRunning ? (
                <>
                  <Orbit className="animate-spin" /> 推理中
                </>
              ) : (
                <>
                  <Play className="fill-current" /> 运行 Agent
                </>
              )}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2 px-4 pb-4 sm:px-5">
            <span className="mr-1 text-xs text-slate-600">示例</span>
            {SAMPLES.map((sample) => (
              <button
                key={sample}
                type="button"
                onClick={() => setText(sample)}
                className="rounded-full border border-white/[0.07] bg-white/[0.025] px-3 py-1.5 text-xs text-slate-400 transition hover:border-cyan-300/25 hover:text-cyan-200"
              >
                {sample}
              </button>
            ))}
            <span className="ml-auto hidden text-xs text-slate-600 md:inline">
              Ctrl / ⌘ + Enter 运行
            </span>
          </div>
        </form>

        <section className="mt-3 rounded-2xl border border-cyan-300/15 bg-[#09141f] shadow-[0_16px_50px_rgba(0,0,0,0.14)]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-3 sm:px-5">
            <div className="flex items-center gap-3">
              <div className="grid h-8 w-8 place-items-center rounded-lg border border-cyan-300/20 bg-cyan-300/[0.08] text-cyan-200">
                <Network className="h-4 w-4" />
              </div>
              <div>
                <div className="flex items-center gap-2 text-sm font-medium text-slate-200">
                  MCP 工具路由
                  <span className="rounded-md border border-white/[0.08] px-1.5 py-0.5 font-mono text-[10px] text-slate-500">JSON-RPC</span>
                </div>
                <p className="mt-0.5 text-xs text-slate-600">Agent 与外部客户端共用同一套只读工具注册表</p>
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className={`h-1.5 w-1.5 rounded-full ${mcpStatus === "online" ? "bg-emerald-400" : mcpStatus === "offline" ? "bg-rose-400" : "animate-pulse bg-amber-300"}`} />
              <span className={mcpStatus === "online" ? "text-emerald-200" : mcpStatus === "offline" ? "text-rose-200" : "text-amber-200"}>
                {mcpStatus === "online" ? "服务在线" : mcpStatus === "offline" ? "服务不可用" : "检测中"}
              </span>
              <a href="/api/mcp" target="_blank" rel="noreferrer" className="ml-2 rounded-md border border-white/[0.08] px-2 py-1 text-slate-500 transition hover:border-cyan-300/25 hover:text-cyan-200">
                查看接口
              </a>
            </div>
          </div>
          <div className="grid gap-4 px-4 py-3 sm:px-5">
            <div>
              <div className="mb-2 text-[11px] uppercase tracking-[0.14em] text-slate-600">可发现工具 · {mcpTools.length}</div>
              <div className="flex flex-wrap gap-2">
                {mcpTools.map((tool) => (
                  <span key={tool} title={tool} className="rounded-md border border-white/[0.07] bg-white/[0.02] px-2 py-1 text-xs text-slate-400">
                    <span className="text-cyan-200/80">{MCP_TOOL_LABELS[tool] ?? tool}</span>
                    <span className="ml-1.5 font-mono text-[10px] text-slate-600">{tool}</span>
                  </span>
                ))}
              </div>
            </div>
          </div>
          <div className="border-t border-white/[0.05] px-4 py-2 text-[11px] text-slate-600 sm:px-5">
            下方 Agent 轨迹与此处使用同一份执行记录；当前计划：{result.toolPlan.length ? result.toolPlan.map((tool) => tool.id).join(" → ") : "等待 Agent 运行"}
          </div>
        </section>

        {history.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-white/[0.06] bg-[#09141f] px-4 py-3 text-xs">
            <span className="mr-1 flex items-center gap-1.5 text-slate-500"><Clock3 className="h-3.5 w-3.5" /> 最近运行</span>
            {history.slice(0, 5).map((item) => (
              <button
                key={item.runId}
                type="button"
                onClick={() => { setText(item.inputText); void runAgent(item.inputText); }}
                className="max-w-[240px] truncate rounded-full border border-white/[0.07] px-3 py-1.5 text-slate-400 transition hover:border-cyan-300/25 hover:text-cyan-200"
                title={item.inputText}
              >
                {item.inputText} · {item.decision}
              </button>
            ))}
          </div>
        )}

        {error && (
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-rose-400/20 bg-rose-400/[0.07] px-4 py-3 text-sm text-rose-200">
            <CircleAlert className="h-4 w-4" /> {error}
          </div>
        )}

        <div className="mt-5 grid min-h-[620px] gap-5 xl:h-[calc(100vh-13rem)] xl:min-h-0 xl:grid-cols-[minmax(430px,0.82fr)_minmax(620px,1.18fr)]">
          <section className="flex h-full min-h-[620px] flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#09141f] xl:min-h-0">
            <div className="shrink-0 border-b border-white/[0.07] p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.12em] text-slate-500">
                    <LocateFixed className="h-3.5 w-3.5" /> Spatial Decision
                  </div>
                  <div className="mt-2 flex items-center gap-3">
                    <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
                      {primaryCandidate?.name ?? "无法确定空间位置"}
                    </h1>
                    <span
                      className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${decision.className}`}
                    >
                      {decision.label}
                    </span>
                  </div>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
                    {result.summary}
                  </p>
                  {result.clarification && (
                    <div className="mt-3 rounded-xl border border-violet-300/20 bg-violet-300/[0.06] p-3">
                      <div className="text-sm font-medium text-violet-100">{result.clarification.question}</div>
                      <div className="mt-1 text-xs leading-5 text-violet-200/60">{result.clarification.reason}</div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {result.clarification.options.map((option) => (
                          <button
                            key={option}
                            type="button"
                            onClick={() => {
                              const target = result.intent.target?.name;
                              const followUp = target && result.intent.anchors.length
                                ? `${option}附近的${target}`
                                : option;
                              setText(followUp);
                              void runAgent(followUp);
                            }}
                            className="rounded-lg border border-violet-300/25 bg-violet-300/10 px-3 py-2 text-xs text-violet-100 transition hover:bg-violet-300/20"
                          >
                            {option}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-500">
                    <span className="rounded-md border border-white/[0.07] px-2 py-1">
                      意图 · {result.intent.type}
                    </span>
                    <span className="rounded-md border border-white/[0.07] px-2 py-1">
                      目标 · {result.intent.target?.name ?? "未识别"}
                    </span>
                    {result.anchor && (
                      <span className="rounded-md border border-cyan-300/15 bg-cyan-300/[0.04] px-2 py-1 text-cyan-200/80">
                        锚点 · {result.anchor.name}
                      </span>
                    )}
                    {result.entityLinks.filter((link) => link.status === "LINKED").map((link) => (
                      <span
                        key={`${link.role}-${link.mention}`}
                        className="rounded-md border border-violet-300/15 bg-violet-300/[0.04] px-2 py-1 text-violet-200/80"
                      >
                        {link.mention} → {link.selectedCanonicalName}
                      </span>
                    ))}
                  </div>
                  <div className="mt-3 rounded-xl border border-violet-300/15 bg-violet-300/[0.035] px-3 py-2.5 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <Database className="h-3.5 w-3.5 text-violet-200" />
                      <span className="font-medium text-violet-100">地理知识图谱 RAG</span>
                      <span className="text-violet-200/60">
                        {result.knowledge.hits.length
                          ? `召回 ${result.knowledge.hits.length} 条待验证线索`
                          : "未命中强图谱线索，使用原始文本检索"}
                      </span>
                    </div>
                    {result.knowledge.hits.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {result.knowledge.hits.map((hit) => (
                          <span
                            key={hit.nodeId}
                            title={[...hit.facts, ...hit.relations].join("\n")}
                            className="rounded-md border border-violet-300/15 bg-violet-300/[0.05] px-2 py-1 text-violet-100/80"
                          >
                            {hit.canonicalName}
                            <span className="ml-1 font-mono text-[10px] text-violet-200/50">
                              {percent(hit.score)}
                            </span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="min-w-24 text-right">
                  <div className="font-mono text-3xl font-semibold tracking-tight text-cyan-200">
                    {percent(result.confidence)}
                  </div>
                  <div className="text-xs text-slate-500">决策分数</div>
                </div>
              </div>
              <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Metric label="候选" value={`${result.candidates.length}`} suffix="个" />
                <Metric
                  label="S2 层级"
                  value={result.spatial ? `L${result.spatial.level}` : "—"}
                />
                <Metric label="联合不确定性" value={percent(uncertainty)} />
                <Metric label="工具计划" value={`${result.toolPlan.length}`} suffix="步" />
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
                <span>运行 {shortRunId(result.runId)} · 结果会保存在本机浏览器历史中</span>
                <div className="flex items-center gap-2">
                  <span>结果是否有帮助？</span>
                  <button type="button" onClick={() => recordFeedback("positive")} className={`rounded-md border px-2 py-1 transition ${feedback === "positive" ? "border-emerald-300/40 bg-emerald-300/10 text-emerald-200" : "border-white/[0.08] hover:border-emerald-300/30 hover:text-emerald-200"}`}><ThumbsUp className="mr-1 inline h-3 w-3" />正确</button>
                  <button type="button" onClick={() => recordFeedback("negative")} className={`rounded-md border px-2 py-1 transition ${feedback === "negative" ? "border-rose-300/40 bg-rose-300/10 text-rose-200" : "border-white/[0.08] hover:border-rose-300/30 hover:text-rose-200"}`}><ThumbsDown className="mr-1 inline h-3 w-3" />需修正</button>
                </div>
              </div>
            </div>

            <div className="flex shrink-0 border-b border-white/[0.06] px-5">
              <PanelTab
                active={activePanel === "trace"}
                onClick={() => setActivePanel("trace")}
                icon={GitBranch}
              >
                Agent 轨迹
              </PanelTab>
              <PanelTab
                active={activePanel === "candidates"}
                onClick={() => setActivePanel("candidates")}
                icon={MapPinned}
              >
                候选实体
              </PanelTab>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              {activePanel === "trace" ? (
                <div className="space-y-4">
                  <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
                    <div className="mb-2 text-[11px] uppercase tracking-[0.14em] text-slate-600">
                      本次运行 · 轨迹同步
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {traceToolCalls.length ? traceToolCalls.map((call) => (
                        <span
                          key={call.key}
                          title={`${call.id} · ${call.tool}`}
                          className={`rounded-md border px-2 py-1 text-xs ${
                            call.status === "warning"
                              ? "border-amber-300/15 bg-amber-300/[0.05] text-amber-200/90"
                              : call.status === "skipped"
                                ? "border-white/[0.08] bg-white/[0.02] text-slate-500"
                                : "border-emerald-300/15 bg-emerald-300/[0.05] text-emerald-200/90"
                          }`}
                        >
                          {call.status === "warning" ? "!" : call.status === "skipped" ? "–" : "✓"}{" "}
                          {MCP_TOOL_LABELS[call.tool] ?? call.tool}
                          <span className="ml-1.5 font-mono text-[10px] opacity-60">{call.tool}</span>
                        </span>
                      )) : (
                        <span className="text-xs text-slate-600">运行一次 Agent 后显示执行序列</span>
                      )}
                    </div>
                  </div>

                  <div className="relative space-y-1">
                    <div className="absolute bottom-5 left-[17px] top-5 w-px bg-gradient-to-b from-cyan-300/35 via-cyan-300/15 to-transparent" />
                    {result.steps.map((step, index) => {
                      const Icon = stepIcons[index] ?? Braces;
                      return (
                        <div
                          key={step.id}
                          className="relative flex gap-4 rounded-xl px-1 py-3"
                        >
                          <div
                            className={`relative z-10 grid h-9 w-9 shrink-0 place-items-center rounded-lg border ${
                              step.status === "warning"
                                ? "border-amber-300/25 bg-amber-300/10 text-amber-200"
                                : step.status === "skipped"
                                  ? "border-white/10 bg-white/[0.04] text-slate-500"
                                  : "border-cyan-300/25 bg-cyan-300/[0.08] text-cyan-200"
                            }`}
                          >
                            <Icon className="h-4 w-4" />
                          </div>
                          <div className="min-w-0 flex-1 pt-0.5">
                            <div className="flex items-center justify-between gap-3">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-slate-200">
                                  {step.label}
                                </span>
                                {step.status === "complete" && (
                                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                                )}
                              </div>
                              <span className="font-mono text-[11px] text-slate-600">
                                {step.durationMs} ms
                              </span>
                            </div>
                            <p className="mt-1 text-sm leading-5 text-slate-500">
                              {step.summary}
                            </p>
                            {step.details && step.details.length > 0 && (
                              <div className="mt-2 space-y-1 border-l border-cyan-300/15 pl-3 text-xs leading-5 text-slate-500">
                                {step.details.map((detail) => (
                                  <p key={detail}>{detail}</p>
                                ))}
                              </div>
                            )}
                            <div className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-white/[0.035] px-2 py-1 font-mono text-[11px] text-slate-500">
                              <Braces className="h-3 w-3" /> {step.tool}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {result.candidates.length ? (
                    result.candidates.map((candidate, index) => (
                      <article
                        key={candidate.id}
                        className={`rounded-xl border p-4 ${
                          index === 0
                            ? "border-cyan-300/20 bg-cyan-300/[0.045]"
                            : "border-white/[0.07] bg-white/[0.02]"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-xs text-slate-600">
                                #{index + 1}
                              </span>
                              <h2 className="truncate font-medium text-slate-200">
                                {candidate.name}
                              </h2>
                            </div>
                            <p className="mt-1 truncate text-sm text-slate-500">
                              {candidate.address || candidate.category}
                            </p>
                          </div>
                          <span className="font-mono text-sm text-cyan-200">
                            {percent(candidate.score)}
                          </span>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-slate-500">
                          <span className="rounded-md border border-white/[0.06] px-2 py-1">
                            {candidate.source}
                          </span>
                          <span className="rounded-md border border-white/[0.06] px-2 py-1">
                            {candidate.location.join(", ")}
                          </span>
                          {candidate.distanceMeters !== undefined && (
                            <span className="rounded-md border border-white/[0.06] px-2 py-1">
                              锚点距离 {candidate.distanceMeters}m
                            </span>
                          )}
                        </div>
                        {candidate.scores && (
                          <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-slate-500 sm:grid-cols-4">
                            <span>名称 {percent(candidate.scores.nameScore)}</span>
                            <span>实体链接 {percent(candidate.scores.entityLinkScore)}</span>
                            <span>行政区 {percent(candidate.scores.adminScore)}</span>
                            <span>空间 {percent(candidate.scores.spatialScore)}</span>
                          </div>
                        )}
                        <ul className="mt-3 space-y-1 text-xs leading-5 text-slate-500">
                          {candidate.evidence.slice(-4).map((reason) => (
                            <li key={reason}>· {reason}</li>
                          ))}
                        </ul>
                      </article>
                    ))
                  ) : (
                    <div className="grid min-h-64 place-items-center text-center">
                      <div>
                        <CircleAlert className="mx-auto h-7 w-7 text-slate-600" />
                        <p className="mt-3 text-sm text-slate-400">
                          没有可验证候选
                        </p>
                        <p className="mt-1 text-xs text-slate-600">
                          请补充城市、道路或附近地标
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <footer className="shrink-0 border-t border-white/[0.06] px-5 py-3 text-xs text-slate-600">
              <div className="flex items-center justify-between gap-4">
                <span>
                  {result.provenance.orchestrator} ·{" "}
                  {result.provenance.graphVersion}
                </span>
                <span>
                  {result.provenance.coordinatePipeline} · RAG {result.provenance.knowledgeRag.hitCount} · LLM {result.provenance.llmMode}
                </span>
              </div>
            </footer>
          </section>

          <section className="relative h-full min-h-[620px] overflow-hidden rounded-2xl border border-white/[0.08] bg-[#07131f] xl:min-h-0">
            <SpatialMap result={result} />
            <div className="pointer-events-none absolute left-4 top-4 flex max-w-[calc(100%-2rem)] items-center gap-2 rounded-xl border border-white/10 bg-[#07111b]/90 px-3 py-2 text-xs shadow-xl backdrop-blur-xl">
              <MapPinned className="h-4 w-4 text-cyan-300" />
              <span className="text-slate-300">WGS84</span>
              <ChevronRight className="h-3.5 w-3.5 text-slate-600" />
              <span className="font-mono text-cyan-200">
                {result.spatial
                  ? `S2 / L${result.spatial.level} / ${result.spatial.cellCount} CELLS`
                  : "NO SPATIAL OUTPUT"}
              </span>
            </div>
            {result.spatial && (
              <div className="absolute bottom-4 left-4 right-16 grid gap-2 sm:right-auto sm:min-w-[310px] sm:grid-cols-2">
                <div className="rounded-xl border border-white/10 bg-[#07111b]/90 p-3 shadow-xl backdrop-blur-xl">
                  <div className="text-[11px] uppercase tracking-wider text-slate-600">
                    Semantic uncertainty
                  </div>
                  <div className="mt-1 flex items-end justify-between">
                    <span className="font-mono text-lg text-slate-200">
                      {percent(result.spatial.semanticUncertainty)}
                    </span>
                    <ArrowRight className="mb-1 h-3.5 w-3.5 text-slate-600" />
                  </div>
                </div>
                <div className="rounded-xl border border-white/10 bg-[#07111b]/90 p-3 shadow-xl backdrop-blur-xl">
                  <div className="text-[11px] uppercase tracking-wider text-slate-600">
                    Geometry uncertainty
                  </div>
                  <div className="mt-1 flex items-end justify-between">
                    <span className="font-mono text-lg text-slate-200">
                      {percent(result.spatial.geometricUncertainty)}
                    </span>
                    <span className="text-[10px] text-cyan-300">ADAPTIVE</span>
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>
      </section>
    </main>
  );
}

function Metric({
  label,
  value,
  suffix,
}: {
  label: string;
  value: string;
  suffix?: string;
}) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.025] px-3 py-3">
      <div className="text-[11px] text-slate-600">{label}</div>
      <div className="mt-1 font-mono text-base font-medium text-slate-200">
        {value}
        <span className="ml-1 text-xs text-slate-600">{suffix}</span>
      </div>
    </div>
  );
}

function PanelTab({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative flex items-center gap-2 px-4 py-3.5 text-sm transition ${
        active ? "text-cyan-200" : "text-slate-500 hover:text-slate-300"
      }`}
    >
      <Icon className="h-4 w-4" /> {children}
      {active && (
        <span className="absolute inset-x-3 bottom-0 h-px bg-cyan-300" />
      )}
    </button>
  );
}
