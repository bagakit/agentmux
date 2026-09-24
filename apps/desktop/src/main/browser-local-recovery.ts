import type { BrowserTaskStep, BrowserTaskStepExecution } from '../shared/browser-task-assets.js'
import type { BrowserScopedSnapshot } from '../shared/browser-snapshot-query.js'
import type { BrowserOutcomeEvaluation } from '../shared/browser-outcome-criteria.js'

export type BrowserRecoveryFailureKind = 'locator-changed' | 'navigation-failed' | 'user-rejected' |
  'permission-denied' | 'credential-denied' | 'human-control'

/** Only Main creates this error. Script/page error text never grants retry authority. */
export class BrowserLocalRecoveryFailure extends Error {
  readonly fact: Readonly<{ kind: BrowserRecoveryFailureKind; effects: 'not-dispatched' | 'unknown' }>
  constructor(message: string, kind: BrowserRecoveryFailureKind, effects: 'not-dispatched' | 'unknown') {
    super(message)
    this.name = 'BrowserLocalRecoveryFailure'
    this.fact = Object.freeze({ kind, effects })
  }
}

/** A rejected navigation may already have sent requests or changed the document. Never resend it. */
export async function runBrowserTaskNavigation(load: () => Promise<unknown>): Promise<void> {
  try { await load() } catch {
    throw new BrowserLocalRecoveryFailure('Browser navigation did not report completion. Inspect the current page.',
      'navigation-failed', 'unknown')
  }
}

export const BROWSER_LOCAL_RECOVERY_BUDGET = Object.freeze({ attempts: 2, timeMs: 5_000, outputBytes: 64 * 1024 })
export type BrowserLocalRecoveryIdentity = BrowserTaskStepExecution & { operationId: string; sequence: number }
export type BrowserLocalRecoveryReport = {
  identity: BrowserLocalRecoveryIdentity
  goal: { stepId: string; kind: BrowserTaskStep['kind']; page: string | null; target?: BrowserTaskStep['target'] }
  failure: { kind: BrowserRecoveryFailureKind | 'unclassified'; effects: 'not-dispatched' | 'unknown' }
  budget: typeof BROWSER_LOCAL_RECOVERY_BUDGET
  attempts: { number: number; mode: 'observe' | 'current-action'; status: 'started' | 'completed' | 'failed' }[]
  status: 'attempting' | 'action-completed' | 'observed' | 'handoff' | 'not-eligible' | 'interrupted'
  elapsedMs: number
  outputBytes: number
  outcome?: BrowserOutcomeEvaluation
  notice: string
}
export type BrowserLocalRecoveryHost = {
  /** Checks the original Browser/view, operation and immutable asset cursor; never selects another run. */
  isCurrent(): boolean
  control(): 'agent' | 'human'
  signal: AbortSignal
  observe(): Promise<BrowserScopedSnapshot>
  /** The existing dispatch closure, never runScript or a program replay. */
  dispatch(method: string, args: unknown[], mayDispatch: () => boolean): Promise<unknown>
  /** Read-only T009 verification for the same registered operation; optional facts can remain not-met. */
  verify(): Promise<BrowserOutcomeEvaluation>
  /** Durable diagnostic evidence under identity.operationId/sequence. False means no further action. */
  record(report: BrowserLocalRecoveryReport): Promise<boolean>
}
export type BrowserLocalRecoveryResult = {
  status: BrowserLocalRecoveryReport['status']
  value?: unknown
  report: BrowserLocalRecoveryReport
}

function pageIdentity(url: string, exact = false): string | null {
  try {
    const parsed = new URL(url)
    parsed.username = ''; parsed.password = ''
    if (!exact) { parsed.search = ''; parsed.hash = '' }
    return parsed.toString()
  } catch { return null }
}

/** Narrow recovery of one already-bound call. Completed preceding calls are never inputs to this API. */
export async function recoverBrowserTaskStep(input: {
  identity: BrowserLocalRecoveryIdentity; step: BrowserTaskStep; method: string; args: unknown[]; failure: unknown
}, host: BrowserLocalRecoveryHost): Promise<BrowserLocalRecoveryResult> {
  // Copy the trusted immutable cursor/step before any async observer can race a draft edit.
  const identity = { ...input.identity }, step = structuredClone(input.step), args = [...input.args]
  const startedAt = Date.now()
  const fact = input.failure instanceof BrowserLocalRecoveryFailure ? input.failure.fact : null
  const report: BrowserLocalRecoveryReport = {
    identity, goal: { stepId: step.id, kind: step.kind, page: pageIdentity(step.url), ...(step.target ? { target: structuredClone(step.target) } : {}) },
    failure: fact ? { ...fact } : { kind: 'unclassified', effects: 'unknown' },
    budget: BROWSER_LOCAL_RECOVERY_BUDGET, attempts: [], status: 'attempting', elapsedMs: 0, outputBytes: 0,
    notice: 'Recovery is limited to this failed call; the original page and Agent remain available.'
  }
  const live = () => !host.signal.aborted && host.control() === 'agent' && host.isCurrent()
  const expired = () => Date.now() - startedAt >= BROWSER_LOCAL_RECOVERY_BUDGET.timeMs
  const account = (value: unknown): boolean => {
    try { report.outputBytes += Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8') } catch { return false }
    return report.outputBytes <= BROWSER_LOCAL_RECOVERY_BUDGET.outputBytes
  }
  const save = async (): Promise<boolean> => {
    report.elapsedMs = Date.now() - startedAt
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([host.record(structuredClone(report)), new Promise<false>(resolve => {
        timer = setTimeout(() => resolve(false), Math.max(1, BROWSER_LOCAL_RECOVERY_BUDGET.timeMs - report.elapsedMs))
      })])
    } catch { return false } finally { clearTimeout(timer) }
  }
  const finish = async (status: BrowserLocalRecoveryReport['status'], notice: string, value?: unknown): Promise<BrowserLocalRecoveryResult> => {
    report.status = status; report.notice = notice
    if (!await save()) report.notice += ' Recovery evidence could not be saved; inspect the page before another action.'
    return { status, ...(value === undefined ? {} : { value }), report: structuredClone(report) }
  }
  // Promise timeout never grants another attempt: in-flight work can have unknown effects.
  const bounded = async <T>(work: () => Promise<T>): Promise<T> => {
    if (!live() || expired()) throw new Error('Recovery stopped or exhausted its time budget.')
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort!: () => void
    const stop = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error('Recovery interrupted.'))
      host.signal.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => reject(new Error('Recovery time budget exhausted.')),
        Math.max(1, BROWSER_LOCAL_RECOVERY_BUDGET.timeMs - (Date.now() - startedAt)))
    })
    try { return await Promise.race([work(), stop]) }
    finally { clearTimeout(timer); host.signal.removeEventListener('abort', abort) }
  }
  if (!live()) return await finish('interrupted', 'Recovery stopped because control or the original operation changed. The page remains available.')
  const eligible = fact && (fact.kind === 'locator-changed' || fact.kind === 'navigation-failed') && step.reviewed &&
    identity.stepId === step.id && (
      (step.kind === 'click' && input.method === 'click' && !!step.target) ||
      (step.kind === 'fill' && input.method === 'fillInput' && !!step.target && typeof args[1] === 'string') ||
      (step.kind === 'navigate' && input.method === 'gotoUrl' && args[0] === step.url)
    )
  if (!eligible) return await finish('not-eligible', 'This failure has no trusted local retry authority. Inspect the failed step or return control to the user.')
  if (!await save()) return await finish('handoff', 'Recovery evidence is unavailable. The page and healthy Agent remain usable; check local storage before retrying.')
  const check = async (): Promise<BrowserOutcomeEvaluation | undefined> => {
    try {
      const outcome = await bounded(() => host.verify())
      if (!live() || !account(outcome) || outcome.context.browserId !== identity.browserId ||
          outcome.context.operationId !== identity.operationId || !outcome.assetRun ||
          outcome.assetRun.runId !== identity.runId || outcome.assetRun.assetId !== identity.assetId ||
          outcome.assetRun.version !== identity.version) return undefined
      report.outcome = structuredClone(outcome)
      return outcome.status === 'unavailable' ? undefined : outcome
    } catch { return undefined }
  }
  for (let number = 1; number <= BROWSER_LOCAL_RECOVERY_BUDGET.attempts; number++) {
    if (!live()) return await finish('interrupted', 'User control, stop or the original cursor ended recovery. No further action was sent.')
    if (expired()) return await finish('handoff', 'Recovery exhausted its time budget. Inspect the current page before continuing.')
    const attempt: BrowserLocalRecoveryReport['attempts'][number] = { number, mode: 'observe', status: 'started' }
    report.attempts.push(attempt)
    let snapshot: BrowserScopedSnapshot
    try { snapshot = await bounded(() => host.observe()) } catch {
      attempt.status = 'failed'
      return await finish(live() ? 'handoff' : 'interrupted', 'Recovery observation is unavailable or timed out. Inspect the original page; the Agent remains usable.')
    }
    if (!live()) return await finish('interrupted', 'Control or the original cursor changed during observation. No recovery action was sent.')
    if (!account(snapshot) || expired()) return await finish('handoff', 'Recovery reached its output or time budget. Inspect the original page before continuing.')
    const exactNavigation = step.kind === 'navigate'
    if (pageIdentity(snapshot.url, exactNavigation) !== pageIdentity(step.url, exactNavigation) || pageIdentity(step.url, exactNavigation) === null) {
      attempt.status = 'failed'
      return await finish('handoff', 'The observed page differs from the reviewed recovery goal. Inspect it before choosing another action.')
    }
    if (fact.effects === 'unknown' || fact.kind === 'navigation-failed') {
      attempt.status = 'completed'
      // Observation can confirm a dispatched navigation without sending it twice.
      const outcome = await check()
      if (!live()) return await finish('interrupted', 'Recovery was interrupted during verification. No navigation was resent.')
      if (!outcome) return await finish('handoff', 'The page was observed, but this operation’s outcome verification is unavailable. Inspect it before continuing.')
      return await finish('observed', 'The reviewed page is visible. No uncertain action was resent; this operation’s outcome check is recorded.')
    }
    const observation = snapshot.observation, target = step.target!
    if (!observation || observation.scope.kind !== 'page' || observation.scope.document !== null || observation.truncated ||
        observation.omittedFrames.length || snapshot.missingFrames.length) {
      attempt.status = 'failed'
      return await finish('handoff', 'The recovery snapshot is incomplete. Inspect the page and its unavailable frames before retrying.')
    }
    const matches = snapshot.nodes.filter(node => node.role === target.role && node.name === target.name)
    const node = matches[target.ordinal - 1]
    if (!node || node.ref === '' || matches.length !== target.count || target.ordinal < 1) {
      attempt.status = 'failed'
      return await finish('handoff', 'The reviewed target is absent or ambiguous. Inspect the current page and review the step again.')
    }
    attempt.mode = 'current-action'
    if (!await save()) return await finish('handoff', 'Recovery evidence could not be saved. No recovery action was sent; check local storage.')
    if (!live() || expired()) return await finish('interrupted', 'Recovery stopped before dispatch. No recovery action was sent.')
    try {
      let authorized = true
      const mayDispatch = () => authorized && live() && !expired()
      let value: unknown
      try { value = await bounded(() => host.dispatch(input.method, [node.ref, ...args.slice(1)], mayDispatch)) }
      finally { authorized = false }
      attempt.status = 'completed'
      if (!live()) return await finish('interrupted', 'Control or the original cursor changed while this action completed. Inspect its effects before continuing.')
      if (!account(value)) return await finish('handoff', 'The action returned beyond the recovery output budget. Its effects may have occurred; inspect the page before continuing.')
      const outcome = await check()
      if (!live()) return await finish('interrupted', 'Recovery was interrupted during verification. The current action was not repeated.')
      if (!outcome) return await finish('handoff', 'The current action completed, but this operation’s outcome check is unavailable. Inspect it before continuing.')
      return await finish('action-completed', 'Only the failed current action completed. The original operation’s outcome check is recorded; remaining task conditions retain their own status.', value)
    } catch (error) {
      attempt.status = 'failed'
      // Only another proven pre-dispatch locator failure permits the next bounded attempt.
      if (!(error instanceof BrowserLocalRecoveryFailure) || error.fact.kind !== 'locator-changed' || error.fact.effects !== 'not-dispatched') {
        const stillCurrent = live()
        return await finish(stillCurrent ? 'handoff' : 'interrupted', stillCurrent
          ? 'The recovery action did not report completion; effects are unknown. Inspect the page before another action.'
          : 'User control, stop or the original cursor interrupted recovery. No further action was sent; inspect the page before continuing.')
      }
    }
  }
  return await finish('handoff', 'Recovery exhausted its attempt budget. The original page and healthy Agent remain available; review the failed step before continuing.')
}
