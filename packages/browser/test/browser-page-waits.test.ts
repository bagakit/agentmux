import { describe, expect, it, vi } from 'vitest'
import { createBrowserPageDispatch } from '../src/browser-page-dispatch.js'
import type { BrowserPageTransport } from '../src/browser-page-transport.js'

/** A page whose accessibility tree and URL the test changes between polls. */
function page(state: { url: string; navigationId: string; nodes: { role: string; name: string }[] },
    readyState?: () => string, network?: Pick<BrowserPageTransport, 'sendCommand' | 'observe'>) {
  const session: BrowserPageTransport = {
    sendCommand: async (method, params) => {
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-document', loaderId: 'loader-main' } } }
      if (method === 'Accessibility.getFullAXTree') {
        return { nodes: [{ nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'r' }, childIds: state.nodes.map((_, i) => String(i + 1)) },
          ...state.nodes.map((node, i) => ({ nodeId: String(i + 1), backendDOMNodeId: 11 + i, role: { value: node.role }, name: { value: node.name }, childIds: [] }))] }
      }
      if (method === 'Runtime.evaluate') return { result: { value: params?.expression === 'document.readyState' ? readyState?.() : '[]' } }
      return {}
    },
    frames: new Map(), endedReason: null, frameDiscoveryFailure: null, observe: () => () => {},
    ...network
  }
  return createBrowserPageDispatch({
    session, pageInfo: () => ({ url: state.url, title: 't', navigationId: state.navigationId }),
    gotoUrl: async () => {}, captureScreenshot: async () => ({}), readLedger: async () => null, writeLedger: async () => {}, note: () => {}
  })
}

function networkIdle() {
  let listener: Parameters<BrowserPageTransport['observe']>[0] | undefined
  const event = (method: string, requestId: string, sessionId?: string) =>
    listener?.(`Network.${method}`, { requestId }, sessionId)
  const stop = vi.fn(() => { listener = undefined })
  const dispatch = page({ url: 'https://example.test/', navigationId: 'original-document', nodes: [] }, undefined, {
    async sendCommand(method) {
      expect(method).toBe('Network.enable')
      event('requestWillBeSent', 'started-during-enable')
      return {}
    },
    observe(read) { listener = read; return stop }
  })
  return { dispatch, event, stop }
}

describe('waiting for the page', () => {
  it('counts a redirect chain as one request and waits for the final response', async () => {
    vi.useFakeTimers()
    try {
      const { dispatch, event, stop } = networkIdle()
      const finished = vi.fn()
      const result = dispatch('waitForNetworkIdle', [2_000]).then(finished)
      await vi.advanceTimersByTimeAsync(100)
      event('requestWillBeSent', 'started-during-enable')
      event('requestWillBeSent', 'started-during-enable')
      await vi.advanceTimersByTimeAsync(600)
      expect(finished).not.toHaveBeenCalled()
      event('loadingFinished', 'started-during-enable')
      await vi.advanceTimersByTimeAsync(500)
      expect(finished).toHaveBeenCalledExactlyOnceWith(null)
      expect(stop).toHaveBeenCalledOnce()
      await result
    } finally { vi.useRealTimers() }
  })

  it('keeps overlapping requests separate across CDP sessions and ignores unrelated endings', async () => {
    vi.useFakeTimers()
    try {
      const { dispatch, event } = networkIdle()
      const finished = vi.fn()
      const result = dispatch('waitForNetworkIdle', [2_000]).then(finished)
      await vi.advanceTimersByTimeAsync(100)
      event('requestWillBeSent', 'started-during-enable', 'iframe')
      event('loadingFailed', 'unobserved-request')
      event('loadingFailed', 'started-during-enable', 'iframe')
      await vi.advanceTimersByTimeAsync(600)
      expect(finished).not.toHaveBeenCalled()
      event('loadingFinished', 'started-during-enable')
      await vi.advanceTimersByTimeAsync(500)
      expect(finished).toHaveBeenCalledExactlyOnceWith(null)
      await result
    } finally { vi.useRealTimers() }
  })

  it('checks the ready state again when the original document changes during the read', async () => {
    const state = { url: 'https://example.test/start', navigationId: 'original-document', nodes: [] }
    let reads = 0
    const dispatch = page(state, () => {
      if (++reads === 1) {
        state.url = 'https://example.test/end'
        state.navigationId = 'new-document'
      }
      return 'complete'
    })
    await expect(dispatch('waitForLoad', [2_000])).resolves.toEqual({ url: state.url, navigationId: 'new-document' })
    expect(reads).toBe(2)
  })

  it('waitForUrl returns the document the page reached, for a full URL, a part or a pattern', async () => {
    const state = { url: 'https://example.test/start', navigationId: 'nav-1', nodes: [] }
    const dispatch = page(state)
    setTimeout(() => { state.url = 'https://example.test/orders/42?tab=items'; state.navigationId = 'nav-2' }, 150)
    await expect(dispatch('waitForUrl', [{ contains: '/orders/' }, 2_000])).resolves.toEqual({ url: 'https://example.test/orders/42?tab=items', navigationId: 'nav-2' })
    await expect(dispatch('waitForUrl', ['https://example.test/orders/42?tab=items', 500])).resolves.toMatchObject({ navigationId: 'nav-2' })
    // A pattern is refused: it would run program code on Main.
    await expect(dispatch('waitForUrl', [{ pattern: '(.*)*x' }, 500])).rejects.toThrow('test pageInfo().url in your program')
  })

  it('waitForUrl times out naming what it waited for, and refuses a condition it cannot read', async () => {
    const dispatch = page({ url: 'https://example.test/start', navigationId: 'nav-1', nodes: [] })
    await expect(dispatch('waitForUrl', ['https://example.test/done', 200])).rejects.toThrow('Timed out after 200ms waiting for the page to reach "https://example.test/done"')
    await expect(dispatch('waitForUrl', [42, 200])).rejects.toThrow('waitForUrl takes a URL string')
    // A whole URL is compared as Chromium normalizes it, so the bare origin matches its trailing slash.
    const origin = page({ url: 'https://example.test/', navigationId: 'nav-1', nodes: [] })
    await expect(origin('waitForUrl', ['https://example.test', 200])).resolves.toMatchObject({ url: 'https://example.test/' })
    // A full URL means that page, not every page under it: /start is not /start/deeper.
    const deeper = page({ url: 'https://example.test/start/deeper', navigationId: 'nav-1', nodes: [] })
    await expect(deeper('waitForUrl', ['https://example.test/start', 200])).rejects.toThrow('Timed out')
  })

  it('waitForElement matches a name part by default, and one name exactly with a role when asked', async () => {
    const state = { url: 'https://example.test/', navigationId: 'nav-1', nodes: [{ role: 'button', name: 'Save draft' }] }
    const dispatch = page(state)
    // "Save" is part of "Save draft", so the default wait is already satisfied.
    await expect(dispatch('waitForElement', ['Save', 200])).resolves.toBeDefined()
    // Exactly "Save" is not on the page yet; it appears later as a button.
    await expect(dispatch('waitForElement', ['Save', { timeoutMs: 200, exact: true }])).rejects.toThrow('an element named exactly "Save"')
    setTimeout(() => { state.nodes = [...state.nodes, { role: 'link', name: 'Save' }] }, 100)
    await expect(dispatch('waitForElement', ['Save', { timeoutMs: 400, exact: true, role: 'button' }])).rejects.toThrow('a button named exactly "Save"')
    state.nodes = [...state.nodes, { role: 'button', name: 'Save' }]
    await expect(dispatch('waitForElement', ['Save', { timeoutMs: 400, exact: true, role: 'button' }])).resolves.toBeDefined()
  })
})
