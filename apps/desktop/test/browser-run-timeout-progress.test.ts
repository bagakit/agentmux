import { describe, expect, it, vi } from 'vitest'
import { browserRunOutcomeFromFailure } from '../src/main/browser-run-outcome.js'
import { createBrowserPageDispatch } from '../src/main/browser-page-dispatch.js'
import type { BrowserPageTransport } from '../src/main/browser-page-dispatch.js'

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
