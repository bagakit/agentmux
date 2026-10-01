export const EXTERNAL_BROWSER_PROTOCOL = 1
export const MAX_BRIDGE_BYTES = 16 * 1024 * 1024

export function isShareUrl(value) {
  try {
    const url = new URL(value)
    return !url.username && !url.password && (url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  } catch { return false }
}

// Audited page-agent methods, not a domain wildcard. The public target describes
// this actual subset. CDP domain membership alone does not imply a tab-only effect.
// Contracts: https://chromedevtools.github.io/devtools-protocol/tot/ (method anchors).
export const EXTERNAL_CDP_METHODS = Object.freeze([
  'Accessibility.enable', 'Accessibility.disable', 'Accessibility.getFullAXTree',
  'Accessibility.getPartialAXTree', 'Accessibility.getRootAXNode', 'Accessibility.getChildAXNodes',
  'CSS.enable', 'CSS.disable', 'CSS.getComputedStyleForNode',
  'DOM.enable', 'DOM.disable', 'DOM.getDocument', 'DOM.describeNode', 'DOM.resolveNode',
  'DOM.querySelector', 'DOM.querySelectorAll', 'DOM.getBoxModel', 'DOM.getContentQuads',
  'DOM.getOuterHTML', 'DOM.focus', 'DOM.scrollIntoViewIfNeeded', 'DOM.setFileInputFiles',
  'DOM.setAttributeValue', 'DOM.removeAttribute', 'DOM.setNodeValue',
  'DOMSnapshot.captureSnapshot',
  'Fetch.enable', 'Fetch.disable', 'Fetch.continueRequest', 'Fetch.failRequest', 'Fetch.fulfillRequest',
  'Fetch.continueResponse', 'Fetch.getResponseBody',
  'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText',
  'Network.enable', 'Network.disable', 'Network.getResponseBody',
  'Page.enable', 'Page.disable', 'Page.getFrameTree', 'Page.getLayoutMetrics',
  'Page.createIsolatedWorld', 'Page.captureScreenshot', 'Page.navigate', 'Page.reload',
  'Page.getNavigationHistory', 'Page.navigateToHistoryEntry',
  'Runtime.enable', 'Runtime.disable', 'Runtime.evaluate', 'Runtime.callFunctionOn',
  'Runtime.getProperties', 'Runtime.releaseObject', 'Runtime.releaseObjectGroup',
  'Target.setAutoAttach'
])
const methods = new Set(EXTERNAL_CDP_METHODS)

/** The debugger permission is broad. The bridge only accepts commands scoped to its original tab. */
export function isTabScopedCommand(method, params = {}) {
  if (typeof method !== 'string' || !methods.has(method)) return false
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false
  if (method.startsWith('Target.')) {
    return method === 'Target.setAutoAttach' && params.autoAttach === true &&
      params.waitForDebuggerOnStart === false && params.flatten === true &&
      JSON.stringify(params.filter) === JSON.stringify([{ type: 'iframe', exclude: false }, { exclude: true }])
  }
  const stack = [params]
  let visited = 0
  while (stack.length) {
    if (++visited > 1000) return false
    const value = stack.pop()
    if (!value || typeof value !== 'object') continue
    for (const [key, child] of Object.entries(value)) {
      if (['targetId', 'browserContextId', 'windowId'].includes(key)) return false
      if (child && typeof child === 'object') stack.push(child)
    }
  }
  return method !== 'Page.navigate' || isShareUrl(params.url)
}

export const EXTERNAL_AUTO_ATTACH = {
  autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
  filter: [{ type: 'iframe', exclude: false }, { exclude: true }]
}
