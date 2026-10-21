import type {
  AgentToolPlan,
  Candidate,
  CandidateEvidence,
  ClarificationRequest,
  Decision,
  EntityLinkResult,
  KnowledgeRetrieval,
  RelationEvidence,
  ResolveResponse,
  S2Representation,
  SpatialIntent,
} from "./types";

export type CaseFeedback = "positive" | "negative";

export interface CaseRecord {
  id: string;
  inputText: string;
  decision: Decision;
  confidence: number;
  summary: string;
  selectedName: string | null;
  intent: SpatialIntent;
  toolPlan: AgentToolPlan[];
  knowledge: KnowledgeRetrieval;
  clarification: ClarificationRequest | null;
  entityLinks: EntityLinkResult[];
  anchor: Candidate | null;
  candidates: Candidate[];
  candidateEvidence: CandidateEvidence[];
  selectedCandidate: Candidate | null;
  relations: RelationEvidence[];
  spatial: S2Representation | null;
  steps: ResolveResponse["steps"];
  provenance: ResolveResponse["provenance"];
  feedback: CaseFeedback | null;
  feedbackNote: string | null;
  expectedDecision: Decision | null;
  expectedEntity: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CaseListItem {
  id: string;
  inputText: string;
  decision: Decision;
  confidence: number;
  selectedName: string | null;
  feedback: CaseFeedback | null;
  expectedDecision: Decision | null;
  expectedEntity: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CaseMetrics {
  total: number;
  resolved: number;
  coarse: number;
  abstain: number;
  needClarification: number;
  feedbackTotal: number;
  feedbackPositive: number;
  feedbackNegative: number;
  feedbackAccuracy: number | null;
  labeledTotal: number;
  labeledCorrect: number;
  labeledAccuracy: number | null;
}

export interface CaseListOptions {
  limit?: number;
  offset?: number;
  decision?: Decision;
  feedback?: CaseFeedback;
  search?: string;
}

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
}

export interface D1Like {
  prepare(query: string): D1Statement;
}

interface CaseRow {
  id: string;
  input_text: string;
  decision: Decision;
  confidence: number;
  summary: string;
  selected_name: string | null;
  intent_json: string;
  tool_plan_json: string;
  knowledge_json: string | null;
  clarification_json: string | null;
  entity_links_json: string;
  anchor_json: string | null;
  candidates_json: string;
  candidate_evidence_json: string;
  selected_candidate_json: string | null;
  relations_json: string;
  spatial_json: string | null;
  steps_json: string;
  provenance_json: string;
  feedback: CaseFeedback | null;
  feedback_note: string | null;
  expected_decision: Decision | null;
  expected_entity: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_COLUMNS = `id,input_text,decision,confidence,summary,selected_name,
  intent_json,tool_plan_json,knowledge_json,clarification_json,entity_links_json,anchor_json,
  candidates_json,candidate_evidence_json,selected_candidate_json,relations_json,
  spatial_json,steps_json,provenance_json,feedback,feedback_note,expected_decision,
  expected_entity,created_at,updated_at`;

type MemoryCaseHost = typeof globalThis & {
  __geolinkCaseMemory__?: Map<string, CaseRecord>;
};

// The local dev runtime may load route modules separately. Keep the fallback
// on globalThis so /api/resolve and /api/cases still share one server process.
const memoryHost = globalThis as MemoryCaseHost;
const memoryCases = memoryHost.__geolinkCaseMemory__ ?? (memoryHost.__geolinkCaseMemory__ = new Map<string, CaseRecord>());

function json(value: unknown) {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function fromResult(result: ResolveResponse, previous?: CaseRecord): CaseRecord {
  const now = new Date().toISOString();
  return {
    id: result.runId,
    inputText: result.inputText,
    decision: result.decision,
    confidence: result.confidence,
    summary: result.summary,
    selectedName: result.selectedCandidate?.name ?? null,
    intent: result.intent,
    toolPlan: result.toolPlan,
    knowledge: result.knowledge,
    clarification: result.clarification,
    entityLinks: result.entityLinks,
    anchor: result.anchor,
    candidates: result.candidates,
    candidateEvidence: result.candidateEvidence,
    selectedCandidate: result.selectedCandidate,
    relations: result.relations,
    spatial: result.spatial,
    steps: result.steps,
    provenance: result.provenance,
    feedback: previous?.feedback ?? null,
    feedbackNote: previous?.feedbackNote ?? null,
    expectedDecision: previous?.expectedDecision ?? null,
    expectedEntity: previous?.expectedEntity ?? null,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
}

function toRow(record: CaseRecord) {
  return [
    record.id,
    record.inputText,
    record.decision,
    record.confidence,
    record.summary,
    record.selectedName,
    json(record.intent),
    json(record.toolPlan),
    json(record.knowledge),
    json(record.clarification),
    json(record.entityLinks),
    json(record.anchor),
    json(record.candidates),
    json(record.candidateEvidence),
    json(record.selectedCandidate),
    json(record.relations),
    json(record.spatial),
    json(record.steps),
    json(record.provenance),
    record.feedback,
    record.feedbackNote,
    record.expectedDecision,
    record.expectedEntity,
    record.createdAt,
    record.updatedAt,
  ];
}

function fromRow(row: CaseRow): CaseRecord {
  return {
    id: row.id,
    inputText: row.input_text,
    decision: row.decision,
    confidence: Number(row.confidence),
    summary: row.summary,
    selectedName: row.selected_name,
    intent: parseJson(row.intent_json, { type: "AMBIGUOUS", target: null, anchors: [], adminHints: [], constraints: [], queryPlan: [], needsClarification: true }),
    toolPlan: parseJson<AgentToolPlan[]>(row.tool_plan_json, []),
    knowledge: parseJson<KnowledgeRetrieval>(row.knowledge_json, { mode: "local-graph-rag", query: "", corpusSize: 0, hits: [], note: "历史案例未记录知识图谱证据。" }),
    clarification: parseJson<ClarificationRequest | null>(row.clarification_json, null),
    entityLinks: parseJson<EntityLinkResult[]>(row.entity_links_json, []),
    anchor: parseJson<Candidate | null>(row.anchor_json, null),
    candidates: parseJson<Candidate[]>(row.candidates_json, []),
    candidateEvidence: parseJson<CandidateEvidence[]>(row.candidate_evidence_json, []),
    selectedCandidate: parseJson<Candidate | null>(row.selected_candidate_json, null),
    relations: parseJson<RelationEvidence[]>(row.relations_json, []),
    spatial: parseJson<S2Representation | null>(row.spatial_json, null),
    steps: parseJson<ResolveResponse["steps"]>(row.steps_json, []),
    provenance: parseJson<ResolveResponse["provenance"]>(row.provenance_json, {
      orchestrator: "LangGraph",
      graphVersion: "unknown",
      retrievalMode: "demo-fallback",
      llmMode: "disabled",
      knowledgeRag: { mode: "local-graph-rag", hitCount: 0 },
      coordinatePipeline: "unknown",
      generatedAt: row.created_at,
    }),
    feedback: row.feedback ?? null,
    feedbackNote: row.feedback_note ?? null,
    expectedDecision: row.expected_decision ?? null,
    expectedEntity: row.expected_entity ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listItem(record: CaseRecord): CaseListItem {
  return {
    id: record.id,
    inputText: record.inputText,
    decision: record.decision,
    confidence: record.confidence,
    selectedName: record.selectedName,
    feedback: record.feedback,
    expectedDecision: record.expectedDecision,
    expectedEntity: record.expectedEntity,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function emptyMetrics(): CaseMetrics {
  return {
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
}

function metricsFromRecords(records: CaseRecord[]): CaseMetrics {
  const metrics = emptyMetrics();
  metrics.total = records.length;
  for (const record of records) {
    if (record.decision === "RESOLVED") metrics.resolved += 1;
    if (record.decision === "COARSE") metrics.coarse += 1;
    if (record.decision === "ABSTAIN") metrics.abstain += 1;
    if (record.decision === "NEED_CLARIFICATION") metrics.needClarification += 1;
    if (record.feedback) metrics.feedbackTotal += 1;
    if (record.feedback === "positive") metrics.feedbackPositive += 1;
    if (record.feedback === "negative") metrics.feedbackNegative += 1;
    if (record.expectedDecision) {
      metrics.labeledTotal += 1;
      if (record.expectedDecision === record.decision && (!record.expectedEntity || record.expectedEntity === record.selectedName)) {
        metrics.labeledCorrect += 1;
      }
    }
  }
  metrics.feedbackAccuracy = metrics.feedbackTotal ? Number((metrics.feedbackPositive / metrics.feedbackTotal).toFixed(3)) : null;
  metrics.labeledAccuracy = metrics.labeledTotal ? Number((metrics.labeledCorrect / metrics.labeledTotal).toFixed(3)) : null;
  return metrics;
}

function matches(record: CaseRecord, options: CaseListOptions) {
  if (options.decision && record.decision !== options.decision) return false;
  if (options.feedback && record.feedback !== options.feedback) return false;
  if (options.search && !record.inputText.toLowerCase().includes(options.search.toLowerCase())) return false;
  return true;
}

export function createCaseRepository(db: D1Like | null) {
  let storageMode: "d1" | "memory-fallback" = db ? "d1" : "memory-fallback";

  return {
    get storage() { return storageMode; },

    async upsert(result: ResolveResponse): Promise<CaseRecord> {
      const previous = await this.get(result.runId);
      const record = fromResult(result, previous ?? undefined);
      if (!db) {
        memoryCases.set(record.id, record);
        return record;
      }
      const values = toRow(record);
      try {
        await db.prepare(`INSERT OR REPLACE INTO agent_cases (
          id,input_text,decision,confidence,summary,selected_name,intent_json,tool_plan_json,knowledge_json,
          clarification_json,entity_links_json,anchor_json,candidates_json,candidate_evidence_json,
          selected_candidate_json,relations_json,spatial_json,steps_json,provenance_json,feedback,
          feedback_note,expected_decision,expected_entity,created_at,updated_at
        ) VALUES (${values.map(() => "?").join(",")})`).bind(...values).run();
      } catch {
        storageMode = "memory-fallback";
        memoryCases.set(record.id, record);
      }
      return record;
    },

    async get(id: string): Promise<CaseRecord | null> {
      if (!db) return memoryCases.get(id) ?? null;
      try {
        const row = await db.prepare(`SELECT ${SELECT_COLUMNS} FROM agent_cases WHERE id = ? LIMIT 1`).bind(id).first<CaseRow>();
        return row ? fromRow(row) : null;
      } catch {
        storageMode = "memory-fallback";
        return memoryCases.get(id) ?? null;
      }
    },

    async list(options: CaseListOptions = {}): Promise<CaseListItem[]> {
      const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
      const offset = Math.max(0, Math.floor(options.offset ?? 0));
      if (!db) {
        return [...memoryCases.values()]
          .filter((record) => matches(record, options))
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .slice(offset, offset + limit)
          .map(listItem);
      }
      const where: string[] = [];
      const values: unknown[] = [];
      if (options.decision) { where.push("decision = ?"); values.push(options.decision); }
      if (options.feedback) { where.push("feedback = ?"); values.push(options.feedback); }
      if (options.search) { where.push("input_text LIKE ?"); values.push(`%${options.search}%`); }
      const query = `SELECT ${SELECT_COLUMNS} FROM agent_cases${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
      try {
        const rows = await db.prepare(query).bind(...values, limit, offset).all<CaseRow>();
        return rows.results.map(fromRow).map(listItem);
      } catch {
        storageMode = "memory-fallback";
        return [...memoryCases.values()]
          .filter((record) => matches(record, options))
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .slice(offset, offset + limit)
          .map(listItem);
      }
    },

    async metrics(): Promise<CaseMetrics> {
      if (!db) return metricsFromRecords([...memoryCases.values()]);
      try {
        const row = await db.prepare(`SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN decision = 'RESOLVED' THEN 1 ELSE 0 END), 0) AS resolved,
        COALESCE(SUM(CASE WHEN decision = 'COARSE' THEN 1 ELSE 0 END), 0) AS coarse,
        COALESCE(SUM(CASE WHEN decision = 'ABSTAIN' THEN 1 ELSE 0 END), 0) AS abstain,
        COALESCE(SUM(CASE WHEN decision = 'NEED_CLARIFICATION' THEN 1 ELSE 0 END), 0) AS need_clarification,
        COALESCE(SUM(CASE WHEN feedback IS NOT NULL THEN 1 ELSE 0 END), 0) AS feedback_total,
        COALESCE(SUM(CASE WHEN feedback = 'positive' THEN 1 ELSE 0 END), 0) AS feedback_positive,
        COALESCE(SUM(CASE WHEN feedback = 'negative' THEN 1 ELSE 0 END), 0) AS feedback_negative,
        COALESCE(SUM(CASE WHEN expected_decision IS NOT NULL THEN 1 ELSE 0 END), 0) AS labeled_total,
        COALESCE(SUM(CASE WHEN expected_decision IS NOT NULL AND decision = expected_decision
          AND (expected_entity IS NULL OR expected_entity = selected_name) THEN 1 ELSE 0 END), 0) AS labeled_correct
          FROM agent_cases`).first<Record<string, number>>();
        const metrics = emptyMetrics();
        if (!row) return metrics;
        metrics.total = Number(row.total ?? 0);
        metrics.resolved = Number(row.resolved ?? 0);
        metrics.coarse = Number(row.coarse ?? 0);
        metrics.abstain = Number(row.abstain ?? 0);
        metrics.needClarification = Number(row.need_clarification ?? 0);
        metrics.feedbackTotal = Number(row.feedback_total ?? 0);
        metrics.feedbackPositive = Number(row.feedback_positive ?? 0);
        metrics.feedbackNegative = Number(row.feedback_negative ?? 0);
        metrics.labeledTotal = Number(row.labeled_total ?? 0);
        metrics.labeledCorrect = Number(row.labeled_correct ?? 0);
        metrics.feedbackAccuracy = metrics.feedbackTotal ? Number((metrics.feedbackPositive / metrics.feedbackTotal).toFixed(3)) : null;
        metrics.labeledAccuracy = metrics.labeledTotal ? Number((metrics.labeledCorrect / metrics.labeledTotal).toFixed(3)) : null;
        return metrics;
      } catch {
        storageMode = "memory-fallback";
        return metricsFromRecords([...memoryCases.values()]);
      }
    },

    async setFeedback(id: string, feedback: CaseFeedback, note?: string): Promise<CaseRecord | null> {
      const existing = await this.get(id);
      if (!existing) return null;
      const updatedAt = new Date().toISOString();
      if (!db) {
        const updated = { ...existing, feedback, feedbackNote: note?.trim() || null, updatedAt };
        memoryCases.set(id, updated);
        return updated;
      }
      try {
        await db.prepare("UPDATE agent_cases SET feedback = ?, feedback_note = ?, updated_at = ? WHERE id = ?")
          .bind(feedback, note?.trim() || null, updatedAt, id).run();
        return this.get(id);
      } catch {
        storageMode = "memory-fallback";
        const updated = { ...existing, feedback, feedbackNote: note?.trim() || null, updatedAt };
        memoryCases.set(id, updated);
        return updated;
      }
    },

    async setAnnotation(id: string, expectedDecision: Decision | null, expectedEntity?: string | null): Promise<CaseRecord | null> {
      const existing = await this.get(id);
      if (!existing) return null;
      const updatedAt = new Date().toISOString();
      const entity = expectedEntity?.trim() || null;
      if (!db) {
        const updated = { ...existing, expectedDecision, expectedEntity: entity, updatedAt };
        memoryCases.set(id, updated);
        return updated;
      }
      try {
        await db.prepare("UPDATE agent_cases SET expected_decision = ?, expected_entity = ?, updated_at = ? WHERE id = ?")
          .bind(expectedDecision, entity, updatedAt, id).run();
        return this.get(id);
      } catch {
        storageMode = "memory-fallback";
        const updated = { ...existing, expectedDecision, expectedEntity: entity, updatedAt };
        memoryCases.set(id, updated);
        return updated;
      }
    },
  };
}
