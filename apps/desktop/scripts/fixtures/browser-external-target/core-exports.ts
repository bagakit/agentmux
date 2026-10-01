// Existing desktop contracts use the installed Core declarations. The owning browser
// implementation and new DTO below resolve the actual Source leaves, without compiling
// unrelated Provider/Runtime implementations into this slice's check.
export type * from '../../../../../packages/core/dist/index.js'
export type { AgentMuxControlError, AgentMuxControlErrorCode, AgentMuxControlBrowserRunOutcome,
  AgentMuxControlBrowserOperation, AgentMuxControlRequest, AgentMuxControlResult,
  AgentMuxControlCrashLogFact } from '../../../../../packages/core/src/control.js'
export { BROWSER_PAGE_CAPABILITIES, BROWSER_PAGE_CAPABILITY_NAMES, BROWSER_PAGE_MUTATING_CAPABILITY_NAMES,
  browserPageCapabilityNames } from '../../../../../packages/core/src/browser-page-capability.js'
export type { BrowserPageCapability, BrowserPageCapabilityEffect } from '../../../../../packages/core/src/browser-page-capability.js'
export { durableWriteFile } from '../../../../../packages/core/src/durable-write.js'
export type { AgentMuxBrowserTarget, AgentMuxExternalBrowserPairing } from '../../../../../packages/core/src/browser-targets.js'
export type { BrowserTaskControlPayload, BrowserTaskControlResult } from '../../../../../packages/core/src/browser-task-control.js'
