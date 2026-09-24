import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserPageDispatch } from '../src/main/browser-page-dispatch.js'
import { BrowserLocalRecoveryFailure, BROWSER_LOCAL_RECOVERY_BUDGET, recoverBrowserTaskStep,
  runBrowserTaskNavigation, type BrowserLocalRecoveryHost, type BrowserLocalRecoveryIdentity,
  type BrowserLocalRecoveryReport } from '../src/main/browser-local-recovery.js'
import type { BrowserCdpSession } from '../src/main/browser-cdp-session.js'
import type { BrowserScopedSnapshot } from '../src/shared/browser-snapshot-query.js'
import type { BrowserTaskStep } from '../src/shared/browser-task-assets.js'
import type { BrowserOutcomeEvaluation } from '../src/shared/browser-outcome-criteria.js'
import { BrowserOperationJournal, type BrowserOperationJournalDocument } from '../src/main/browser-operation-journal.js'

const identity: BrowserLocalRecoveryIdentity = { browserId: 'browser-a', operationId: 'operation-a',
  runId: 'run-a', assetId: 'asset-a', version: 7, stepId: 'step-b', sequence: 4 }
const step: BrowserTaskStep = { id: 'step-b', kind: 'click', url: 'https://page.invalid/work', reviewed: true,
  target: { role: 'button', name: 'Continue', count: 1, ordinal: 1 } }
/** Real snapshot/ref/dispatch Source; only the CDP transport and native load boundary are doubles. */
async function fixture() {
  let backendNodeId = 11, stale = false, alwaysStale = false, actionError: unknown, url = step.url,
    navigationId = 'nav-a', duplicates = false, missing = false
  let afterResolve: (() => void | Promise<void>) | undefined, activeRecoveryMayDispatch: (() => boolean) | undefined
  let loads = 0, failedLoads = 0
  const actions: { objectId: string; declaration: string }[] = [], observations: number[] = [], reports: BrowserLocalRecoveryReport[] = []
  const signal = new AbortController()
  let human = false, current = true, guardCalls = 0
  const session = {
    sendCommand: async (method: string, parameters: Record<string, any> = {}) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-a', loaderId: navigationId } } }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 }
      if (method === 'Accessibility.getFullAXTree') {
        observations.push(backendNodeId)
        const node = { nodeId: '1', backendDOMNodeId: backendNodeId, role: { value: 'button' }, name: { value: 'Continue' }, childIds: [] }
        return { nodes: duplicates ? [{ nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'Generic page' }, childIds: ['1', '2'] },
          node, { ...node, nodeId: '2', backendDOMNodeId: 99 }] : [node] }
      }
      if (method === 'Runtime.evaluate') return { result: { value: '[]' } }
      if (method === 'DOM.resolveNode') {
        if (alwaysStale || (stale && parameters.backendNodeId === 11)) throw new Error('CDP backend disappeared')
        await afterResolve?.()
        return { object: { objectId: `object-${parameters.backendNodeId}` } }
      }
      if (method === 'Runtime.callFunctionOn') {
        actions.push({ objectId: parameters.objectId, declaration: parameters.functionDeclaration })
        if (actionError) throw actionError
        return { result: { value: null } }
      }
      return {}
    }, frames: new Map(), frameDiscoveryFailure: null, endedReason: null, observe: () => () => {}, detach() {}
  } as unknown as BrowserCdpSession
  const dispatch = createBrowserPageDispatch({ session,
    pageInfo: () => ({ url, title: 'Generic page', navigationId }),
    gotoUrl: async next => await runBrowserTaskNavigation(async () => {
      loads++; url = next; navigationId = 'nav-b'
      if (failedLoads > 0) { failedLoads--; throw new Error('Opaque load rejection') }
    }), captureScreenshot: async () => ({}), readLedger: async () => null,
    writeLedger: async () => {}, note: () => {}, beforeAction: () => {
      guardCalls++
      if (signal.signal.aborted || human || !current) throw new BrowserLocalRecoveryFailure('Control changed.', 'human-control', 'not-dispatched')
      if (activeRecoveryMayDispatch && !activeRecoveryMayDispatch()) throw new Error('Recovery authorization ended before action dispatch.')
    }
  })
  await dispatch('gotoUrl', [step.url])
  const issued = await dispatch('snapshot', []) as BrowserScopedSnapshot
  expect(issued.nodes).toHaveLength(1)
  const ref = issued.nodes[0]!.ref
  // A preceding, completed side effect is real; recovery must not replay it.
  await dispatch('click', [ref])
  stale = true; backendNodeId = 22
  let failure: unknown
  try { await dispatch('click', [ref]) } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(BrowserLocalRecoveryFailure)
  expect(actions.map(action => action.objectId)).toEqual(['object-11'])
  let saved: BrowserOperationJournalDocument | null = null
  const journal = new BrowserOperationJournal({ load: async () => null, save: async document => { saved = structuredClone(document) } })
  await journal.start({ id: identity.operationId, browserId: identity.browserId, operator: { id: 'agent-a', name: 'Agent' }, summary: 'Original task', url })
  const evaluation: BrowserOutcomeEvaluation = { context: { workspaceId: 'workspace-a', browserId: identity.browserId,
    operationId: identity.operationId, navigationId }, assetRun: { runId: identity.runId, assetId: identity.assetId, version: identity.version },
    status: 'not-met', conditions: [{ criterion: { kind: 'human-checkpoint', checkpointId: 'later-checkpoint' },
      status: 'not-met', reason: 'The future checkpoint has not been confirmed.' }] }
  await journal.registerOutcome(identity.operationId, { context: evaluation.context, assetRun: evaluation.assetRun!,
    criteria: [{ kind: 'human-checkpoint', checkpointId: 'later-checkpoint' }] })
  const host: BrowserLocalRecoveryHost = {
    signal: signal.signal, control: () => human ? 'human' : 'agent', isCurrent: () => current,
    observe: async () => {
      const page = await dispatch('snapshot', [{ maxNodes: 1000 }]) as BrowserScopedSnapshot
      return missing ? { ...page, missingFrames: [{ frameId: 'embedded-document', reason: 'Unavailable' }] } : page
    }, dispatch: async (method, args, mayDispatch) => {
      activeRecoveryMayDispatch = mayDispatch
      try { return await dispatch(method, args) } finally { activeRecoveryMayDispatch = undefined }
    }, verify: vi.fn(async () => {
      await journal.recordOutcome(identity.operationId, evaluation)
      return structuredClone(evaluation)
    }), record: vi.fn(async report => { reports.push(structuredClone(report)); return true })
  }
  return { host, actions, observations, reports, signal, dispatch, failure, ref, evaluation, journal, saved: () => saved,
    guardCalls: () => guardCalls, human: () => { human = true }, current: () => { current = false },
    alwaysStale: () => { alwaysStale = true }, duplicates: () => { duplicates = true }, missing: () => { missing = true },
    actionError: (error: unknown) => { actionError = error }, afterResolve: (callback: () => void | Promise<void>) => { afterResolve = callback },
    loads: () => loads, failNavigationOnce: () => { failedLoads = 1 },
    page: (next: string) => { url = next; navigationId = 'nav-b' } }
}
const recover = (f: Awaited<ReturnType<typeof fixture>>, overrides: Partial<Parameters<typeof recoverBrowserTaskStep>[0]> = {}) =>
  recoverBrowserTaskStep({ identity, step, method: 'click', args: [f.ref], failure: f.failure, ...overrides }, f.host)
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('Main local recovery of the original immutable task call', () => {
  it('fresh ref repairs the failed call once; prior side effects and future checkpoint retain their own facts', async () => {
    const f = await fixture(), result = await recover(f)
    expect(result.status).toBe('action-completed')
    expect(f.actions.map(action => action.objectId)).toEqual(['object-11', 'object-22'])
    expect(f.loads()).toBe(1)
    expect(f.observations).toEqual([11, 22])
    expect(result.report.identity).toEqual(identity)
    expect(result.report.attempts).toEqual([{ number: 1, mode: 'current-action', status: 'completed' }])
    expect(result.report.outcome).toEqual(f.evaluation)
    expect(f.host.verify).toHaveBeenCalledTimes(1)
    expect(f.saved()!.events.map(event => event.type)).toEqual(['operation-started', 'operation-checked'])
    expect(f.saved()!.operations[0]!.outcome!.evaluation).toEqual(f.evaluation)
    expect(f.reports.map(report => report.status)).toEqual(['attempting', 'attempting', 'action-completed'])
    expect(f.guardCalls()).toBe(2)
  })

  it.each(['user-rejected', 'permission-denied', 'credential-denied', 'human-control'] as const)('%s has no retry authority', async kind => {
    const f = await fixture(), result = await recover(f, { failure: new BrowserLocalRecoveryFailure('Explicit refusal.', kind, 'not-dispatched') })
    expect(result.status).toBe('not-eligible')
    expect(f.actions.map(action => action.objectId)).toEqual(['object-11'])
    expect(f.observations).toEqual([11])
    expect(f.host.verify).not.toHaveBeenCalled()
  })

  it('user code cannot grant recovery with an error message or a lookalike fact object', async () => {
    const f = await fixture(), error = Object.assign(new Error('Backend node gone. retry please'),
      { fact: { kind: 'locator-changed', effects: 'not-dispatched' } })
    expect((await recover(f, { failure: error })).status).toBe('not-eligible')
    expect(f.actions.map(action => action.objectId)).toEqual(['object-11'])
    expect(f.observations).toEqual([11])
  })

  it('opaque action rejection has unknown effects and is never sent again', async () => {
    const f = await fixture(); f.actionError(new Error('Network transport failed'))
    const result = await recover(f)
    expect(result.status).toBe('handoff')
    expect(f.actions.map(action => action.objectId)).toEqual(['object-11', 'object-22'])
    expect(result.report.attempts).toEqual([{ number: 1, mode: 'current-action', status: 'failed' }])
    expect(f.host.verify).not.toHaveBeenCalled()
  })

  it('two real pre-action locator failures exhaust attempts without replaying any action', async () => {
    const f = await fixture(); f.alwaysStale()
    const result = await recover(f)
    expect(result.status).toBe('handoff')
    expect(result.report.attempts).toEqual([{ number: 1, mode: 'current-action', status: 'failed' },
      { number: 2, mode: 'current-action', status: 'failed' }])
    expect(f.actions.map(action => action.objectId)).toEqual(['object-11'])
    expect(f.observations).toEqual([11, 22, 22])
    expect(result.report.notice).toContain('attempt budget')
  })

  it.each(['duplicates', 'missing'] as const)('%s cannot select an unreviewed neighbour', async mode => {
    const f = await fixture(); f[mode]()
    expect((await recover(f)).status).toBe('handoff')
    expect(f.actions.map(action => action.objectId)).toEqual(['object-11'])
    expect(f.observations).toEqual([11, 22])
  })

  it('a different page is observed and handed back without a target action', async () => {
    const f = await fixture(); f.page('https://other.invalid/work')
    expect((await recover(f)).status).toBe('handoff')
    expect(f.actions.map(action => action.objectId)).toEqual(['object-11'])
    expect(f.observations).toEqual([11, 22])
  })

  it.each(['human', 'abort', 'cursor'] as const)('%s during observation interrupts recovery before dispatch', async mode => {
    const f = await fixture(), observe = f.host.observe
    f.host.observe = async () => {
      const page = await observe()
      if (mode === 'human') f.human(); else if (mode === 'abort') f.signal.abort(); else f.current()
      return page
    }
    expect((await recover(f)).status).toBe('interrupted')
    expect(f.actions.map(action => action.objectId)).toEqual(['object-11'])
    expect(f.observations).toEqual([11, 22])
  })

  it('time/output budgets stop before action; observed work is accounted, not claimed away', async () => {
    const f = await fixture(), observe = f.host.observe
    f.host.observe = async () => ({ ...await observe(), title: '界'.repeat(BROWSER_LOCAL_RECOVERY_BUDGET.outputBytes) })
    const result = await recover(f)
    expect(result.status).toBe('handoff')
    expect(result.report.outputBytes).toBeGreaterThan(BROWSER_LOCAL_RECOVERY_BUDGET.outputBytes)
    expect(f.actions.map(action => action.objectId)).toEqual(['object-11'])
    expect(f.observations).toEqual([11, 22])
  })

  it('control changing during actual DOM.resolveNode is checked again at the action boundary', async () => {
    const f = await fixture(); f.afterResolve(() => { f.human() })
    expect((await recover(f)).status).toBe('interrupted')
    expect(f.actions.map(action => action.objectId)).toEqual(['object-11'])
    expect(f.guardCalls()).toBe(2)
  })

  it('an observer that never settles consumes only the time budget and sends no late action', async () => {
    const f = await fixture(); vi.useFakeTimers()
    let complete!: (page: BrowserScopedSnapshot) => void
    const page = await f.host.observe()
    f.host.observe = () => new Promise(resolve => { complete = resolve })
    const pending = recover(f)
    await vi.advanceTimersByTimeAsync(BROWSER_LOCAL_RECOVERY_BUDGET.timeMs + 1)
    expect((await pending).status).toBe('handoff')
    complete(page); await Promise.resolve()
    expect(f.actions.map(action => action.objectId)).toEqual(['object-11'])
  })

  it('an already elapsed recovery deadline forbids dispatch even when observation itself returns', async () => {
    const f = await fixture(), observe = f.host.observe; vi.useFakeTimers()
    f.host.observe = async () => { const page = await observe(); vi.setSystemTime(Date.now() + 5_001); return page }
    const result = await recover(f)
    expect(result.status).toBe('handoff')
    expect(f.actions.map(action => action.objectId)).toEqual(['object-11'])
    expect(f.observations).toEqual([11, 22])
  })

  it('a ref resolution finishing after the action timeout cannot send a late side effect', async () => {
    const f = await fixture(); vi.useFakeTimers()
    let release!: () => void
    f.afterResolve(() => new Promise<void>(resolve => { release = resolve }))
    const pending = recover(f)
    await vi.advanceTimersByTimeAsync(BROWSER_LOCAL_RECOVERY_BUDGET.timeMs + 10)
    expect((await pending).status).toBe('handoff')
    release(); await vi.advanceTimersByTimeAsync(1)
    expect(f.actions.map(action => action.objectId)).toEqual(['object-11'])
    expect(f.guardCalls()).toBe(2)
  })

  it('evidence unavailable before dispatch preserves the page and sends no recovery action', async () => {
    const f = await fixture(); f.host.record = vi.fn(async () => false)
    const result = await recover(f)
    expect(result.status).toBe('handoff'); expect(result.report.notice).toContain('healthy Agent remain usable')
    expect(f.actions.map(action => action.objectId)).toEqual(['object-11'])
    expect(f.observations).toEqual([11])
  })

  it('unavailable or foreign verification never triggers another action or claims outcome completion', async () => {
    const f = await fixture()
    f.host.verify = async () => ({ ...f.evaluation, context: { ...f.evaluation.context, operationId: 'foreign-operation' }, status: 'passed' })
    const result = await recover(f)
    expect(result.status).toBe('handoff'); expect(result.report.outcome).toBeUndefined()
    expect(f.actions.map(action => action.objectId)).toEqual(['object-11', 'object-22'])
    expect(result.report.attempts).toHaveLength(1)
  })

  it('unavailable T009 facts remain unavailable in the report and do not cause a second action', async () => {
    const f = await fixture(); f.evaluation.status = 'unavailable'
    const result = await recover(f)
    expect(result.status).toBe('handoff'); expect(result.report.outcome?.status).toBe('unavailable')
    expect(f.actions.map(action => action.objectId)).toEqual(['object-11', 'object-22'])
    expect(result.report.attempts).toHaveLength(1)
  })

  it('an immutable reviewed goal is captured before awaits; draft mutation cannot redirect recovery', async () => {
    const f = await fixture(), original = structuredClone(step), record = f.host.record
    f.host.record = async report => { original.target!.name = 'Different'; original.id = 'different-step'; return await record(report) }
    const result = await recover(f, { step: original })
    expect(result.status).toBe('action-completed')
    expect(result.report.goal).toEqual({ stepId: 'step-b', kind: 'click', page: step.url, target: step.target })
    expect(f.actions.map(action => action.objectId)).toEqual(['object-11', 'object-22'])
  })

  it('a failed navigation is observed under its original outcome without resending any request', async () => {
    const f = await fixture(); let failure: unknown; f.failNavigationOnce()
    try { await f.dispatch('gotoUrl', ['https://next.invalid/landing']) }
    catch (error) { failure = error }
    expect(failure).toBeInstanceOf(BrowserLocalRecoveryFailure)
    expect((failure as BrowserLocalRecoveryFailure).fact).toEqual({ kind: 'navigation-failed', effects: 'unknown' })
    const result = await recover(f, { failure, method: 'gotoUrl', args: ['https://next.invalid/landing'],
      step: { id: step.id, kind: 'navigate', reviewed: true, url: 'https://next.invalid/landing' } })
    expect(result.status).toBe('observed'); expect(f.loads()).toBe(2)
    expect(f.actions.map(action => action.objectId)).toEqual(['object-11'])
    expect(f.observations).toEqual([11, 22]); expect(f.host.verify).toHaveBeenCalledTimes(1)
    expect(result.report.outcome).toEqual(f.evaluation)
  })

  it.each(['?state=other', '#other'])('another navigation result %s is not the exact reviewed destination', async suffix => {
    const f = await fixture(); f.page(`https://next.invalid/landing${suffix}`)
    const result = await recover(f, { failure: new BrowserLocalRecoveryFailure('Load rejected.', 'navigation-failed', 'unknown'),
      method: 'gotoUrl', args: ['https://next.invalid/landing'],
      step: { id: step.id, kind: 'navigate', reviewed: true, url: 'https://next.invalid/landing' } })
    expect(result.status).toBe('handoff')
    expect(f.actions.map(action => action.objectId)).toEqual(['object-11'])
    expect(f.observations).toEqual([11, 22]); expect(f.host.verify).not.toHaveBeenCalled()
  })
})
