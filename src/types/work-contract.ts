export type WorkSourceType = "linear" | "local";

export interface WorkSource {
  type: WorkSourceType;
  id: string;
  path: string;
  url: string;
}

export interface WorkContract {
  source: WorkSource;
  objective: string;
  acceptance_criteria: string[];
  allowed_scope: string[];
  validation_commands: string[];
  linked_docs: string[];
  evidence_requirements: string[];
  children: WorkContract[];
}
