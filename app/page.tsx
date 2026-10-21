import { AgentWorkspace } from "@/components/agent-workspace";
import type { ResolveResponse } from "@/lib/agent/types";

// Render the shell immediately; the Agent runs only after the user submits a
// query, so navigation to and from the dashboard never starts a hidden run.
const INITIAL_RESULT: ResolveResponse = {
  runId: "initial-placeholder",
  inputText: "",
  decision: "ABSTAIN",
  confidence: 0,
  summary: "工作台已就绪，请输入文本并点击“运行 Agent”。",
  intent: {
    type: "AMBIGUOUS",
    target: null,
    anchors: [],
    adminHints: [],
    constraints: [],
    queryPlan: [],
    needsClarification: true,
  },
  clarification: null,
  toolPlan: [],
  knowledge: {
    mode: "local-graph-rag",
    query: "",
    corpusSize: 0,
    hits: [],
    note: "等待用户输入后检索地理知识图谱。",
  },
  entityLinks: [],
  anchor: null,
  candidates: [],
  candidateEvidence: [],
  selectedCandidate: null,
  relations: [],
  spatial: null,
  steps: [],
  provenance: {
    orchestrator: "LangGraph",
    graphVersion: "initial-placeholder",
    retrievalMode: "demo-fallback",
    llmMode: "disabled",
    knowledgeRag: { mode: "local-graph-rag", hitCount: 0 },
    coordinatePipeline: "pending",
    generatedAt: new Date(0).toISOString(),
  },
};

export default async function Home() {
  return <AgentWorkspace initialResult={INITIAL_RESULT} />;
}
