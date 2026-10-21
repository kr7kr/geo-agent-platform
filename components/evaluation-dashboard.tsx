"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, CircleAlert, Database, Filter, RefreshCw, Search, ThumbsDown, ThumbsUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CaseFeedback, CaseListItem, CaseMetrics, CaseRecord } from "@/lib/agent/case-library";
import type { Decision } from "@/lib/agent/types";

const DECISIONS: Array<Decision | "ALL"> = ["ALL", "RESOLVED", "COARSE", "ABSTAIN", "NEED_CLARIFICATION"];

const decisionLabels: Record<Decision, string> = {
  RESOLVED: "精确定位",
  COARSE: "范围推断",
  ABSTAIN: "主动拒答",
  NEED_CLARIFICATION: "需要澄清",
};

const decisionClasses: Record<Decision, string> = {
  RESOLVED: "border-emerald-300/25 bg-emerald-300/10 text-emerald-200",
  COARSE: "border-amber-300/25 bg-amber-300/10 text-amber-200",
  ABSTAIN: "border-rose-300/25 bg-rose-300/10 text-rose-200",
  NEED_CLARIFICATION: "border-violet-300/25 bg-violet-300/10 text-violet-200",
};

const emptyMetrics: CaseMetrics = {
  total: 0,
  resolved: 0,
  coarse: 0,
  abstain: 0,
  needClarification: 0,
  feedbackTotal: 0,
  feedbackPositive: 0,
  feedbackNegative: 0,
  feedbackAccuracy: null,
  labeledTotal: 0,
  labeledCorrect: 0,
  labeledAccuracy: null,
};

function percent(value: number | null) {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function formatTime(value: string) {
  try {
    return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  } catch {
    return value;
  }
}

function DecisionBadge({ decision }: { decision: Decision }) {
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${decisionClasses[decision]}`}>{decisionLabels[decision]}</span>;
}

export function EvaluationDashboard() {
  const [cases, setCases] = useState<CaseListItem[]>([]);
  const [metrics, setMetrics] = useState<CaseMetrics>(emptyMetrics);
  const [storage, setStorage] = useState<"d1" | "memory-fallback">("memory-fallback");
  const [decisionFilter, setDecisionFilter] = useState<Decision | "ALL">("ALL");
  const [feedbackFilter, setFeedbackFilter] = useState<CaseFeedback | "ALL">("ALL");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CaseRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadCases = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ limit: "100" });
    if (decisionFilter !== "ALL") params.set("decision", decisionFilter);
    if (feedbackFilter !== "ALL") params.set("feedback", feedbackFilter);
    if (search.trim()) params.set("search", search.trim());
    try {
      const response = await fetch(`/api/cases?${params.toString()}`, { cache: "no-store" });
      const payload = await response.json() as { cases?: CaseListItem[]; metrics?: CaseMetrics; storage?: "d1" | "memory-fallback"; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "案例库加载失败");
      setCases(payload.cases ?? []);
      setMetrics(payload.metrics ?? emptyMetrics);
      setStorage(payload.storage ?? "memory-fallback");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "案例库加载失败");
    } finally {
      setLoading(false);
    }
  }, [decisionFilter, feedbackFilter, search]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadCases(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadCases]);

  const loadDetail = useCallback(async (id: string) => {
    setSelectedId(id);
    setDetailLoading(true);
    try {
      const response = await fetch(`/api/cases?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      const payload = await response.json() as { case?: CaseRecord; error?: string };
      if (!response.ok || !payload.case) throw new Error(payload.error ?? "案例详情加载失败");
      setDetail(payload.case);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "案例详情加载失败");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  async function saveFeedback(value: CaseFeedback) {
    if (!detail) return;
    const response = await fetch("/api/cases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caseId: detail.id, feedback: value }),
    });
    const payload = await response.json() as { case?: CaseRecord; error?: string };
    if (!response.ok || !payload.case) {
      setError(payload.error ?? "反馈保存失败");
      return;
    }
    setDetail(payload.case);
    await loadCases();
  }

  const distribution = useMemo(() => [
    { label: "RESOLVED", value: metrics.resolved, color: "bg-emerald-300" },
    { label: "COARSE", value: metrics.coarse, color: "bg-amber-300" },
    { label: "ABSTAIN", value: metrics.abstain, color: "bg-rose-300" },
    { label: "CLARIFICATION", value: metrics.needClarification, color: "bg-violet-300" },
  ], [metrics]);

  return (
    <main className="min-h-screen bg-[#050b12] text-slate-100">
      <header className="border-b border-white/[0.07] bg-[#07111b]/95">
        <div className="mx-auto flex min-h-16 max-w-[1680px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <Link href="/" className="grid h-9 w-9 place-items-center rounded-xl border border-white/[0.08] text-slate-400 transition hover:border-cyan-300/30 hover:text-cyan-200" aria-label="返回空间工作台"><ArrowLeft className="h-4 w-4" /></Link>
            <div>
              <div className="flex items-center gap-2"><span className="font-semibold tracking-tight">GeoLink</span><span className="text-xs font-medium text-cyan-300/80">EVALUATION</span></div>
              <p className="text-xs text-slate-500">案例库与 Agent 决策质量</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-500"><Database className="h-3.5 w-3.5 text-cyan-300" />{storage === "d1" ? "D1 持久化" : "本地服务端降级"}</div>
        </div>
      </header>

      <section className="mx-auto max-w-[1680px] space-y-5 px-4 py-6 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div><p className="text-xs uppercase tracking-[0.16em] text-cyan-300/70">Agent quality loop</p><h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">评测仪表盘</h1><p className="mt-2 text-sm text-slate-500">每次解析都会保存结构化意图、工具计划、证据、轨迹和人工反馈。</p></div>
          <Button type="button" variant="outline" onClick={() => void loadCases()} disabled={loading} className="border-white/[0.1] bg-white/[0.03] text-slate-300 hover:bg-white/[0.07]"><RefreshCw className={loading ? "animate-spin" : ""} />刷新案例</Button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <Metric label="案例总数" value={`${metrics.total}`} hint="服务端记录" />
          <Metric label="精确定位" value={`${metrics.resolved}`} hint={metrics.total ? percent(metrics.resolved / metrics.total) : "—"} tone="emerald" />
          <Metric label="主动拒答" value={`${metrics.abstain}`} hint={metrics.total ? percent(metrics.abstain / metrics.total) : "—"} tone="rose" />
          <Metric label="反馈覆盖" value={`${metrics.feedbackTotal}`} hint={metrics.feedbackAccuracy === null ? "尚无反馈" : `正向率 ${percent(metrics.feedbackAccuracy)}`} tone="cyan" />
          <Metric label="标注准确率" value={percent(metrics.labeledAccuracy)} hint={`${metrics.labeledTotal} 个已标注案例`} tone="violet" />
        </div>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(380px,0.62fr)]">
          <section className="overflow-hidden rounded-2xl border border-white/[0.08] bg-[#09141f]">
            <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.07] p-4">
              <div className="flex min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-white/[0.08] bg-[#07111b] px-3"><Search className="h-4 w-4 text-slate-600" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索输入文本" className="h-10 min-w-0 flex-1 bg-transparent text-sm text-slate-200 outline-none placeholder:text-slate-600" /></div>
              <div className="flex items-center gap-2 text-xs text-slate-500"><Filter className="h-3.5 w-3.5" /><select value={decisionFilter} onChange={(event) => setDecisionFilter(event.target.value as Decision | "ALL")} className="rounded-lg border border-white/[0.08] bg-[#07111b] px-3 py-2 text-slate-300 outline-none"><option value="ALL">全部决策</option>{DECISIONS.filter((item): item is Decision => item !== "ALL").map((item) => <option key={item} value={item}>{decisionLabels[item]}</option>)}</select><select value={feedbackFilter} onChange={(event) => setFeedbackFilter(event.target.value as CaseFeedback | "ALL")} className="rounded-lg border border-white/[0.08] bg-[#07111b] px-3 py-2 text-slate-300 outline-none"><option value="ALL">全部反馈</option><option value="positive">已确认</option><option value="negative">需修正</option></select></div>
            </div>
            {error && <div className="m-4 flex items-center gap-2 rounded-lg border border-rose-300/20 bg-rose-300/[0.06] px-3 py-2 text-sm text-rose-200"><CircleAlert className="h-4 w-4" />{error}</div>}
            <div className="divide-y divide-white/[0.06]">
              {loading ? <div className="p-8 text-center text-sm text-slate-500">正在加载案例库…</div> : cases.length ? cases.map((item) => <CaseRow key={item.id} item={item} selected={item.id === selectedId} onClick={() => void loadDetail(item.id)} />) : <div className="p-12 text-center text-sm text-slate-500">还没有符合筛选条件的案例。回到工作台运行一次解析即可生成。</div>}
            </div>
          </section>

          <aside className="space-y-5">
            <section className="rounded-2xl border border-white/[0.08] bg-[#09141f] p-5"><div className="flex items-center justify-between"><h2 className="font-medium text-slate-200">决策分布</h2><span className="text-xs text-slate-600">{metrics.total} runs</span></div><div className="mt-5 space-y-3">{distribution.map((item) => <div key={item.label}><div className="flex justify-between text-xs text-slate-500"><span>{item.label}</span><span>{item.value}</span></div><div className="mt-1 h-2 overflow-hidden rounded-full bg-white/[0.06]"><div className={`h-full ${item.color}`} style={{ width: `${metrics.total ? (item.value / metrics.total) * 100 : 0}%` }} /></div></div>)}</div></section>
            <DetailPanel detail={detail} loading={detailLoading} onFeedback={saveFeedback} />
          </aside>
        </div>
      </section>
    </main>
  );
}

function Metric({ label, value, hint, tone = "slate" }: { label: string; value: string; hint: string; tone?: "slate" | "emerald" | "rose" | "cyan" | "violet" }) {
  const colors = { slate: "text-slate-200", emerald: "text-emerald-200", rose: "text-rose-200", cyan: "text-cyan-200", violet: "text-violet-200" };
  return <div className="rounded-xl border border-white/[0.07] bg-[#09141f] px-4 py-4"><div className="text-xs text-slate-600">{label}</div><div className={`mt-2 font-mono text-2xl font-semibold ${colors[tone]}`}>{value}</div><div className="mt-1 text-xs text-slate-600">{hint}</div></div>;
}

function CaseRow({ item, selected, onClick }: { item: CaseListItem; selected: boolean; onClick: () => void }) {
  return <button type="button" onClick={onClick} className={`flex w-full items-start gap-4 px-4 py-4 text-left transition hover:bg-white/[0.035] ${selected ? "bg-cyan-300/[0.06]" : ""}`}><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="truncate font-medium text-slate-200">{item.inputText}</span><DecisionBadge decision={item.decision} />{item.feedback === "positive" && <ThumbsUp className="h-3.5 w-3.5 text-emerald-300" />}{item.feedback === "negative" && <ThumbsDown className="h-3.5 w-3.5 text-rose-300" />}</div><div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600"><span>{item.selectedName ?? "未选择候选"}</span><span>决策分数 {Math.round(item.confidence * 100)}%</span><span>{formatTime(item.createdAt)}</span></div></div><span className="font-mono text-xs text-slate-600">{item.id.slice(0, 8).toUpperCase()}</span></button>;
}

function DetailPanel({ detail, loading, onFeedback }: { detail: CaseRecord | null; loading: boolean; onFeedback: (value: CaseFeedback) => Promise<void> }) {
  if (loading) return <section className="rounded-2xl border border-white/[0.08] bg-[#09141f] p-5 text-sm text-slate-500">正在读取案例详情…</section>;
  if (!detail) return <section className="rounded-2xl border border-dashed border-white/[0.1] bg-[#09141f] p-5 text-sm leading-6 text-slate-500">选择左侧案例查看完整证据、工具调用和 Agent 轨迹。</section>;
  const graphHits = detail.knowledge?.hits ?? [];
  return <section className="rounded-2xl border border-white/[0.08] bg-[#09141f] p-5"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="truncate font-medium text-slate-200">{detail.inputText}</h2><p className="mt-1 text-xs text-slate-600">{formatTime(detail.createdAt)} · {detail.provenance.graphVersion}</p></div><DecisionBadge decision={detail.decision} /></div><div className="mt-4 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 text-sm leading-6 text-slate-400">{detail.summary}</div><div className="mt-4 grid grid-cols-2 gap-2 text-xs"><div className="rounded-lg border border-white/[0.06] p-3"><div className="text-slate-600">决策分数</div><div className="mt-1 font-mono text-lg text-cyan-200">{Math.round(detail.confidence * 100)}%</div></div><div className="rounded-lg border border-white/[0.06] p-3"><div className="text-slate-600">候选数</div><div className="mt-1 font-mono text-lg text-slate-200">{detail.candidates.length}</div></div></div><div className="mt-4 space-y-2 text-xs text-slate-500"><p>目标：<span className="text-slate-300">{detail.intent.target?.name ?? "未识别"}</span></p><p>锚点：<span className="text-slate-300">{detail.anchor?.name ?? detail.intent.anchors[0]?.name ?? "无"}</span></p><p>工具：<span className="text-slate-300">{detail.toolPlan.map((tool) => tool.label).join(" → ") || "无"}</span></p></div><div className="mt-4 rounded-xl border border-cyan-300/10 bg-cyan-300/[0.025] p-3"><div className="text-xs font-medium text-cyan-200">地理知识图谱 RAG</div><p className="mt-1 text-xs leading-5 text-slate-500">{graphHits.length ? `召回 ${graphHits.length} 条非坐标知识证据；最终位置仍由 POI 工具和证据裁判验证。` : detail.knowledge?.note ?? "本次未命中图谱证据。"}</p>{graphHits.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{graphHits.map((hit) => <span key={hit.nodeId} title={[...hit.facts, ...hit.relations].join("；")} className="rounded-md border border-cyan-300/15 bg-cyan-300/[0.06] px-2 py-1 text-xs text-cyan-100">{hit.canonicalName} · {Math.round(hit.score * 100)}%</span>)}</div>}</div><div className="mt-4 border-t border-white/[0.06] pt-4"><div className="text-xs text-slate-600">人工反馈</div><div className="mt-2 flex gap-2"><button type="button" onClick={() => void onFeedback("positive")} className={`rounded-lg border px-3 py-2 text-xs transition ${detail.feedback === "positive" ? "border-emerald-300/40 bg-emerald-300/10 text-emerald-200" : "border-white/[0.08] text-slate-400 hover:border-emerald-300/30 hover:text-emerald-200"}`}><Check className="mr-1 inline h-3.5 w-3.5" />结果正确</button><button type="button" onClick={() => void onFeedback("negative")} className={`rounded-lg border px-3 py-2 text-xs transition ${detail.feedback === "negative" ? "border-rose-300/40 bg-rose-300/10 text-rose-200" : "border-white/[0.08] text-slate-400 hover:border-rose-300/30 hover:text-rose-200"}`}><ThumbsDown className="mr-1 inline h-3.5 w-3.5" />需要修正</button></div></div><div className="mt-4 border-t border-white/[0.06] pt-4"><div className="text-xs text-slate-600">轨迹摘要</div><div className="mt-2 max-h-52 space-y-2 overflow-y-auto">{detail.steps.map((step) => <div key={`${step.id}-${step.durationMs}`} className="rounded-lg bg-white/[0.025] p-2.5"><div className="flex justify-between gap-2 text-xs text-slate-300"><span>{step.label}</span><span className="font-mono text-slate-600">{step.durationMs} ms</span></div><p className="mt-1 text-xs leading-5 text-slate-600">{step.summary}</p></div>)}</div></div></section>;
}
