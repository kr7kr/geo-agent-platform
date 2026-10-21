export type Decision = "RESOLVED" | "COARSE" | "ABSTAIN" | "NEED_CLARIFICATION";

export type AgentStepStatus = "complete" | "skipped" | "warning";

export interface AgentStep {
  id: string;
  label: string;
  tool: string;
  status: AgentStepStatus;
  durationMs: number;
  summary: string;
  details?: string[];
}

/** A safe follow-up request emitted when semantic entity linking remains ambiguous. */
export interface ClarificationRequest {
  question: string;
  options: string[];
  reason: string;
}

/** An auditable, key-free plan for the tools the graph intends to call. */
export type AgentToolStage = "knowledge" | "link" | "anchor" | "target" | "around" | "verify" | "spatial";

export interface AgentToolPlan {
  id: string;
  label: string;
  stage: AgentToolStage;
  reason: string;
  query?: string;
  region?: string | null;
  radiusMeters?: number;
  dependsOn?: string[];
}

export type RelationPredicate = "NEAR" | "DIRECTIONAL" | "WITHIN" | "ADDRESS_MATCH" | "AT" | "UNKNOWN";

export interface RelationEvidence {
  predicate: RelationPredicate;
  value: string;
  confidence: number;
}

export type IntentType = "DIRECT_POI" | "ANCHOR_TARGET" | "ADDRESS" | "RELATIONAL" | "AMBIGUOUS";
export type EntityRole = "target" | "anchor";
export type EntityType = "university" | "hospital" | "station" | "landmark" | "commercial_area" | "organization" | "unknown";
export type EntityLinkStatus = "LINKED" | "AMBIGUOUS" | "UNLINKED";
export type AliasSource = "curated" | "knowledge_graph" | "generated" | "llm" | "provider";

export interface TargetEntity {
  name: string;
  brand?: string;
  category?: string;
  branchQualifier?: string;
  originalMention?: string;
  entityType?: EntityType;
  entityLinkScore?: number;
}

export interface SpatialAnchor {
  name: string;
  relation: "NEAR" | "WITHIN" | "DIRECTIONAL" | "AT";
  distanceMeters?: number;
  direction?: string;
  originalMention?: string;
  entityType?: EntityType;
  entityLinkScore?: number;
}

export interface AdministrativeHint {
  name: string;
  level: "province" | "city" | "district" | "business_area";
  status: "explicit" | "inferred" | "verified";
}

export interface SpatialConstraint {
  kind: "distance" | "direction" | "within" | "address";
  value: string;
  distanceMeters?: number;
  direction?: string;
}

export interface QueryPlan {
  stage: "anchor" | "target" | "around" | "rewrite";
  query: string;
  region: string | null;
  radiusMeters?: number;
  reason: string;
}

export interface SpatialIntent {
  type: IntentType;
  target: TargetEntity | null;
  anchors: SpatialAnchor[];
  adminHints: AdministrativeHint[];
  constraints: SpatialConstraint[];
  queryPlan: QueryPlan[];
  needsClarification: boolean;
}

export interface CanonicalEntityCandidate {
  canonicalName: string;
  queryName: string;
  aliases: string[];
  entityType: EntityType;
  city?: string;
  district?: string;
  aliasScore: number;
  source: AliasSource;
  evidence: string[];
}

// LLM output is intentionally a proposal, never a verified geographic fact.
// It is converted into a search query and must be corroborated by provider POIs.
export interface LlmEntityLinkHint {
  role: EntityRole;
  mention: string;
  candidates: Array<{
    canonicalName: string;
    queryName?: string;
    entityType: EntityType;
    city?: string;
    district?: string;
    confidence: number;
    rationale: string;
  }>;
}

export interface EntityLinkResult {
  role: EntityRole;
  mention: string;
  status: EntityLinkStatus;
  candidates: CanonicalEntityCandidate[];
  selectedCanonicalName?: string;
  evidence: string[];
}

/**
 * Read-only evidence retrieved from the local geographic knowledge graph.
 * These are query-expansion priors, never coordinates or verified POIs.
 */
export interface KnowledgeGraphHit {
  nodeId: string;
  canonicalName: string;
  aliases: string[];
  entityType: EntityType;
  city?: string;
  district?: string;
  score: number;
  matchedTerms: string[];
  facts: string[];
  relations: string[];
  source: "seed-graph";
}

export interface KnowledgeRetrieval {
  mode: "local-graph-rag";
  query: string;
  corpusSize: number;
  hits: KnowledgeGraphHit[];
  note: string;
}

export interface CandidateScores {
  retrievalScore: number;
  entityLinkScore: number;
  nameScore: number;
  branchScore: number;
  adminScore: number;
  spatialScore: number;
  sourceScore: number;
  decisionConfidence: number;
}

export interface CandidateEvidence {
  candidateId: string;
  verdict: "kept" | "rejected";
  reasons: string[];
}

export interface Candidate {
  id: string;
  name: string;
  address: string;
  category: string;
  source: "amap" | "demo-index";
  sourceRank: number;
  retrieval?: {
    operation: "text" | "around" | "demo";
    query: string;
    region?: string | null;
    radiusMeters?: number;
    sourceRank: number;
    rawDistanceMeters?: number;
  };
  location: [number, number];
  originalLocation?: [number, number];
  crs: "WGS84";
  sourceCrs?: "GCJ-02" | "WGS84";
  coordinateAccuracyMeters?: number;
  distanceMeters?: number;
  geometryOrigin?: "source-poi" | "relation-inference";
  derivedFromId?: string;
  uncertaintyRadiusMeters?: number;
  score: number;
  scores?: CandidateScores;
  evidence: string[];
}

export interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: {
      type: "Polygon";
      coordinates: number[][][];
    };
    properties: Record<string, string | number | boolean | null>;
  }>;
}

export interface S2Representation {
  system: "S2";
  level: number;
  cellIds: string[];
  cellCount: number;
  method: string;
  coverageNote?: string;
  semanticUncertainty: number;
  geometricUncertainty: number;
  combinedUncertainty: number;
  geojson: GeoJsonFeatureCollection;
}

export interface ResolveResponse {
  runId: string;
  inputText: string;
  decision: Decision;
  confidence: number;
  summary: string;
  intent: SpatialIntent;
  clarification: ClarificationRequest | null;
  toolPlan: AgentToolPlan[];
  knowledge: KnowledgeRetrieval;
  entityLinks: EntityLinkResult[];
  anchor: Candidate | null;
  candidates: Candidate[];
  candidateEvidence: CandidateEvidence[];
  selectedCandidate: Candidate | null;
  relations: RelationEvidence[];
  spatial: S2Representation | null;
  steps: AgentStep[];
  provenance: {
    orchestrator: "LangGraph";
    graphVersion: string;
    retrievalMode: "amap-online" | "demo-fallback";
    llmMode: "disabled" | "local" | "cloud" | "fallback";
    knowledgeRag: { mode: "local-graph-rag"; hitCount: number };
    coordinatePipeline: string;
    generatedAt: string;
  };
}
