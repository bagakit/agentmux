/** Host page transport, document observation, selection and native input. */
export { browserCdpScopeRefusal, isBrowserCdpNativeInput } from './browser-cdp-scope.js'
export { discoverBrowserFrameDocuments, MAX_BROWSER_FRAME_DOCUMENTS } from './browser-frame-documents.js'
export { createBrowserPageDispatch, renderBrowserSnapshotText } from './browser-page-dispatch.js'
export type { BrowserPageContext } from './browser-page-dispatch.js'
export {
  PREPARE_POINTER_WITNESS_DECLARATION,
  PREPARE_TOUCH_WITNESS_DECLARATION,
} from './browser-page-input-scripts.js'
export {
  BROWSER_PAGE_DIALOG_ANSWERS,
  BROWSER_PAGE_MAIN_READS,
  describeBrowserPageDialog,
  installBrowserPageInterrupts,
  isBrowserPageDialogAnswer,
} from './browser-page-interrupts.js'
export type { BrowserPageInterrupts } from './browser-page-interrupts.js'
export { captureBrowserPageSnapshot } from './browser-page-snapshot.js'
export type { BrowserCdpSender, BrowserPageCapture } from './browser-page-snapshot.js'
export type { BrowserNativeInput, BrowserNetworkSession, BrowserPageTransport } from './browser-page-transport.js'
export { healRef, ledgerFromSnapshot } from './browser-ref-ledger.js'
export type { BrowserRefLedger } from './browser-ref-ledger.js'
export { resolveBrowserRef } from './browser-ref-resolve.js'
export { prepareBrowserScreenshot } from './browser-screenshot-options.js'
export type { BrowserScreenshotOptions } from './browser-screenshot-options.js'
export {
  readScreenshotViewport,
  SCREENSHOT_VIEWPORT_SCRIPT,
  screenshotSource,
} from './browser-screenshot-source.js'
export { BROWSER_SELECTION_LIMITS, sanitizeBrowserElementSelection } from './browser-selection.js'
export {
  BROWSER_SELECTION_WORLD_ID,
  buildBrowserAnnotationMarkerScript,
  buildBrowserElementContextDeclaration,
  buildBrowserElementSelectionScript,
  buildCancelBrowserAnnotationMarkerScript,
  buildCancelBrowserElementSelectionScript,
  buildSelectedBrowserElementExpression,
} from './browser-selection-script.js'
export { parseBrowserSnapshotQuery, projectBrowserSnapshot } from './browser-snapshot-query.js'
export {
  buildBrowserStructuredReadDeclaration,
  extractBrowserStructuredOutput,
  parseBrowserStructuredOutputDocument,
  parseBrowserStructuredOutputRequest,
} from './browser-structured-output.js'
export type { BrowserStructuredOutputContext } from './browser-structured-output.js'
export { resolveBrowserStructuredTarget } from './browser-structured-target.js'
