import type { BrowserPageContext } from './browser-page-dispatch.js'

type WaitContext = Pick<BrowserPageContext, 'pageInfo' | 'session' | 'remainingMillis'>

/** 默认的等待上限。脚本整体还有自己的超时兜底，这里只防"一个 wait 把整轮吃光"。 */
export const DEFAULT_WAIT_MS = 10_000
/** Time a cut-short wait leaves for its reason to reach the program before the program's budget ends. */
export const WAIT_RETURN_MARGIN_MS = 1_500
/** 网络安静判定：这么久没有新请求就算静了。取自 CDP 惯例，不是可调项——调它只会让判据变模糊。 */
const NETWORK_IDLE_QUIET_MS = 500

function urlCondition(wanted: unknown): (url: string) => boolean {
  if (typeof wanted === 'string') {
    let whole = wanted
    try { whole = new URL(wanted).href } catch { /* Not a parseable URL; compared as written. */ }
    return url => url === whole
  }
  const condition = wanted !== null && typeof wanted === 'object' ? wanted as { contains?: unknown } : {}
  if (typeof condition.contains === 'string') { const part = condition.contains; return url => url.includes(part) }
  throw new TypeError('waitForUrl takes a URL string or {contains: text}. For a pattern, test pageInfo().url in your program.')
}

/** 等一个条件成立，超时就说清等的是什么、等了多久——"timeout" 三个字帮不了任何人。 */
export async function waitForBrowserCondition(
  context: Pick<WaitContext, 'remainingMillis'>,
  what: string,
  timeoutMs: number,
  probe: () => Promise<boolean>
): Promise<void> {
  // Keep a margin so the reason below reaches the program before the program's own budget ends.
  const left = context.remainingMillis ? context.remainingMillis() - WAIT_RETURN_MARGIN_MS : Infinity
  const budget = Math.max(0, Math.min(timeoutMs, left))
  const capped = budget < timeoutMs
  const deadline = Date.now() + budget
  for (;;) {
    if (await probe()) return
    if (Date.now() >= deadline) {
      throw new Error(capped
        ? `Stopped waiting for ${what} after ${budget}ms because this program's time is almost up. Earlier steps stand; take a snapshot to see the page, then continue in a new program.`
        : `Timed out after ${timeoutMs}ms waiting for ${what}.`)
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))))
  }
}

export async function waitForBrowserLoad(context: WaitContext, timeout: unknown) {
  const { session } = context
  const timeoutMs = typeof timeout === 'number' ? timeout : DEFAULT_WAIT_MS
  // "Loaded" belongs to one document. A readyState read is only kept when the page Main reports
  // is the same before and after it, so a navigation during the read cannot pass for the new page.
  let loaded: { url: string; navigationId: string } | null = null
  await waitForBrowserCondition(context, 'the page to finish loading', timeoutMs, async () => {
    const before = context.pageInfo()
    const state = (await session.sendCommand('Runtime.evaluate', {
      expression: 'document.readyState',
      returnByValue: true
    })) as { result?: { value?: unknown } }
    const after = context.pageInfo()
    if (state.result?.value !== 'complete' || after.navigationId !== before.navigationId) return false
    loaded = { url: after.url, navigationId: after.navigationId }
    return true
  })
  // The page that finished, so a program can tell which document it now acts on.
  return loaded
}

export async function waitForBrowserUrl(context: WaitContext, wanted: unknown, timeout: unknown) {
  // The page Main reports, not the page's own location: a pushState that Main has not seen is
  // not a navigation it can act on. A string matches the whole URL; {contains} matches part of it.
  const timeoutMs = typeof timeout === 'number' ? timeout : DEFAULT_WAIT_MS
  const test = urlCondition(wanted)
  let reached: { url: string; navigationId: string } | null = null
  await waitForBrowserCondition(context, `the page to reach ${JSON.stringify(wanted)}`, timeoutMs, async () => {
    const page = context.pageInfo()
    if (!test(page.url)) return false
    reached = { url: page.url, navigationId: page.navigationId }
    return true
  })
  // A new document voids every ref; the program takes a fresh snapshot of the page it reached.
  return reached
}

export async function waitForBrowserNetworkIdle(context: WaitContext, timeout: unknown) {
  const { session } = context
  const timeoutMs = typeof timeout === 'number' ? timeout : DEFAULT_WAIT_MS
  const activeRequests = new Set<string>()
  let lastChange = Date.now()
  const stop = session.observe((method, params, sessionId) => {
    if (method !== 'Network.requestWillBeSent' && method !== 'Network.loadingFinished' && method !== 'Network.loadingFailed') return
    const requestId = (params as { requestId?: unknown } | null)?.requestId
    if (typeof requestId !== 'string') return
    // CDP repeats the request ID for redirect hops. A child session owns a separate ID namespace.
    const key = JSON.stringify([sessionId, requestId])
    if (method === 'Network.requestWillBeSent') {
      activeRequests.add(key)
      lastChange = Date.now()
    } else if (activeRequests.delete(key)) {
      lastChange = Date.now()
    }
  })
  try {
    await session.sendCommand('Network.enable')
    await waitForBrowserCondition(context, 'the network to go quiet', timeoutMs, async () =>
      activeRequests.size === 0 && Date.now() - lastChange >= NETWORK_IDLE_QUIET_MS
    )
  } finally {
    stop()
  }
  return null
}
