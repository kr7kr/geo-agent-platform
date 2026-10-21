CREATE TABLE `agent_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`input_text` text NOT NULL,
	`decision` text NOT NULL,
	`confidence` real NOT NULL,
	`summary` text NOT NULL,
	`selected_name` text,
	`intent_json` text NOT NULL,
	`tool_plan_json` text NOT NULL,
	`clarification_json` text,
	`entity_links_json` text NOT NULL,
	`anchor_json` text,
	`candidates_json` text NOT NULL,
	`candidate_evidence_json` text NOT NULL,
	`selected_candidate_json` text,
	`relations_json` text NOT NULL,
	`spatial_json` text,
	`steps_json` text NOT NULL,
	`provenance_json` text NOT NULL,
	`feedback` text,
	`feedback_note` text,
	`expected_decision` text,
	`expected_entity` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_agent_cases_created_at` ON `agent_cases` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_cases_decision` ON `agent_cases` (`decision`);--> statement-breakpoint
CREATE INDEX `idx_agent_cases_feedback` ON `agent_cases` (`feedback`);