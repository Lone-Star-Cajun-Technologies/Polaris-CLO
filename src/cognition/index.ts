/**
 * Route-local cognition delta — public API.
 *
 * Exposes delta logic for POLARIS.md and SUMMARY.md updates, validation,
 * and seed-draft generation used by map update and Smart Docs ingest.
 */

export type {
  CognitionDeltaOptions,
  CognitionDeltaResult,
  CognitionUpdateReason,
} from "./route-cognition-delta.js";

export {
  applyRouteCognitionDelta,
  detectOperationalReasons,
  findNearestRoutePolarismd,
  isCognitionSkippedFolder,
  readRoutePolarismd,
} from "./route-cognition-delta.js";

export type {
  SummaryDeltaOptions,
  SummaryDeltaResult,
  SummaryDeltaReason,
  SummaryPrecedenceLevel,
} from "./summary-delta.js";

export {
  applySummaryDelta,
  detectSummaryReasons,
  detectPrecedenceLevel,
  findNearestSummarymd,
  detectMissingSummaries,
  isSummaryOversized,
  hasDoctrineBled,
  readSummarymd,
  SUMMARY_MAX_BYTES,
} from "./summary-delta.js";

export type {
  CognitionViolation,
  CognitionViolationType,
  CognitionValidationResult,
} from "./validate.js";

export {
  validateCognitionSurfaces,
  validateSummaryFile,
  getSummaryFileSize,
  looksLikePolarisChurn,
} from "./validate.js";
