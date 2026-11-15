import { installBrowserPageInterrupts, isBrowserPageDialogAnswer, BROWSER_PAGE_MAIN_READS, type BrowserPageInterrupts } from './browser-page-interrupts.js'
import { browserPageCapabilityNames } from '@agentmux/core'
import { capturePageImage, PNG_MAX_BASE64_CHARS } from '@agentmux/native-desktop/image'
import { readScreenshotObservation, readScreenshotViewport, screenshotSource } from './browser-screenshot-source.js'
import { prepareBrowserScreenshot } from './browser-screenshot-options.js'
import type { BrowserPng, BrowserScriptRunReport, BrowserPageSnapshot, BrowserScreenshotCapture } from './model/page.js'
import type { BrowserResultReadOptions, BrowserResultArtifactChunk } from './model/browser-result-artifact.js'
import type { BrowserStructuredOutputReceipt } from './model/browser-structured-output.js'
import { BrowserStepEvidenceStore, pageStepEvidence, screenshotStepEvidence } from './browser-step-evidence.js'
import type { BrowserOperation, BrowserOperator, BrowserOperationStep } from './model/browser-operation.js'
import { BrowserRequestFailure, type BrowserProgramPort, type BrowserProgramTarget, type BrowserProgramSession, type BrowserProgramFeedback } from './browser-program-port.js'
import { createBrowserPageDispatch } from './browser-page-dispatch.js'
import { runBrowserScript } from './browser-script-runner.js'
import { browserOperationPhaseFromOutcome, browserRunOutcomeFromFailure } from './browser-run-outcome.js'
import { finishBrowserProgramReceipt, finishBrowserProgramStep } from './browser-program-completion.js'
import { recordBrowserOperationTarget, startBrowserOperationStep, summarizeBrowserValue } from './browser-operation-step.js'
import type { BrowserOperationJournal } from './browser-operation-journal.js'
import type { BrowserRefLedgerStore } from './browser-ref-ledger-store.js'
import type { BrowserResultArtifactStore } from './browser-result-artifact.js'
import type { BrowserUploadPort } from './browser-file-port.js'

const actions = new Set([...browserPageCapabilityNames('act'), ...browserPageCapabilityNames('navigate')])
const waits = new Set(browserPageCapabilityNames('wait'))
type Active = { binding: BrowserProgramTarget; operation: BrowserOperation | null; controller: AbortController; stopped: boolean; stoppedMessage?: string }
type Stores = { journal: BrowserOperationJournal; refs: Pick<BrowserRefLedgerStore, 'read' | 'write'>;
  results: BrowserResultArtifactStore; evidence: BrowserStepEvidenceStore; uploads?: (target: BrowserProgramTarget, operation: BrowserOperation, current: () => void) => BrowserUploadPort; validateScreenshot(image: BrowserPng): void }

/** An external page owner, using the existing runner, dispatch, journal and payload owners.
 * It never supplies a pretend WebContentsView, creates a browser, or manages an Agent Run.
 */
export class BrowserProgramOwner {
  private readonly active = new Map<string, Active>()
  private readonly operations = new Map<string, Active>()
  constructor(readonly bridge: BrowserProgramPort, private readonly stores: Stores) {}
  has(id: string): boolean { return this.bridge.has(id) }
  async stopOperationById(id: string): Promise<BrowserOperation | null> {
    const active = this.operations.get(id)
    if (!active) return null
    active.stopped = true
    active.controller.abort()
    const stopped = this.bridge.stopOperation(active.binding.id)
    if (stopped) active.stoppedMessage = stopped.message
    return await this.stores.journal.get(id)
  }
  async readStepResult(operationId: string, sequence: number, options?: BrowserResultReadOptions): Promise<BrowserResultArtifactChunk> {
    const operation = await this.stores.journal.get(operationId)
    if (!operation) throw new Error('This operation has no retained structured result.')
    const step = operation.steps.find(item => item.sequence === sequence)
    if (step?.method !== 'extractStructured') throw new Error('This step has no retained structured result.')
    const references = step.evidence?.filter(item => item.kind === 'structured-output') ?? []
    const reference = references[0]
    if (references.length !== 1 || !reference || reference.operationId !== operationId || reference.sequence !== sequence || reference.browserId !== operation.browserId) throw new Error('The recorded structured result is unavailable.')
    const item = await this.stores.evidence.read(reference)
    if (item.content.kind !== 'structured-output') throw new Error('The recorded result is not a structured extraction.')
    const { source, artifact, artifactStatus } = item.content.receipt
    if (artifactStatus !== 'available' || !artifact || source.operationId !== operationId || source.browserId !== operation.browserId ||
      !source.workspaceId || source.navigationId !== reference.navigationId || artifact.operationId !== source.operationId ||
      artifact.browserId !== source.browserId || artifact.workspaceId !== source.workspaceId || artifact.navigationId !== source.navigationId) throw new Error('The result does not belong to this recorded extraction.')
    // The original host-generated, journal-linked source remains authoritative without a live connection.
    return await this.stores.results.read(artifact, { workspaceId: source.workspaceId, browserId: source.browserId }, options)
  }
  private async navigate(binding: BrowserProgramTarget, session: BrowserProgramSession, url: string, signal: AbortSignal): Promise<void> {
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
    const aborted = (): void => fail(new BrowserRequestFailure('Browser navigation was interrupted before its result was confirmed. Inspect the original document before retrying.', true))
    const timer = setTimeout(() => fail(new BrowserRequestFailure('Browser navigation did not finish within its observation budget. Inspect the original tab; no navigation is replayed.', true)), 30_000)
    signal.addEventListener('abort', aborted, { once: true })
    try {
      // Start an error handler before the command await, avoiding an unhandled cancellation race.
      const navigation = session.sendCommand('Page.navigate', { url }).then(value => {
        const result = value as { loaderId?: string; errorText?: string }
        if (result.errorText) throw new Error(`Browser navigation failed: ${result.errorText}`)
        expected = result.loaderId; acknowledged = true; check()
      })
      await Promise.all([navigation, settled])
    } finally { clearTimeout(timer); release(); signal.removeEventListener('abort', aborted) }
  }
  async runScript(id: string, code: string, operator: BrowserOperator = { id: 'agent:unknown', name: 'Agent' }, operationId?: string): Promise<BrowserScriptRunReport> {
    const binding = this.bridge.require(id)
    if (binding.status !== 'ready' || !binding.connection) throw new Error(binding.warning ?? 'Reconnect the original Browser before running a program.')
    if (this.active.has(id)) throw new Error('Another operation owns this Browser. Wait for it to finish or stop it explicitly.')
    const connectionId = binding.connection.id
    const active: Active = { binding, operation: null, controller: new AbortController(), stopped: false }
    this.active.set(id, active) // Reserve this original binding before the first asynchronous journal write.
    let session: BrowserProgramSession | undefined
    let interrupts: BrowserPageInterrupts | undefined
    let feedback: BrowserProgramFeedback | undefined
    const pageCleanups: (() => Promise<void>)[] = []
    let release = () => {}
    const notes: string[] = []
    try {
      const operation = await this.stores.journal.start({ ...(operationId ? { id: operationId } : {}), browserId: id,
        operator, summary: 'Preparing Browser program', url: binding.url })
      active.operation = operation; this.operations.set(operation.id, active)
      const requireCurrent = (): void => {
        if (this.active.get(id) !== active || binding.status !== 'ready' || binding.connection?.id !== connectionId || active.controller.signal.aborted)
          throw new BrowserRequestFailure('The original Browser stopped being available. No substitute is selected and actions are not replayed.', false)
      }
      requireCurrent()
      session = await this.bridge.attach(binding, { operationId: operation.id, callerId: operator.id })
      const attached = session
      interrupts = installBrowserPageInterrupts(attached, { signal: active.controller.signal })
      await interrupts.ready()
      if (!interrupts.observing()) operation.warning = 'Page dialog observation is unavailable. The Browser remains usable; a dialog approval is unknown, while cancellation remains available.'
      release = this.bridge.observeAvailability(id, () => {
        if (binding.status !== 'ready' || binding.connection?.id !== connectionId) active.controller.abort()
      })
      operation.phase = 'running'; operation.summary = 'Agent is operating the Browser'
      await this.stores.journal.setPhase(operation.id, 'running', { summary: operation.summary, ...(operation.warning ? { warning: operation.warning } : {}) })
      const ownedFeedback = feedback = this.bridge.feedback?.(binding, attached, operation, requireCurrent) ?? {
        begin: async () => undefined, clear: async () => {}, observe: async () => {}, showTarget: async () => {}, completeAction: async () => {}, end: async () => {}
      }
      let runBudget: { remainingMillis(): number } | undefined
      const dispatch = createBrowserPageDispatch({ session: attached, signal: active.controller.signal, interrupts, remainingMillis: () => runBudget?.remainingMillis() ?? 0,
        registerCleanup: cleanup => pageCleanups.push(cleanup),
        beforeAction: requireCurrent,
        pageInfo: () => { requireCurrent(); return { url: binding.url, title: binding.title, navigationId: binding.navigationId } },
        gotoUrl: async (url: string) => { requireCurrent(); await this.navigate(binding, attached, url, active.controller.signal); requireCurrent() },
        captureScreenshot: async (options = {}) => {
          requireCurrent(); const navigationId = binding.navigationId
          const observed = await readScreenshotObservation(async () => {
            const value = await attached.sendCommand('Runtime.evaluate', { expression: '({url:location.href,title:document.title})', returnByValue: true }) as { result?: { value?: unknown } }
            return value.result?.value
          })
          const info = observed && typeof observed === 'object' ? observed as Record<string, unknown> : {}
          const url = typeof info.url === 'string' ? info.url : null, title = typeof info.title === 'string' ? info.title : null
          const readViewport = () => readScreenshotViewport(async () => {
            const metrics = await attached.sendCommand('Runtime.evaluate', { expression: '({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio})', returnByValue: true }) as { result?: { value?: unknown } }
            return metrics.result?.value
          })
          const before = await readViewport()
          const prepared = await prepareBrowserScreenshot(attached.sendCommand, options, before)
          requireCurrent()
          const image = await capturePageImage({ capture: async () => {
            const result = await attached.sendCommand('Page.captureScreenshot', prepared.parameters) as { data?: unknown }
            const data = result?.data
            if (typeof data !== 'string' || !data.length || data.length > PNG_MAX_BASE64_CHARS) throw new Error('Browser screenshot must contain bounded base64 PNG data.')
            const bytes = Buffer.from(data, 'base64')
            if (bytes.toString('base64') !== data) throw new Error('Browser screenshot must contain canonical base64 PNG data.')
            return { png: bytes }
          } })
          const after = await readViewport()
          requireCurrent(); if (binding.navigationId !== navigationId) throw new BrowserRequestFailure('The original document changed during screenshot capture.', true)
          this.stores.validateScreenshot(image)
          return { browserId: id, navigationId, source: { ...screenshotSource(url, title, before, after), region: prepared.region, hostOverlays: 'unconfirmed' }, image }
        },
        ...(this.stores.uploads ? { uploads: this.stores.uploads(binding, operation, requireCurrent) } : {}),
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
        onPageCall: async (method, args, budget) => {
          runBudget = budget
          requireCurrent()
          const currentStep = startBrowserOperationStep(operation, method, args)
          await this.stores.journal.startStep(operation.id, { method, label: currentStep.label,
            ...(currentStep.ref ? { ref: currentStep.ref } : {}), ...(currentStep.replay ? { replay: currentStep.replay } : {}) })
          if (waits.has(method)) await this.stores.journal.setPhase(operation.id, 'waiting', { summary: `Waiting: ${method}` })
          let cue: number | undefined
          try {
            if (actions.has(method)) { requireCurrent(); cue = await ownedFeedback.begin(method, method === 'pressKey' ? args[1] : undefined); requireCurrent() }
            else if (waits.has(method)) await ownedFeedback.clear()
            else await ownedFeedback.observe()
            const call = () => dispatch(method, args, { beforeAction: requireCurrent, recordTarget: (target, endpoint) => recordBrowserOperationTarget(currentStep, target, endpoint),
              ...(cue === undefined ? {} : { feedback: async (node, sender) => { requireCurrent(); await ownedFeedback.showTarget(node, sender, cue); requireCurrent() } }) })
            const value = interrupts && !isBrowserPageDialogAnswer(method, args) && !BROWSER_PAGE_MAIN_READS.has(method)
              ? await interrupts.race(call, () => actions.has(method)) : await call()
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
            if (error instanceof BrowserRequestFailure && error.uncertain) notes.push(error.message)
            currentStep.status = active.stopped ? 'stopped' : 'failed'; currentStep.finishedAt = Date.now()
            currentStep.summary = error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240)
            await this.stores.journal.finishStep(operation.id, currentStep.sequence, { status: currentStep.status, summary: currentStep.summary })
            throw error
          } finally {
            if (waits.has(method) && !active.controller.signal.aborted) await this.stores.journal.setPhase(operation.id, 'running', { summary: 'Agent is operating the Browser' })
          }
        } })
      const uncertain = attached.endedReason ?? (binding.connection?.id !== connectionId || binding.status !== 'ready' ? binding.warning : undefined)
      const outcome = active.stopped ? { kind: 'stopped' as const, message: active.stoppedMessage ?? 'The Browser operation was stopped. Inspect the original Browser before another action.' } :
        uncertain || notes.length ? { kind: 'indeterminate' as const, message: [uncertain, ...notes].filter(Boolean).join('\n') } :
          run.completed ? { kind: 'completed' as const } : browserRunOutcomeFromFailure(run.failure, operation.steps)
      operation.phase = browserOperationPhaseFromOutcome(outcome.kind); operation.finishedAt = Date.now()
      operation.summary = 'message' in outcome ? outcome.message : 'Browser program completed'
      if ('message' in outcome) operation.warning = outcome.message
      return { result: run.completed ? run.value : undefined, logs: run.logs, outcome, runOperation: operation }
    } catch (error) {
      if (!active.operation) throw error
      const uncertain = error instanceof BrowserRequestFailure && error.uncertain
      const outcome = { kind: active.stopped ? 'stopped' as const : uncertain ? 'indeterminate' as const : 'script-failed' as const,
        message: error instanceof Error ? error.message : String(error) }
      active.operation.phase = browserOperationPhaseFromOutcome(outcome.kind)
      active.operation.summary = outcome.message; active.operation.warning = outcome.message; active.operation.finishedAt = Date.now()
      return { result: undefined, logs: [], outcome, runOperation: active.operation }
    } finally {
      active.controller.abort()
      const operation = active.operation
      for (const cleanup of pageCleanups) await finishBrowserProgramStep(operation, 'page resource release', cleanup)
      if (feedback) await finishBrowserProgramStep(operation, 'feedback cleanup', () => feedback?.end(operation?.phase === 'completed'))
      await finishBrowserProgramStep(operation, 'availability subscription release', release)
      if (interrupts) await finishBrowserProgramStep(operation, 'dialog observer release', () => interrupts?.dispose())
      if (session) await finishBrowserProgramStep(operation, 'debugger detach', () => session?.detach())
      if (this.active.get(id) === active) this.active.delete(id)
      if (operation) {
        this.operations.delete(operation.id)
        await finishBrowserProgramReceipt(this.stores.journal, operation)
      }
    }
  }
  async dispose(): Promise<void> {
    for (const active of this.active.values()) active.controller.abort()
    await this.bridge.dispose()
  }
}
