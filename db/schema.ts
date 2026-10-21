import { index, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * One immutable-ish Agent run plus its evidence snapshot. JSON columns keep
 * the first version flexible while the frequently filtered fields stay
 * relational and indexed.
 */
export const agentCases = sqliteTable("agent_cases", {
  id: text("id").primaryKey(),
  inputText: text("input_text").notNull(),
  decision: text("decision").notNull(),
  confidence: real("confidence").notNull(),
  summary: text("summary").notNull(),
  selectedName: text("selected_name"),
  intentJson: text("intent_json").notNull(),
  toolPlanJson: text("tool_plan_json").notNull(),
  clarificationJson: text("clarification_json"),
  entityLinksJson: text("entity_links_json").notNull(),
  anchorJson: text("anchor_json"),
  candidatesJson: text("candidates_json").notNull(),
  candidateEvidenceJson: text("candidate_evidence_json").notNull(),
  selectedCandidateJson: text("selected_candidate_json"),
  relationsJson: text("relations_json").notNull(),
  spatialJson: text("spatial_json"),
  stepsJson: text("steps_json").notNull(),
  provenanceJson: text("provenance_json").notNull(),
  feedback: text("feedback"),
  feedbackNote: text("feedback_note"),
  expectedDecision: text("expected_decision"),
  expectedEntity: text("expected_entity"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => ({
  createdAtIdx: index("idx_agent_cases_created_at").on(table.createdAt),
  decisionIdx: index("idx_agent_cases_decision").on(table.decision),
  feedbackIdx: index("idx_agent_cases_feedback").on(table.feedback),
}));
