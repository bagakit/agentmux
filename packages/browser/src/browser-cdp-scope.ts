/**
 * Which raw CDP commands stay inside the page an Agent program drives.
 *
 * `cdp(method, params)` is the escape hatch for browser abilities the page library does not wrap yet,
 * so it stays open: every command is forwarded as is, except the few whose effect reaches past this
 * page. Those would read or wipe the Profile's sign-ins, weaken certificate checks, grant
 * permissions, bypass the download owner, or open, close and attach pages outside the Browser owner,
 * all without the person who owns the Profile deciding. They are refused before anything is sent,
 * with the ability to use instead.
 *
 * This is a deny list on purpose. An allow list would turn the escape hatch into one more fixed
 * verb list and take away its reason to exist. The rules match a method exactly or a whole domain,
 * never by substring, so a new page-scoped method is not refused by accident.
 */

export type BrowserCdpScopeRefusal = { reason: string; instead: string }

const PROFILE_DATA: BrowserCdpScopeRefusal = {
  reason: 'reads or changes the sign-ins and site data of the whole Profile',
  instead: 'Read what this page shows with snapshot() or js(). Clearing a site’s data is a person’s decision in Settings › Browser Profiles.'
}
const SECURITY: BrowserCdpScopeRefusal = {
  reason: 'changes certificate checks or permissions for the whole Profile',
  instead: 'A certificate error or a permission request is answered by the person in the Browser.'
}
const OUTSIDE_PAGE: BrowserCdpScopeRefusal = {
  reason: 'opens, closes or attaches pages and windows outside this Browser',
  instead: 'Open another page with `amux browser open`, and drive it with its own `amux browser run`.'
}
const BROWSER_PROCESS: BrowserCdpScopeRefusal = {
  reason: 'acts on the browser process, not this page',
  instead: 'Nothing in a page program needs this; use the page functions instead.'
}
const DOWNLOADS: BrowserCdpScopeRefusal = {
  reason: 'changes where and how downloads are saved',
  instead: 'Use download(ref, {path}) so the file lands in the Workspace with a receipt.'
}

/** Whole domains whose every method reaches past the page. */
const DOMAINS: Readonly<Record<string, BrowserCdpScopeRefusal>> = {
  Storage: PROFILE_DATA,
  Security: SECURITY,
  Browser: BROWSER_PROCESS,
  SystemInfo: BROWSER_PROCESS,
  Tethering: BROWSER_PROCESS,
  Extensions: BROWSER_PROCESS
}

/** Single methods in otherwise page-scoped domains. */
const METHODS: Readonly<Record<string, BrowserCdpScopeRefusal>> = {
  // Host files cross the page boundary. The original upload owner alone validates Workspace paths and binds their receipt.
  'DOM.setFileInputFiles': { reason: 'assigns host files outside the original Workspace upload owner', instead: 'Use uploadFiles(ref, paths) with an authorized Workspace; a raw CDP call cannot grant host file access.' },
  // Network cookies and caches belong to the Profile's session, not the page.
  'Network.getAllCookies': PROFILE_DATA,
  'Network.getCookies': PROFILE_DATA,
  'Network.setCookie': PROFILE_DATA,
  'Network.setCookies': PROFILE_DATA,
  'Network.deleteCookies': PROFILE_DATA,
  'Network.clearBrowserCookies': PROFILE_DATA,
  'Network.clearBrowserCache': PROFILE_DATA,
  'Page.clearCompilationCache': PROFILE_DATA,
  'Page.setDownloadBehavior': DOWNLOADS,
  'Page.close': OUTSIDE_PAGE,
  'Page.crash': BROWSER_PROCESS,
  'Target.createTarget': OUTSIDE_PAGE,
  'Target.closeTarget': OUTSIDE_PAGE,
  'Target.activateTarget': OUTSIDE_PAGE,
  'Target.attachToTarget': OUTSIDE_PAGE,
  'Target.attachToBrowserTarget': OUTSIDE_PAGE,
  'Target.exposeDevToolsProtocol': OUTSIDE_PAGE,
  'Target.createBrowserContext': OUTSIDE_PAGE,
  'Target.disposeBrowserContext': OUTSIDE_PAGE,
  'Target.getTargets': OUTSIDE_PAGE,
  'Target.getBrowserContexts': OUTSIDE_PAGE,
  'Target.setDiscoverTargets': OUTSIDE_PAGE,
  'Target.setRemoteLocations': OUTSIDE_PAGE,
  'Target.autoAttachRelated': OUTSIDE_PAGE,
  // The session's own frame discovery is Main's; a program changing it would hide or add frames.
  'Target.setAutoAttach': OUTSIDE_PAGE
}

/** The refusal for a method whose effect reaches past this page, or null when it stays inside it. */
export function browserCdpScopeRefusal(method: string): BrowserCdpScopeRefusal | null {
  if (Object.hasOwn(METHODS, method)) return METHODS[method]!
  const domain = method.split('.', 1)[0]!
  return Object.hasOwn(DOMAINS, domain) ? DOMAINS[domain]! : null
}

/** Raw `Input.*` commands are native input; they go through Main's own-dispatch receipt like page actions. */
export function isBrowserCdpNativeInput(method: string): boolean {
  return method === 'Input.dispatchMouseEvent' || method === 'Input.dispatchKeyEvent' || method === 'Input.insertText' ||
    method === 'Input.dispatchTouchEvent' || method === 'Input.dispatchDragEvent' || method === 'Input.imeSetComposition' ||
    method === 'Input.synthesizeTapGesture' || method === 'Input.synthesizeScrollGesture' || method === 'Input.synthesizePinchGesture'
}
