import { describe, expect, it, vi } from 'vitest'
import { browserRunOutcomeFromFailure } from '@agentmux/browser/operations'
import { createBrowserPageDispatch } from '@agentmux/browser/page'
import type { BrowserPageTransport } from '@agentmux/browser/page'

/**
 * A program that runs out of time must tell its Agent where it stopped, and must not invite a rerun
 * when a page-changing call was in flight. A wait inside the program ends with its own reason before
 * the program's budget does, so the Agent learns what it was waiting for instead of only "stopped".
 */
const timeout = { kind: 'timeout' as const, timeoutMs: 29_999 }

describe('A timed-out program says where it stopped', () => {
  it('names the call it was in and how many calls finished', () => {
    const outcome = browserRunOutcomeFromFailure(timeout,
      [{ method: 'snapshot', status: 'completed' }, { method: 'gotoUrl', status: 'completed' }, { method: 'waitForElement', status: 'running' }])
    expect(outcome).toEqual({ kind: 'stopped', message: expect.stringContaining('It was in waitForElement() after 2 completed page calls.') })
    expect(outcome.kind === 'stopped' && outcome.message).toContain('Earlier calls stand')
  })

  it('is indeterminate, not stopped, when a page-changing call was in flight', () => {
    const outcome = browserRunOutcomeFromFailure(timeout, [{ method: 'snapshot', status: 'completed' }, { method: 'click', status: 'running' }])
    expect(outcome.kind).toBe('indeterminate')
    expect(outcome.kind === 'indeterminate' && outcome.message).toContain('do not rerun the same program')
  })

  it('says when the program was in its own code rather than waiting on the page', () => {
    const outcome = browserRunOutcomeFromFailure(timeout, [{ method: 'snapshot', status: 'completed' }])
    expect(outcome.kind === 'stopped' && outcome.message).toContain('1 page call had completed; it was running your own code')
  })

  it('leaves every other failure as it was', () => {
    expect(browserRunOutcomeFromFailure({ kind: 'crashed', reason: 'gone' }, [{ method: 'click', status: 'running' }]).kind).toBe('indeterminate')
    expect(browserRunOutcomeFromFailure({ kind: 'output-limit', capturedChars: 9 }, [{ method: 'click', status: 'running' }]).kind).toBe('stopped')
  })
})

describe('A page wait ends before the program does', () => {
  function dispatch(remainingMillis: () => number) {
    const session = {
      sendCommand: vi.fn(async (method: string) => method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'f', loaderId: 'l' } } } : { result: { value: 'loading' } }),
      frames: new Map(), endedReason: null, frameDiscoveryFailure: null, observe: () => () => {}, detach: () => {}
    } as unknown as BrowserPageTransport
    return createBrowserPageDispatch({
      session, pageInfo: () => ({ url: 'https://example.invalid/', title: 'Example', navigationId: 'nav-1' }),
      gotoUrl: async () => {}, captureScreenshot: async () => ({}), readLedger: async () => null, writeLedger: async () => {}, note: () => {},
      remainingMillis
    })
  }

  it('cuts a wait to the program’s remaining time, leaving room for its reason to arrive', async () => {
    const started = Date.now()
    await expect(dispatch(() => 1_700)('waitForLoad', [10_000])).rejects.toThrow(/because this program's time is almost up/)
    const waited = Date.now() - started
    // 1.7 s left, minus the margin a reason needs to reach the program before the budget ends.
    expect(waited, 'the wait ran into the program budget instead of ending before it').toBeLessThan(700)
  })

  it('keeps its own timeout and wording when the program has time to spare', async () => {
    await expect(dispatch(() => 60_000)('waitForLoad', [150])).rejects.toThrow('Timed out after 150ms waiting for the page to finish loading.')
  })
})

describe('js() ends before the program does', () => {
  function jsDispatch(evaluate: (params: Record<string, unknown>) => Promise<unknown>, remainingMillis?: () => number) {
    const sent: string[] = []
    const session = {
      sendCommand: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
        sent.push(method)
        return method === 'Runtime.evaluate' ? await evaluate(params) : {}
      }),
      frames: new Map(), endedReason: null, frameDiscoveryFailure: null, observe: () => () => {}, detach: () => {}
    } as unknown as BrowserPageTransport
    const dispatch = createBrowserPageDispatch({
      session, pageInfo: () => ({ url: 'https://example.invalid/', title: 'Example', navigationId: 'nav-1' }),
      gotoUrl: async () => {}, captureScreenshot: async () => ({}), readLedger: async () => null, writeLedger: async () => {}, note: () => {},
      ...(remainingMillis ? { remainingMillis } : {})
    })
    return { dispatch, sent, session }
  }

  it('stops a promise that never settles, terminates the page script, and says its effect is unknown', async () => {
    const { dispatch, sent } = jsDispatch(() => new Promise(() => {}), () => 1_700)
    const started = Date.now()
    await expect(dispatch('js', ['new Promise(() => {})'])).rejects.toThrow(/js\(\) was stopped after \d+ms because this program's time is almost up\. Its effect on the page is unknown/)
    expect(Date.now() - started).toBeLessThan(700)
    expect(sent).toEqual(['Runtime.evaluate', 'Runtime.terminateExecution'])
  })

  it('passes the same budget to Chromium so a synchronous loop is cut too', async () => {
    let seen: Record<string, unknown> = {}
    const { dispatch } = jsDispatch(async params => { seen = params; return { exceptionDetails: { text: 'Execution was terminated' } } }, () => 1_700)
    await expect(dispatch('js', ['for(;;){}'])).rejects.toThrow(/was stopped after/)
    expect(seen.timeout).toBe(200)
  })

  it('returns the value unchanged when there is no program budget or time to spare', async () => {
    expect(await jsDispatch(async () => ({ result: { value: 4 } }))['dispatch']('js', ['2+2'])).toBe(4)
    expect(await jsDispatch(async () => ({ result: { value: 4 } }), () => 60_000)['dispatch']('js', ['2+2'])).toBe(4)
  })
})

describe('waitForLoad answers for one document', () => {
  it('ignores a complete readyState read while the page navigated, and returns the page that loaded', async () => {
    let navigationId = 'nav-old', reads = 0
    const session = {
      sendCommand: vi.fn(async (method: string) => {
        if (method !== 'Runtime.evaluate') return {}
        reads += 1
        // The first read lands on the old page as it is replaced; only the new page's read counts.
        if (reads === 1) { navigationId = 'nav-new'; return { result: { value: 'complete' } } }
        return { result: { value: reads === 2 ? 'loading' : 'complete' } }
      }),
      frames: new Map(), endedReason: null, frameDiscoveryFailure: null, observe: () => () => {}, detach: () => {}
    } as unknown as BrowserPageTransport
    const dispatch = createBrowserPageDispatch({
      session, pageInfo: () => ({ url: navigationId === 'nav-new' ? 'https://example.invalid/next' : 'https://example.invalid/', title: 'Example', navigationId }),
      gotoUrl: async () => {}, captureScreenshot: async () => ({}), readLedger: async () => null, writeLedger: async () => {}, note: () => {}
    })
    expect(await dispatch('waitForLoad', [2_000])).toEqual({ url: 'https://example.invalid/next', navigationId: 'nav-new' })
    expect(reads, 'the read that straddled the navigation was taken as loaded').toBe(3)
  })
})
