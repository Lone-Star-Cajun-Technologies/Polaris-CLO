export { isPolarisDevContext, assertPolarisDevContext } from "./dev-gate.js";
export { scoreRun, loadRunArtifacts, computeScore, buildDiagnosisHints } from "./score.js";
export type { RunArtifacts, DiagnosisReport, DiagnosisHint } from "./score.js";
export { ALL_GATES } from "./gates.js";
export type { GateResult, GateOutcome } from "./gates.js";
export { FIX_ZONE_MAP, buildProposals, loadDiagnosisReport, validateDiagnosisReport } from "./proposal.js";
export type { ArtifactType, AutresearchProposal, FixZoneEntry } from "./proposal.js";
export { routeProposals } from "./routing.js";
export type { ProposalIssueResult, RouteProposalsResult, RouteProposalsOptions } from "./routing.js";
export { aggregateSolEvidence } from "./sol-evidence-loader.js";
export { computeForemanScore, computeWorkerScore, computeSolScoreReport } from "./sol-scorer.js";
export type {
  SolDimensionScore,
  SolForemanScoreReport,
  SolWorkerScoreReport,
  SolScoreReport,
  SolScoreConfidence,
} from "../types/sol-score.js";
