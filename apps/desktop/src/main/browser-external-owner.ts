import { browserPageCapabilityNames } from '@agentmux/core'
import type { BrowserPng, BrowserScriptRunReport, BrowserPageSnapshot, BrowserScreenshotCapture } from '../shared/contracts.js'
import type { BrowserResultReadOptions, BrowserResultArtifactChunk } from '../shared/browser-result-artifact.js'
import type { BrowserStructuredOutputReceipt } from '../shared/browser-structured-output.js'
import { BrowserStepEvidenceStore, pageStepEvidence, screenshotStepEvidence } from './browser-step-evidence.js'
import type { BrowserOperation, BrowserOperator, BrowserOperationStep } from '../shared/browser-operation.js'
import { ExternalBrowserBridge, ExternalBrowserRequestFailure, type ExternalBrowserBinding } from './browser-external-bridge.js'
import { attachExternalBrowserTarget, type ExternalBrowserTargetSession } from './browser-external-target.js'
import { createBrowserPageDispatch } from './browser-page-dispatch.js'
import { runBrowserScript } from './browser-script-runner.js'
import { browserOperationPhaseFromOutcome, browserRunOutcomeFromFailure } from './browser-run-outcome.js'
import { startBrowserOperationStep, summarizeBrowserValue } from './browser-operation-step.js'
import { showBrowserOperationFeedback, BROWSER_OPERATION_FEEDBACK_WORLD_NAME, buildBrowserOperationFeedbackRevisionScript } from './browser-operation-feedback.js'
import type { BrowserOperationJournal } from './browser-operation-journal.js'
import type { BrowserRefLedgerStore } from './browser-ref-ledger-store.js'
import type { BrowserResultArtifactStore } from './browser-result-artifact.js'
import type { BrowserUploads } from './browser-uploads.js'

const actions = new Set([...browserPageCapabilityNames('act'), ...browserPageCapabilityNames('navigate')])
const waits = new Set(browserPageCapabilityNames('wait'))
type Active = { binding: ExternalBrowserBinding; operation: BrowserOperation | null; controller: AbortController; stopped: boolean }
type Stores = { journal: BrowserOperationJournal; refs: Pick<BrowserRefLedgerStore, 'read' | 'write'>;
  results: BrowserResultArtifactStore; evidence: BrowserStepEvidenceStore; uploads: BrowserUploads; decodeScreenshot(base64: string): BrowserPng }

/** An external page owner, using the existing runner, dispatch, journal and payload owners.
 * It never supplies a pretend WebContentsView, creates a browser, or manages an Agent Run.
 */
export class ExternalBrowserOwner {
  private readonly active = new Map<string, Active>()
  private readonly operations = new Map<string, Active>()
  constructor(readonly bridge: ExternalBrowserBridge, private readonly stores: Stores) {}
  has(id: string): boolean { return this.bridge.has(id) }
  async stopOperationById(id: string): Promise<BrowserOperation | null> {
    const active = this.operations.get(id)
    if (!active) return null
    active.stopped = true
    active.controller.abort()
    this.bridge.stopSharing(active.binding.id)
    return await this.stores.journal.get(id)
  }
  async readStepResult(operationId: string, sequence: number, options?: BrowserResultReadOptions): Promise<BrowserResultArtifactChunk> {
    const operation = await this.stores.journal.get(operationId)
    if (!operation) throw new Error('This operation has no retained structured result.')
    const binding = this.bridge.require(operation.browserId)
    const step = operation.steps.find(item => item.sequence === sequence)
    if (step?.method !== 'extractStructured') throw new Error('This step has no retained structured result.')
    const reference = step.evidence?.find(item => item.kind === 'structured-output')
    if (!reference || reference.operationId !== operationId || reference.sequence !== sequence || reference.browserId !== binding.id) throw new Error('The recorded structured result is unavailable.')
    const item = await this.stores.evidence.read(reference)
    if (item.content.kind !== 'structured-output') throw new Error('The recorded result is not a structured extraction.')
    const { source, artifact, artifactStatus } = item.content.receipt
    if (artifactStatus !== 'available' || !artifact || source.operationId !== operationId || source.browserId !== binding.id ||
      source.workspaceId !== binding.workspaceId || source.navigationId !== reference.navigationId || artifact.operationId !== source.operationId ||
      artifact.browserId !== source.browserId || artifact.workspaceId !== source.workspaceId || artifact.navigationId !== source.navigationId) throw new Error('The result does not belong to this recorded extraction.')
    return await this.stores.results.read(artifact, { workspaceId: binding.workspaceId, browserId: binding.id }, options)
  }
  private async navigate(binding: ExternalBrowserBinding, session: ExternalBrowserTargetSession, url: string, signal: AbortSignal): Promise<void> {
    let expected: string | undefined
    let acknowledged = false
    let observed: string | null = null
    let loaded: string | null = null
    let finish!: () => void
    let fail!: (error: Error) => void
    const settled = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject })
    // Observe before sending: real navigation events may precede its command acknowledgement.
    const check = (): void => { if (acknowledged && observed && (!expected || (observed === expected && loaded === expected))) finish() }
    const release = this.bridge.observe(binding.id, event => {
      if (event.mainDocumentNavigation) { observed = event.navigationId; loaded = null }
      if (!event.sessionId && event.method === 'Page.loadEventFired' && observed === event.navigationId) loaded = event.navigationId
      check()
    })
    const aborted = (): void => fail(new ExternalBrowserRequestFailure('Shared-tab navigation was interrupted before its result was confirmed. Inspect the original document before retrying.', true))
    const timer = setTimeout(() => fail(new ExternalBrowserRequestFailure('Shared-tab navigation did not finish within its observation budget. Inspect the original tab; no navigation is replayed.', true)), 30_000)
    signal.addEventListener('abort', aborted, { once: true })
    try {
      // Start an error handler before the command await, avoiding an unhandled cancellation race.
      const navigation = session.sendCommand('Page.navigate', { url }).then(value => {
        const result = value as { loaderId?: string; errorText?: string }
        if (result.errorText) throw new Error(`Shared-tab navigation failed: ${result.errorText}`)
        expected = result.loaderId; acknowledged = true; check()
      })
      await Promise.all([navigation, settled])
    } finally { clearTimeout(timer); release(); signal.removeEventListener('abort', aborted) }
  }
  async runScript(id: string, code: string, operator: BrowserOperator = { id: 'agent:unknown', name: 'Agent' }, operationId?: string): Promise<BrowserScriptRunReport> {
    const binding = this.bridge.require(id)
    if (binding.status !== 'ready' || !binding.connection) throw new Error(binding.warning ?? 'Reconnect the original shared tab before running a program.')
    if (this.active.has(id)) throw new Error('Another operation owns this shared tab. Wait for it to finish or stop it explicitly.')
    const connectionId = binding.connection.id
    const active: Active = { binding, operation: null, controller: new AbortController(), stopped: false }
    this.active.set(id, active) // Reserve this original binding before the first asynchronous journal write.
    let session: ExternalBrowserTargetSession | undefined
    let feedback: ReturnType<typeof showBrowserOperationFeedback> | undefined
    let feedbackEnded = false
    let release = () => {}
    const notes: string[] = []
    try {
      const operation = await this.stores.journal.start({ ...(operationId ? { id: operationId } : {}), browserId: id,
        operator, summary: 'Preparing shared-tab program', url: binding.url })
      active.operation = operation; this.operations.set(operation.id, active)
      const requireCurrent = (): void => {
        if (this.active.get(id) !== active || binding.status !== 'ready' || binding.connection?.id !== connectionId || active.controller.signal.aborted)
          throw new ExternalBrowserRequestFailure('The original shared tab stopped being available. No substitute is selected and actions are not replayed.', false)
      }
      requireCurrent()
      session = await attachExternalBrowserTarget(this.bridge, binding, { operationId: operation.id, callerId: operator.id })
      const attached = session
      release = this.bridge.observeAvailability(id, () => {
        if (binding.status !== 'ready' || binding.connection?.id !== connectionId) active.controller.abort()
      })
      operation.phase = 'running'; operation.summary = 'Agent is operating the shared tab'
      await this.stores.journal.setPhase(operation.id, 'running', { summary: operation.summary })
      let revision = 0
      let world: { navigationId: string; contextId: number } | null = null
      const ownedFeedback = feedback = showBrowserOperationFeedback({ operationId: operation.id, operatorName: operator.name,
        navigationId: () => binding.navigationId, nextRevision: () => ++revision,
        isCurrent: () => this.active.get(id) === active && binding.status === 'ready' && binding.connection?.id === connectionId && !active.stopped,
        contents: { isDestroyed: () => attached.endedReason !== null,
          executeJavaScriptInIsolatedWorld: async (_worldId, scripts) => {
            requireCurrent()
            if (!world || world.navigationId !== binding.navigationId) {
              const tree = await attached.sendCommand('Page.getFrameTree') as { frameTree: { frame: { id: string } } }
              const created = await attached.sendCommand('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id,
                worldName: BROWSER_OPERATION_FEEDBACK_WORLD_NAME }) as { executionContextId: number }
              requireCurrent(); world = { navigationId: binding.navigationId, contextId: created.executionContextId }
            }
            const result = await attached.sendCommand('Runtime.evaluate', { contextId: world.contextId,
              expression: `(()=>{let value;${scripts.map(script => `value=(${script.code});`).join('\n')}return {value,revision:(${buildBrowserOperationFeedbackRevisionScript()})}})()`, returnByValue: true }) as { result?: { value?: { value?: unknown; revision?: unknown } }; exceptionDetails?: unknown }
            if (result.exceptionDetails) throw new Error('Shared-tab action feedback could not be displayed.')
            const observed = result.result?.value?.revision
            if (typeof observed === 'number' && Number.isSafeInteger(observed) && observed >= 0) revision = Math.max(revision, observed)
            return result.result?.value?.value
          } },
        warn: () => { operation.warning ??= 'Action feedback is unavailable. The shared page and Agent remain usable; inspect the operation history.' } })
      const dispatch = createBrowserPageDispatch({ session: attached,
        beforeAction: requireCurrent,
        pageInfo: () => { requireCurrent(); return binding },
        gotoUrl: async (url: string) => { requireCurrent(); await this.navigate(binding, attached, url, active.controller.signal); requireCurrent() },
        captureScreenshot: async () => {
          requireCurrent(); const navigationId = binding.navigationId
          const result = await attached.sendCommand('Page.captureScreenshot', { format: 'png' }) as { data: string }
          requireCurrent(); if (binding.navigationId !== navigationId) throw new ExternalBrowserRequestFailure('The original document changed during screenshot capture.', true)
          return { browserId: id, navigationId, image: this.stores.decodeScreenshot(result.data) }
        },
        uploads: { store: this.stores.uploads, context: () => { requireCurrent(); return {
          workspaceId: binding.workspaceId, browserId: id, operationId: operation.id, navigationId: binding.navigationId, documentSurvivesClient: true,
          currentNavigationId: () => { requireCurrent(); return binding.navigationId }
        } } },
        structuredOutput: { source: () => { requireCurrent(); return { workspaceId: binding.workspaceId,
          browserId: id, operationId: operation.id, navigationId: binding.navigationId } },
          isCurrent: (navigationId: string) => binding.status === 'ready' && binding.connection?.id === connectionId && binding.navigationId === navigationId },
        resultArtifacts: { store: this.stores.results, owner: { workspaceId: binding.workspaceId, browserId: id } },
        readLedger: async () => binding.ledgerNavigationId === binding.navigationId ? await this.stores.refs.read(id) : null,
        writeLedger: async (ledger: import('./browser-ref-ledger.js').BrowserRefLedger) => { const navigationId = binding.navigationId; await this.stores.refs.write(id, ledger);
          requireCurrent(); if (navigationId === binding.navigationId) this.bridge.recordLedger(id, navigationId) },
        note: (text: string) => { notes.push(text); operation.warning = notes.join('\n') } })
      const resultNavigationId = binding.navigationId
      const run = await runBrowserScript({ code, signal: active.controller.signal,
        captureResultArtifact: path => this.stores.results.import({ workspaceId: binding.workspaceId, browserId: id,
          operationId: operation.id, navigationId: resultNavigationId }, path),
        onPageCall: async (method, args) => {
          requireCurrent()
          const currentStep = startBrowserOperationStep(operation, method, args)
          await this.stores.journal.startStep(operation.id, { method, label: currentStep.label,
            ...(currentStep.ref ? { ref: currentStep.ref } : {}), ...(currentStep.replay ? { replay: currentStep.replay } : {}) })
          if (waits.has(method)) await this.stores.journal.setPhase(operation.id, 'waiting', { summary: `Waiting: ${method}` })
          let cue: number | undefined
          try {
            if (actions.has(method)) { requireCurrent(); cue = await ownedFeedback.begin(method, method === 'pressKey' ? args[1] : undefined); requireCurrent() }
            else await ownedFeedback.clear(waits.has(method) ? 'invalidate' : 'replace')
            const value = await dispatch(method, args, { beforeAction: requireCurrent, recordTarget: target => { currentStep.target = target },
              ...(cue === undefined ? {} : { feedback: async (node, sender) => { requireCurrent(); await ownedFeedback.showTarget(node, sender, cue); requireCurrent() } }) })
            if (cue !== undefined) await ownedFeedback.completeAction(cue)
            currentStep.status = 'completed'; currentStep.summary = summarizeBrowserValue(value); currentStep.finishedAt = Date.now()
            const content = method === 'snapshot' ? pageStepEvidence(value as BrowserPageSnapshot) :
              method === 'captureScreenshot' ? screenshotStepEvidence(value as BrowserScreenshotCapture) :
              method === 'extractStructured' ? { kind: 'structured-output' as const, receipt: value as BrowserStructuredOutputReceipt } : null
            if (content) {
              const navigationId = content.kind === 'structured-output' ? content.receipt.source.navigationId : (value as BrowserPageSnapshot | BrowserScreenshotCapture).navigationId
              try { currentStep.evidence = [await this.stores.evidence.write({ operationId: operation.id, sequence: currentStep.sequence, browserId: id, navigationId }, content)] }
              catch { currentStep.evidenceWarning = 'Step evidence could not be saved. The action result remains; inspect the original page and local storage.'; operation.warning ??= currentStep.evidenceWarning }
            }
            await this.stores.journal.finishStep(operation.id, currentStep.sequence, { status: 'completed', summary: currentStep.summary,
              ...(currentStep.evidence ? { evidence: currentStep.evidence } : {}), ...(currentStep.evidenceWarning ? { evidenceWarning: currentStep.evidenceWarning } : {}),
              ...(currentStep.target ? { target: currentStep.target } : {}) })
            return value
          } catch (error) {
            if (error instanceof ExternalBrowserRequestFailure && error.uncertain) notes.push(error.message)
            currentStep.status = active.stopped ? 'stopped' : 'failed'; currentStep.finishedAt = Date.now()
            currentStep.summary = error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240)
            await this.stores.journal.finishStep(operation.id, currentStep.sequence, { status: currentStep.status, summary: currentStep.summary })
            throw error
          } finally {
            if (waits.has(method) && !active.controller.signal.aborted) await this.stores.journal.setPhase(operation.id, 'running', { summary: 'Agent is operating the shared tab' })
          }
        } })
      await ownedFeedback.end(run.completed && attached.endedReason === null && !active.stopped)
      feedbackEnded = true
      const uncertain = attached.endedReason ?? (binding.connection?.id !== connectionId || binding.status !== 'ready' ? binding.warning : undefined)
      const outcome = active.stopped ? { kind: 'stopped' as const, message: 'The person stopped the shared-tab operation. Sharing must be granted explicitly before another action.' } :
        uncertain || notes.length ? { kind: 'indeterminate' as const, message: [uncertain, ...notes].filter(Boolean).join('\n') } :
          run.completed ? { kind: 'completed' as const } : browserRunOutcomeFromFailure(run.failure)
      operation.phase = browserOperationPhaseFromOutcome(outcome.kind); operation.finishedAt = Date.now()
      operation.summary = 'message' in outcome ? outcome.message : 'Shared-tab program completed'
      if ('message' in outcome) operation.warning = outcome.message
      return { result: run.completed ? run.value : undefined, logs: run.logs, outcome, runOperation: operation }
    } catch (error) {
      if (!active.operation) throw error
      const uncertain = error instanceof ExternalBrowserRequestFailure && error.uncertain
      const outcome = { kind: active.stopped ? 'stopped' as const : uncertain ? 'indeterminate' as const : 'script-failed' as const,
        message: error instanceof Error ? error.message : String(error) }
      active.operation.phase = browserOperationPhaseFromOutcome(outcome.kind)
      active.operation.summary = outcome.message; active.operation.warning = outcome.message; active.operation.finishedAt = Date.now()
      return { result: undefined, logs: [], outcome, runOperation: active.operation }
    } finally {
      if (!feedbackEnded) await feedback?.end(false)
      release()
      const warning = await session?.detach()
      const operation = active.operation
      if (warning && operation) operation.warning ??= warning
      if (operation) {
        this.operations.delete(operation.id)
        await this.stores.journal.finish(operation.id, operation.phase === 'preparing' || operation.phase === 'running' || operation.phase === 'waiting' || operation.phase === 'human' ? 'indeterminate' : operation.phase,
          { summary: operation.summary, ...(operation.warning ? { warning: operation.warning } : {}) })
        const persistenceWarning = this.stores.journal.getPersistenceWarning()
        if (persistenceWarning) operation.warning ??= persistenceWarning
      }
      if (this.active.get(id) === active) this.active.delete(id)
    }
  }
  async dispose(): Promise<void> {
    for (const active of this.active.values()) active.controller.abort()
    await this.bridge.dispose()
  }
}
