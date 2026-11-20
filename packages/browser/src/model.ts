/** Browser contracts and lightweight reads shared by host and presentation. */
export { readBrowserOperationResult } from './browser-operation-result.js'
export type {
  BrowserDownloadChunk,
  BrowserDownloadCurrentOwner,
  BrowserDownloadReadOptions,
  BrowserDownloadReceipt,
  BrowserDownloadReference,
  BrowserDownloadSource,
} from './model/browser-download.js'
export {
  BROWSER_OPERATION_PHASES,
  narrowBrowserOperation,
  narrowBrowserReplayPlan,
} from './model/browser-operation.js'
export type {
  BrowserActivityState,
  BrowserOperation,
  BrowserOperationPhase,
  BrowserOperationStep,
  BrowserOperator,
  BrowserReplayPlan,
  BrowserReplayStep,
  BrowserReplayTarget,
} from './model/browser-operation.js'
export { BROWSER_OUTCOME_LIMITS, parseBrowserOutcomeCriteriaRequest } from './model/browser-outcome-criteria.js'
export type {
  BrowserOutcomeAssetRun,
  BrowserOutcomeConditionResult,
  BrowserOutcomeCriterion,
  BrowserOutcomeEvaluation,
  BrowserOutcomeFieldRunInput,
  BrowserOutcomeHumanFact,
  BrowserOutcomeRegistration,
  BrowserOutcomeStatus,
  BrowserRegisteredOutcomeCriterion,
} from './model/browser-outcome-criteria.js'
export {
  BROWSER_RESULT_INLINE_BYTES,
  BROWSER_RESULT_MAX_BYTES,
  BROWSER_RESULT_MAX_READ_BYTES,
} from './model/browser-result-artifact.js'
export type {
  BrowserResultArtifactChunk,
  BrowserResultArtifactReference,
  BrowserResultContext,
  BrowserResultReadOptions,
} from './model/browser-result-artifact.js'
export type { BrowserScopedSnapshot } from './model/browser-snapshot-query.js'
export type { BrowserStepEvidenceContent, BrowserStepEvidenceRead } from './model/browser-step-evidence.js'
export { BROWSER_STRUCTURED_LIMITS } from './model/browser-structured-output.js'
export type {
  BrowserStructuredDocument,
  BrowserStructuredFieldRequest,
  BrowserStructuredFieldSummary,
  BrowserStructuredOutputReceipt,
  BrowserStructuredOutputRequest,
  BrowserStructuredSource,
} from './model/browser-structured-output.js'
export {
  BROWSER_PNG_MAX_BASE64_CHARS,
  BROWSER_PNG_MAX_BYTES,
  BROWSER_PNG_MAX_DIMENSION,
  BROWSER_PNG_MAX_PIXELS,
} from './model/page.js'
export type {
  BrowserAnnotationMarker,
  BrowserElementRect,
  BrowserElementSelection,
  BrowserPageFrameFailure,
  BrowserPageNode,
  BrowserPageSnapshot,
  BrowserPng,
  BrowserScreenshotCapture,
  BrowserScriptRunReport,
} from './model/page.js'
