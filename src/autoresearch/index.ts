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
export {
  computeForemanScorecard,
  computeWorkerScorecard,
  computeProviderScorecard,
  computeModelScorecard,
  computeRoutingScorecard,
  computeAllScorecards,
  buildForemanRawMetrics,
  buildWorkerRawMetrics,
  buildProviderRawMetrics,
  buildModelRawMetrics,
  buildRoutingRawMetrics,
} from "./sol-scorecard-calculator.js";
export type { SolScorecardSet } from "./sol-scorecard-calculator.js";
export { appendSnapshot, loadSnapshots, buildSnapshot, getHistoryFilePath } from "./sol-history.js";
export type { SolScoreSnapshot } from "./sol-history.js";
export { generateReport, formatReportCli } from "./sol-report.js";
export type { SolReport, SolGroupSummary, SolReportGroupBy, SolReportOptions } from "./sol-report.js";
export {
  buildEvaluationRecord,
  writeEvaluationRecord,
  writeScorecard,
  writeScorecardSet,
  writeSolMarkdownReport,
  getSolEvaluationsDir,
  getSolScorecardsDir,
  getSolReportsDir,
  getEvaluationRecordPath,
  getScorecardPath,
  getSolMarkdownReportPath,
} from "./sol-evaluation-writer.js";
export type { SolEvaluationRecord } from "./sol-evaluation-writer.js";
export { renderSolMarkdown } from "./sol-report-renderer.js";
export type { SolRenderedReport } from "./sol-report-renderer.js";
export {
  generateRecommendations,
  recommendationsToProposals,
  recommendationToProposal,
  formatRecommendationsCli,
  scorecardToRecommendationSummary,
  scorecardsToRecommendationSummaries,
} from "./sol-recommendations.js";
export type {
  SolRecommendation,
  RecommendationAffected,
  RecommendationEvidence,
  RecommendationOptions,
  RecommendationsReport,
  ScorecardVerdict,
  QualityPerTokenEvidence,
  ScorecardQcEvidence,
  ScorecardValidationEvidence,
  ScorecardRecommendationSummary,
} from "./sol-recommendations.js";
export type {
  SolDimensionScore,
  SolForemanScoreReport,
  SolWorkerScoreReport,
  SolScoreReport,
  SolScoreConfidence,
} from "../types/sol-score.js";
