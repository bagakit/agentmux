import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { CtxmuxClient } from '@ctxmux/sdk'
import { AgentMuxFileAgentSessionStore, connectAgentMuxRpc, defaultAgentMuxControlSocketPath,
  defaultCtxmuxSocketPath, loadAgentSessions, startHeadlessAgentMux,
  type AgentSessionHistoryItem } from '@agentmux/core'
import { openDemandStore } from '@agentmux/demand'
import { ConfigStore, DEFAULT_CONFIG } from '../../../src/main/config-store'
import { RuntimeController } from '../../../src/main/runtime-controller'
import { connectDesktopAgentMuxHost, desktopBusinessSocketPath } from '../../../src/main/desktop-host'
import { ScratchTopics } from '../../../src/main/scratch-topics'
import { registerIpc } from '../../../src/main/ipc'
import { ContinuousProgressLoopManager } from '../../../src/main/continuous-progress-loop-manager'
import { ContinuousProgressLoopStore } from '../../../src/main/continuous-progress-loop-store'
import { deliverContinuousProgress } from '../../../src/main/continuous-progress-delivery'
import type { AppConfig } from '../../../src/shared/contracts'
import { durableWriteFile } from '../../../../../packages/core/src/durable-write'

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const text = (item: AgentSessionHistoryItem) => item.contentParts.filter(part => part.kind === 'text').map(part => part.text).join('\n')
const privateScope = 'This is a bounded private verification: use only this Mote and its synthetic local materials. Do not start another Agent/model, contact external services, send messages, or inspect authentication/configuration files. '

/** Private driver only: all business and Agent operations use the original Main/App owners. */
export async function runModelOwner(input: { html: string; preload: string; root: string; evidence: string;
  command: string; codexArgs: string[]; nativeReadArgs: string[]; cli: string; hook: string; decisionFile: string }): Promise<boolean> {
  assert.equal(process.env.AGENTMUX_RUNTIME_DIRECTORY, join(input.root, 'runtime'), 'Only the original explicit private Runtime may be observed or stopped')
  assert.ok(process.env.CODEX_HOME?.startsWith(input.root + '/'), 'Only an authorized private auth scope may enter Main')
  const result: any = { schema: 'agentmux.mote.real-model-owner.v1', taskId: 'T-008', passed: false,
    pid: process.pid, turns: [], attempts: [], inputRequests: [], rejectedInputs: [], protocolWrites: [], currentReads: [], editorSaves: [],
    userRunTouched: false, modelTurns: 0, attemptedModelRequests: 0, admittedModelRequests: 0, completedModelTurns: 0 }
  const store = new AgentMuxFileAgentSessionStore(process.env.AGENTMUX_AGENT_SESSION_STORE!)
  const topics = new ScratchTopics(), configStore = new ConfigStore()
  const runtime = new RuntimeController(store, connectDesktopAgentMuxHost, topics)
  const goals = openDemandStore({ root: join(app.getPath('userData'), 'demands') })
  const manager = new ContinuousProgressLoopManager(ContinuousProgressLoopStore.forUserData(app.getPath('userData')),
    (loop, op, current, signal) => deliverContinuousProgress(runtime, loop, op, current, signal), undefined,
    (loop, op, now, signal) => runtime.observeContinuousProgress(loop, op, now, signal),
    { saveFutureIntent: (loop, active, context) => runtime.saveFutureIntent(loop, active, context),
      authorizeFutureIntent: (target, context) => runtime.authorizeFutureIntent(target, context),
      observeCheckIn: async (target, now, signal) => runtime.observeCheckIn(target, now, signal, await configStore.get()) },
    { read: id => goals.get(id), subscribe: fn => goals.subscribe(snapshot => fn(snapshot.demands)), inspectInitial: loop => runtime.inspectContinuousProgressInitial(loop) })
  let win: BrowserWindow | undefined, host: Awaited<ReturnType<typeof startHeadlessAgentMux>> | undefined
  let disposeIpc: (() => Promise<void>) | undefined, config: AppConfig
  const native = new CtxmuxClient({ socketPath: defaultCtxmuxSocketPath() })
  const outputs = new Map<string, string>(), observations: Array<{ runId: string; close(): Promise<void> }> = []
  const owned = new Map<string, { runId: string; workspacePath: string }>()
  const inflight = new Set<Promise<unknown>>()
  let gateClosed = false, activeTurn: any, budgetWrite = Promise.resolve(), emergencyStop: Promise<void> | undefined
  const persistBudget = () => {
    const bytes = JSON.stringify({ schema: 'agentmux.mote.model-input-budget.v1', taskId: 'T-008', pid: process.pid, gateClosed,
      modelTurns: result.modelTurns, attemptedModelRequests: result.attemptedModelRequests,
      admittedModelRequests: result.admittedModelRequests, completedModelTurns: result.completedModelTurns,
      attempts: result.attempts, inputRequests: result.inputRequests, rejectedInputs: result.rejectedInputs, protocolWrites: result.protocolWrites }, null, 2)
    return budgetWrite = budgetWrite.then(() => durableWriteFile(join(input.evidence, 'model-budget.json'), bytes, { requireDirectorySync: true }))
  }
  const tracked = <T>(operation: Promise<T>): Promise<T> => {
    inflight.add(operation); void operation.then(() => inflight.delete(operation), () => inflight.delete(operation))
    return operation
  }
  const closeGate = (reason: string) => {
    gateClosed = true
    if (activeTurn) { activeTurn.attempt.failure = reason; activeTurn.controller.abort(Error(reason)); activeTurn.reject(Error(reason)) }
  }
  async function rejectInput(method: string): Promise<never> {
    result.rejectedInputs.push({ method, at: Date.now(), turn: activeTurn?.attempt.number ?? null })
    closeGate('An input outside the five authorized private requests was attempted: ' + method)
    await persistBudget()
    throw Error(result.attempts.at(-1)?.failure ?? 'Private model input admission is closed')
  }
  /** Observe and bound original public input methods; no process, receipt or delivery is substituted. */
  function installInputFence() {
    const client = host!.client, create = client.createAgentWithDelivery.bind(client), submit = client.submitAgentPrompt.bind(client), write = client.writeAgent.bind(client)
    const request = async (method: 'createAgentWithDelivery' | 'submitAgentPrompt', value: any, original: (value: any) => Promise<any>) => {
      const turn = activeTurn
      if (gateClosed || !turn || turn.attempt.requestIndex !== undefined || result.attemptedModelRequests >= 5 ||
          turn.attempt.kind !== (method === 'createAgentWithDelivery' ? 'launch' : 'prompt')) return rejectInput(method)
      assert.ok(value.agentSessionId && (value.createOperationId ?? value.operationId), 'Original input identity must be frozen before a model request')
      if (method === 'createAgentWithDelivery') assert.ok(value.workspacePath.startsWith(input.root + '/'))
      else assert.equal(value.agentSessionId, turn.attempt.agentSessionId)
      const record: any = { index: result.inputRequests.length + 1, number: turn.attempt.number, method,
        operationId: value.createOperationId ?? value.operationId, agentSessionId: value.agentSessionId,
        enteredAt: Date.now(), phase: 'before-original-input', admission: 'unknown', promptSha256: hash(value.prompt),
        ...(value.expectedRun ? { expectedRun: value.expectedRun } : {}) }
      turn.attempt.requestIndex = record.index; turn.attempt.phase = record.phase
      result.inputRequests.push(record); result.attemptedModelRequests++; result.modelTurns = result.attemptedModelRequests
      turn.arm(record.enteredAt)
      // This durable unknown is written before the original method can spawn or send Input.
      await persistBudget(); turn.controller.signal.throwIfAborted()
      record.phase = 'original-input-inflight'; await persistBudget()
      try {
        const receipt = await tracked(original(method === 'submitAgentPrompt' ? { ...value,
          signal: value.signal ? AbortSignal.any([value.signal, turn.controller.signal]) : turn.controller.signal } : value))
        record.phase = 'original-input-returned'; record.returnedAt = Date.now()
        if (method === 'createAgentWithDelivery') {
          record.creation = receipt.creation; record.run = receipt.session.run
          record.admission = receipt.creation.initialPrompt === 'confirmed' ? 'confirmed' : 'unknown'
          owned.set(receipt.session.agentSessionId, { runId: receipt.session.run.runId, workspacePath: receipt.session.workspacePath })
        } else {
          const observed = await client.statusAgent(value.agentSessionId)
          record.run = observed.run; record.promptCompletionAdmission = observed.session.promptCompletionAdmission
          record.terminalPromptSubmission = observed.session.terminalPromptSubmission
          const admission = observed.session.promptCompletionAdmission
          record.admission = admission?.submissionId === value.operationId && admission?.acknowledged === true ? 'confirmed' : 'unknown'
        }
        result.admittedModelRequests = result.inputRequests.filter((one: any) => one.admission === 'confirmed').length
        await persistBudget(); turn.controller.signal.throwIfAborted()
        return receipt
      } catch (error) {
        record.phase = 'failed-or-unconfirmed'; record.failedAt = Date.now(); record.error = (error as Error).message
        closeGate(record.error); await persistBudget(); throw error
      }
    }
    client.createAgentWithDelivery = value => request('createAgentWithDelivery', value, create)
    client.submitAgentPrompt = value => request('submitAgentPrompt', value, submit)
    // Read, Files, Goal bookkeeping, hooks and exact Stop remain original. Additional paid inputs are out of scope.
    client.createTerminal = () => rejectInput('createTerminal')
    client.writeTerminal = () => rejectInput('writeTerminal')
    client.writeAgent = value => tracked((async () => {
      if (value.source !== 'terminal-protocol') return rejectInput('writeAgent')
      const bytes = typeof value.data === 'string' ? Buffer.from(value.data, 'utf8') : Buffer.from(value.data)
      const record: any = { source: value.source, agentSessionId: value.agentSessionId, expectedRun: value.expectedRun,
        at: Date.now(), bytes: bytes.length, sha256: hash(bytes), qualification: 'Original trusted terminal reply source; no byte-grammar validation or model admission claimed' }
      result.protocolWrites.push(record); await persistBudget()
      try { const ack = await write(value); record.ack = ack; await persistBudget(); return ack }
      catch (error) { record.error = (error as Error).message; await persistBudget(); throw error }
    })())
    client.pasteAgent = () => rejectInput('pasteAgent')
    client.submitAgentMessage = () => rejectInput('submitAgentMessage')
    client.replySessionQuestion = () => rejectInput('replySessionQuestion')
    client.respondAgentInteraction = () => rejectInput('respondAgentInteraction')
    client.resumeAgent = () => rejectInput('resumeAgent')
    client.reopenAgent = () => rejectInput('reopenAgent')
    client.respawnAgent = () => rejectInput('respawnAgent')
    client.ensureAgentContinuity = () => rejectInput('ensureAgentContinuity')
    client.startDiscussion = () => rejectInput('startDiscussion')
    client.openDispatch = () => rejectInput('openDispatch')
    const launch = runtime.launchAgent.bind(runtime), prompt = runtime.submitPrompt.bind(runtime)
    runtime.launchAgent = (...args) => {
      if (gateClosed || activeTurn?.attempt.kind !== 'launch') return rejectInput('RuntimeController.launchAgent')
      return launch(...args)
    }
    runtime.submitPrompt = (...args) => {
      if (gateClosed || activeTurn?.attempt.kind !== 'prompt') return rejectInput('RuntimeController.submitPrompt')
      return prompt(...args)
    }
  }
  const read = (code: string): Promise<any> => tracked(win!.webContents.executeJavaScript(code))
  const call = (method: string, ...args: unknown[]) => read(`window.modelProof.${method}(...${JSON.stringify(args)})`)
  async function until<T>(readValue: () => Promise<T>, accepts: (value: T) => boolean, ms: number, label: string, signal?: AbortSignal): Promise<T> {
    const deadline = Date.now() + ms; let last: T | undefined
    do { signal?.throwIfAborted(); last = await readValue(); signal?.throwIfAborted(); if (accepts(last)) return last; await delay(40) } while (Date.now() < deadline)
    throw Object.assign(Error('Real Mote journey did not confirm ' + label), { observation: last })
  }
  async function currentRead(name: string) {
    const value = await call('readMaterial', name); result.currentReads.push({ name, observation: value })
    assert.equal(value.result.status, 'read', 'Actual file.read must confirm current saved bytes')
    assert.equal(value.result.document.revision, 'sha256:' + hash(value.result.document.content))
    return value
  }
  async function history(id: string, signal?: AbortSignal) {
    const pages = []; let cursor: string | null = null
    do {
      const page = await host!.client.sessionHistoryPage(id, { limit: 100, ...(cursor ? { cursor } : {}),
        ...(!cursor ? { refreshNativeSource: true, requireCurrentSource: true } : {}),
        commandOverride: input.command, args: input.nativeReadArgs, ...(signal ? { signal } : {}) })
      if (pages.length) assert.deepEqual(page.source, pages[0]!.source, 'Original history source changed between pages')
      assert.equal(page.agentSessionId, id); pages.push(page); cursor = page.nextCursor
      assert.ok(pages.length <= 10, 'Bounded synthetic native history must not walk unrelated history')
    } while (cursor)
    return { source: pages[0]!.source, pages, items: pages.flatMap(page => page.items) }
  }
  async function stopPrivateRuns() {
    // Original scheduling is stopped before any Run teardown; a late tick cannot race Stop.
    result.schedulingStopRequestedAt = Date.now()
    let schedulingDrained = false, schedulingError: unknown
    const schedulingStop = manager.stop().then(() => { schedulingDrained = true; result.schedulingStoppedAt = Date.now() }, error => { schedulingError = error })
    // stop() first disables/aborts its original scheduler, but its delivery ACK drain may still
    // be pending. Never put that drain ahead of actual Run Stop at the paid-request deadline.
    await Promise.resolve()
    const confirmed = await until(async () => {
      if (host) for (const saved of await loadAgentSessions(store)) {
        assert.ok(saved.workspacePath.startsWith(input.root + '/'), 'Foreign durable Session in this private scope')
        const current = await host.client.statusAgent(saved.agentSessionId)
        assert.equal(current.run.runId, saved.run.runId)
        for (const request of result.inputRequests.filter((one: any) => one.agentSessionId === saved.agentSessionId)) {
          const creation = current.session.creation, admission = current.session.promptCompletionAdmission
          request.cleanupObservation = { run: current.run, creation: current.session.creation,
            promptCompletionAdmission: current.session.promptCompletionAdmission, terminalPromptSubmission: current.session.terminalPromptSubmission }
          if (request.method === 'createAgentWithDelivery' && creation?.createOperationId === request.operationId &&
              creation?.initialPrompt === 'confirmed' || request.method === 'submitAgentPrompt' &&
              admission?.submissionId === request.operationId && admission?.acknowledged === true)
            request.admission = 'confirmed'
        }
        owned.set(saved.agentSessionId, { runId: saved.run.runId, workspacePath: saved.workspacePath })
        if (current.run.state === 'running') await host.client.stopAgent(saved.agentSessionId, saved.run)
      }
      // A launch may have spawned before its Core/Renderer receipt arrived. The same Native owner
      // exposes the original cwd and Run identity; these private orphans are stopped without inventing a Session.
      for (const row of await native.list()) {
        const actual = await native.status(row.id)
        const spec = actual.spec; assert.ok(spec && typeof spec.cwd === 'string', 'Original Native cwd is unknown')
        assert.ok(spec.cwd.startsWith(input.root + '/'), 'Foreign Native Run in this private Runtime')
        if (actual.state.type === 'running') await native.stop(await native.prepareStop(actual.id))
      }
      const runs = await Promise.all((await native.list()).map(async row => {
        const actual = await native.status(row.id)
        const spec = actual.spec; assert.ok(spec && typeof spec.cwd === 'string', 'Original Native cwd is unknown')
        assert.ok(spec.cwd.startsWith(input.root + '/'))
        return { runId: actual.id, pid: actual.pid, cwd: spec.cwd, state: actual.state }
      }))
      if (schedulingError) throw schedulingError
      return { observedAt: Date.now(), runs, inflight: inflight.size, schedulingDrained,
        stopped: schedulingDrained && inflight.size === 0 && runs.every(run => run.state.type !== 'running') }
    }, value => value.stopped, 25000, 'all exact private Native Runs ended and original requests settled')
    result.nativeCleanupConfirmation = confirmed
    await schedulingStop
    result.admittedModelRequests = result.inputRequests.filter((one: any) => one.admission === 'confirmed').length
    await persistBudget()
  }
  async function modelTurn(number: number, action: () => Promise<any>, existing?: any, calendarWait = false) {
    assert.equal(number, result.attempts.length + 1); assert.ok(number <= 5 && !gateClosed)
    const before = existing ? await host!.client.statusAgent(existing.control.agentSessionId) : null
    const beforeHistory = existing ? await history(existing.control.agentSessionId) : null
    const actionStartedAt = Date.now(), controller = new AbortController()
    const attempt: any = { number, kind: existing ? 'prompt' : 'launch', phase: calendarWait ? 'calendar-preparation-wait' : 'before-action',
      actionStartedAt, ...(existing ? { agentSessionId: existing.control.agentSessionId } : {}) }
    result.attempts.push(attempt)
    let timer: ReturnType<typeof setTimeout> | undefined, rejectDeadline!: (error: Error) => void
    const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject })
    const expire = (reason: string) => {
      if (controller.signal.aborted) return
      attempt.failedAt = Date.now(); attempt.phase = 'deadline-expired'; closeGate(reason)
      void persistBudget().catch(error => { result.budgetWriteError = error.message })
      emergencyStop ??= stopPrivateRuns(); void emergencyStop.catch(error => { result.deadlineCleanupError = error.message })
      rejectDeadline(Error(reason))
    }
    activeTurn = { attempt, controller, reject: rejectDeadline, arm(enteredAt: number) {
      attempt.inputEnteredAt = enteredAt
      attempt.deadlineAt = Math.min(attempt.deadlineAt ?? Infinity, enteredAt + 120000)
      clearTimeout(timer); timer = setTimeout(() => expire('Actual private model request exceeded its 120-second deadline'), Math.max(1, attempt.deadlineAt - Date.now()))
    } }
    // New launch action has the stricter whole-action upper bound. Civil calendar waiting is separate.
    if (!calendarWait) activeTurn.arm(actionStartedAt)
    else timer = setTimeout(() => expire('Calendar preparation/due wait did not settle; no further model request is authorized'), 110000)
    await persistBudget()
    try {
    const observed = tracked((async () => {
    const actionReceipt = await tracked(action()); controller.signal.throwIfAborted()
    assert.equal(typeof attempt.requestIndex, 'number', 'Action did not cross the actual guarded Core input entry')
    const request = result.inputRequests[attempt.requestIndex - 1], startedAt = request.enteredAt
    attempt.phase = 'awaiting-native-stop'; await persistBudget()
    const agent = actionReceipt.agent ?? existing
    assert.equal(agent?.kind, 'agent'); assert.ok(agent.control.agentSessionId && agent.control.run.runId)
    const id = agent.control.agentSessionId, run = agent.control.run
    assert.ok(agent.workspacePath.startsWith(input.root + '/'), 'Only this private Mote may launch a Run')
    owned.set(id, { runId: run.runId, workspacePath: agent.workspacePath })
    if (!outputs.has(id)) {
      outputs.set(id, '')
      const observation = await host!.client.observeAgentOutput(id, 0, event => {
        if (event.type === 'terminal-output' && event.run.runId === run.runId) outputs.set(id, outputs.get(id)! + event.data)
      })
      observations.push({ runId: run.runId, close: () => observation.close() })
    }
    const completion = await until(() => host!.client.statusAgent(id), value =>
      value.run.runId === run.runId && value.run.state === 'running' && value.session.nativeHandle?.kind === 'provider' &&
      value.session.hookReceipt?.eventName === 'Stop' && value.session.hookReceipt.run.runId === run.runId &&
      value.session.hookReceipt.id !== before?.session.hookReceipt?.id && value.session.terminalPromptReadiness?.source === 'native-stop',
      Math.max(1, attempt.deadlineAt - Date.now()), 'native Stop for turn ' + number, controller.signal)
    assert.ok(Date.now() - startedAt <= 120000, 'Real model turn exceeded its 120-second budget')
    const saved = await tracked(history(id, controller.signal)); controller.signal.throwIfAborted()
    const knownIds = new Set(beforeHistory?.items.map(item => item.id) ?? [])
    const items = saved.items.filter(item => !knownIds.has(item.id))
    const assistant = items.filter(item => item.kind === 'assistant-message' && text(item).trim())
    const tools = items.flatMap(item => item.contentParts.filter(part => part.kind === 'tool-call'))
    const toolResults = items.flatMap(item => item.contentParts.filter(part => part.kind === 'tool-result'))
    assert.ok(assistant.length && tools.length && toolResults.length, 'Native assistant/tool-call/tool-result evidence cannot be empty')
    const nativeRun = await native.status(run.runId)
    assert.equal(nativeRun.id, run.runId); assert.equal(nativeRun.spec?.cwd, agent.workspacePath)
    const cliPath = nativeRun.spec?.env.AGENTMUX_CLI, hookPath = input.hook
    assert.equal(cliPath, input.cli, 'Actual Core Run.env must export this original Source CLI')
    const environment = Object.fromEntries(['AGENTMUX_ENV', 'AGENTMUX_CLI', 'AGENTMUX_AGENT_SESSION_ID', 'AGENTMUX_RUN_ID'].map(key => [key, nativeRun.spec?.env[key] ?? null]))
    assert.equal(environment.AGENTMUX_ENV, '1'); assert.equal(environment.AGENTMUX_AGENT_SESSION_ID, id)
    const record = { number, requestIndex: request.index, actionStartedAt, startedAt, completedAt: Date.now(), agent, actionReceipt, before,
      completion, environment, cli: { path: cliPath, sha256: hash(await readFile(cliPath!)), hookPath, hookSha256: hash(await readFile(hookPath)) },
      nativeSource: saved.source, pages: saved.pages, items, tools, toolResults, assistant,
      outputPath: 'turn-' + number + '.output.txt', screenshot: { path: 'turn-' + number + '.png', sha256: '' } }
    await writeFile(join(input.evidence, record.outputPath), outputs.get(id)!)
    const png = (await win!.webContents.capturePage()).toPNG()
    controller.signal.throwIfAborted()
    record.screenshot.sha256 = hash(png); await writeFile(join(input.evidence, record.screenshot.path), png)
    assert.ok(Date.now() <= attempt.deadlineAt, 'Action/Stop/history/capture exceeded the complete request deadline')
    attempt.phase = 'completed'; attempt.completedAt = Date.now()
    result.turns.push(record); result.completedModelTurns = result.turns.length
    await writeFile(join(input.evidence, 'turn-' + number + '.json'), JSON.stringify(record, null, 2))
    await persistBudget()
    return record
    })())
    return await Promise.race([observed, deadline])
    } catch (error) {
      closeGate((error as Error).message); attempt.failedAt ??= Date.now()
      emergencyStop ??= stopPrivateRuns(); void emergencyStop.catch(error => { result.deadlineCleanupError = error.message })
      await persistBudget()
      await durableWriteFile(join(input.evidence, 'attempt-' + number + '.failed.json'), JSON.stringify({ attempt,
        request: result.inputRequests[attempt.requestIndex - 1] ?? null, error: (error as Error).message }, null, 2), { requireDirectorySync: true })
      throw error
    } finally { clearTimeout(timer); activeTurn = undefined }
  }
  try {
    assert.ok(process.env.CODEX_HOME?.startsWith(input.root + '/'), 'Only an authorized private auth scope may enter Main')
    const scratch = join(input.root, 'home/.agentmux/scratch'); await mkdir(scratch, { recursive: true })
    config = await configStore.save({ ...structuredClone(DEFAULT_CONFIG),
      workspaces: [{ id: '__scratch__', hostId: 'local', path: scratch, name: 'Private Mote', kind: 'folder' }],
      executors: { privateCodex: { label: 'Private real Codex', providerId: 'codex', command: input.command,
        args: input.codexArgs, env: {}, injectAgentMuxGuide: true } } })
    // Same typed forwarding seam as the original Host. No execute/opened/healthy response is fabricated.
    host = await startHeadlessAgentMux({ store, service: { forwardControl: async (method, params, context) => {
      const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: desktopBusinessSocketPath() },
        ...(context.caller ? { credentials: context.caller } : {}) })
      try { return await rpc.call(method, params, context.signal ? { signal: context.signal } : {}) }
      finally { await rpc.dispose() }
    } } })
    installInputFence()
    win = new BrowserWindow({ width: 1180, height: 860, show: false,
      webPreferences: { preload: input.preload, contextIsolation: true, sandbox: false, backgroundThrottling: false } })
    disposeIpc = await registerIpc({ window: win, configStore, runtime, progressLoops: manager, demands: goals, scratchTopics: topics })
    await manager.start(); await win.loadFile(input.html)
    await until(() => call('facts'), value => value.ready === true, 20000, 'original App initialization')
    result.original = await call('createMote')
    // Trust only the fresh synthetic Mote folders, using the provider's actual canonical cwd.
    const privateMotes = await realpath(join(input.root, 'home/.agentmux/motes'))
    const trustedMotes = []
    for (const entry of await readdir(privateMotes, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const cwd = await realpath(join(privateMotes, entry.name))
      assert.ok(cwd.startsWith(privateMotes + '/'))
      await appendFile(join(process.env.CODEX_HOME!, 'config.toml'), '\n[projects.' + JSON.stringify(cwd) + ']\ntrust_level = "trusted"\n')
      trustedMotes.push(cwd)
    }
    result.privateProviderPreparation = { trustedMotes, userConfigurationModified: false }
    const questionA = privateScope + 'For this synthetic private exercise, first use the actual exported "$AGENTMUX_CLI" to run whoami and --skill. Print only AGENTMUX_ENV, AGENTMUX_CLI, AGENTMUX_AGENT_SESSION_ID and AGENTMUX_RUN_ID as environment evidence. I prefer three concise bullets. My planning decision is a weekly Tuesday review using local Markdown. Save these facts in cooperation-record.md in this Mote, including the exact line "Meeting day: Tuesday". Read the saved file back and explain the source. Use tools; saying you remembered it is not a save.'
    const a = await modelTurn(1, () => call('discuss', questionA))
    const commandEvidence = JSON.stringify(a.tools)
    assert.match(commandEvidence, /whoami/); assert.match(commandEvidence, /--skill/)
    assert.ok(JSON.stringify(a.toolResults).includes(a.agent.control.agentSessionId), 'Actual Agent whoami result must identify this Session')
    await currentRead('cooperation-record.md')
    await modelTurn(2, () => call('discuss', privateScope + 'What would be a useful next planning step for me? Check the original saved materials, explain what facts you used and where they came from.', ['cooperation-record.md']))
    const correction = await call('correct', 'cooperation-record.md', 'Meeting day: Tuesday', 'Meeting day: Thursday'); result.editorSaves.push(correction)
    result.editorSaves.push(await call('feedback', 'Prefer one concrete small Markdown checklist with its path and one source note. Avoid broad reminders and repeated summaries.'))
    result.feedbackBeforeDiscussionC = await currentRead('SOUL.md')
    await modelTurn(3, () => call('discuss', privateScope + 'What should my next planning step be now? Read the current original SOUL and saved materials, explain their source and how they affect your suggestion.', ['cooperation-record.md']))
    const c = (await call('facts')).lastAgent
    // Actual original Calendar form and Save; one real future occurrence, no synthetic tick.
    result.calendarPreparation = await call('prepareCalendar', privateScope + 'Find one or two useful, small local Markdown planning improvements. Use the current public file.read and file.ls tools to inspect the original saved sources. Give each idea a source, reason and concrete next step. Do not implement anything yet.')
    const due = new Date(Date.now() + 65000), date = due.toISOString().slice(0, 10), time = due.toISOString().slice(11, 16)
    await read(`(() => { const set=(label,value)=>{const node=document.querySelector('[aria-label="'+label+'"]');if(!node)throw Error(label+' missing');const setter=Object.getOwnPropertyDescriptor(node instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set;setter.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));};set('Arrangement repeat','once');return true;})()`)
    await delay(50)
    await read(`(() => { const set=(label,value)=>{const node=document.querySelector('[aria-label="'+label+'"]');if(!node)throw Error(label+' missing');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));};set('Arrangement date',${JSON.stringify(date)});set('Arrangement time',${JSON.stringify(time)});set('Arrangement time zone','UTC');return true;})()`)
    let arrangement: ReturnType<ContinuousProgressLoopManager['list']>[number] | undefined
    await modelTurn(4, async () => {
      await read(`(() => {const save=[...document.querySelectorAll('button')].find(n=>n.textContent==='Save arrangement');if(!save||save.disabled)throw Error('Original Calendar Save unavailable');save.click();return true;})()`)
      arrangement = await until(async () => manager.list().find(loop => loop.calendar), Boolean, 20000, 'original saved Calendar arrangement', activeTurn.controller.signal)
      assert.equal(arrangement!.agentSessionId, c.control.agentSessionId)
      await until(async () => manager.list().find(loop => loop.loopId === arrangement!.loopId), loop => loop?.lastOutcome === 'sent', 90000, 'one actual Calendar occurrence', activeTurn.controller.signal)
      return { agent: c, schedule: manager.list().find(loop => loop.loopId === arrangement!.loopId) }
    }, c, true)
    result.arrangement = arrangement
    assert.match(JSON.stringify(result.turns[3].tools), /file\s+read/); assert.match(JSON.stringify(result.turns[3].tools), /file\s+ls/)
    const calendarRpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: desktopBusinessSocketPath() } })
    try { await calendarRpc.call('schedule.cancel', { scheduleId: arrangement!.loopId, expectedRevision: manager.list().find(loop => loop.loopId === arrangement!.loopId)!.revision!, operationId: 'private-model-cancel-after-one' }) }
    finally { await calendarRpc.dispose() }
    assert.ok(manager.list().every(loop => loop.status !== 'active'), 'The original once Calendar must have no active continuation')
    await manager.stop()
    result.schedulingClosedBeforeHumanChoice = { at: Date.now(), loops: manager.list() }
    const proposalSha256 = hash(await readFile(join(input.evidence, 'turn-4.json')))
    result.awaitingHumanChoice = { proposalSha256, decisionFile: input.decisionFile }
    await writeFile(join(input.evidence, 'human-choice-required.json'), JSON.stringify(result.awaitingHumanChoice, null, 2))
    const choice: any = await until(async () => readFile(input.decisionFile, 'utf8').then(JSON.parse).catch(error => {
      if (error.code === 'ENOENT') return null; throw error
    }), value => value !== null, 600000, 'human choice of the actual proposal (non-model window)')
    assert.equal(choice.taskId, 'T-008'); assert.equal(choice.proposalSha256, proposalSha256); assert.equal(choice.humanConfirmed, true)
    assert.ok(choice.authorizationEvidence?.trim())
    result.humanChoice = choice
    result.acceptedPrivateGoalInput = { ...choice, description: privateScope + choice.description }
    const accepted = await call('acceptIdea', result.acceptedPrivateGoalInput)
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: desktopBusinessSocketPath() } })
    try {
      await modelTurn(5, async () => ({ agent: c, result: await rpc.call('goal.start', { goalId: accepted.goalId,
        sessionId: c.control.agentSessionId, operationId: 'private-model-accepted-goal' }) }), c)
      result.goalAfter = await rpc.call('goal.inspect', { goalId: accepted.goalId })
      assert.ok(!manager.list().some(loop => loop.taskSource?.kind === 'goal' && loop.taskSource.goalId === accepted.goalId), 'Finite original goal.start must not create an automatic Goal loop')
    } finally { await rpc.dispose() }
    assert.equal(typeof choice.outputPath, 'string'); assert.ok(choice.outputPath && !choice.outputPath.startsWith('/') && !choice.outputPath.split('/').includes('..'))
    result.realOutcome = await currentRead(choice.outputPath)
    await currentRead('SOUL.md'); result.finalWorkbench = await call('save')
    const retained = result.finalWorkbench, original = result.turns[0].actionReceipt.original
    result.workfaceChecks = result.turns.slice(0, 3).map((turn: any) => {
      const selection = turn.actionReceipt.selection, region = retained.tabs[selection.tabId]?.regions[selection.regionId]
      assert.equal(region?.kind, 'agent'); assert.equal(region.sessionId, turn.agent.id)
      return { selection, sessionId: region.sessionId, preserved: true }
    })
    for (const [regionId, value] of Object.entries(original.drafts)) assert.equal(retained.drafts[regionId], value)
    result.originalUnsentDraftsPreserved = true
    assert.equal(result.attemptedModelRequests, 5); assert.equal(result.admittedModelRequests, 5); assert.equal(result.completedModelTurns, 5)
    assert.deepEqual(result.rejectedInputs, [])
    result.passed = true
  } catch (error) {
    closeGate((error as Error).message)
    emergencyStop ??= stopPrivateRuns(); void emergencyStop.catch(error => { result.deadlineCleanupError = error.message })
    await persistBudget().catch(error => { result.budgetWriteError = error.message })
    result.error = { message: (error as Error).message, stack: (error as Error).stack, observation: (error as any).observation }
    if (win && !win.isDestroyed()) result.failureWorkbench = await Promise.race([call('facts'), delay(2000).then(() => ({ error: 'Failure workbench observation is unavailable' }))]).catch(error => ({ error: error.message }))
  } finally {
    const errors: string[] = []
    closeGate('Private journey finished; no additional model input is authorized')
    try { await (emergencyStop ??= stopPrivateRuns()) } catch (error) { errors.push((error as Error).message) }
    result.artifactPreservation = []
    // Real failed requests retain their original output/history before private auth/runtime removal.
    // These are original read APIs, never another prompt or a replacement response.
    if (host && result.nativeCleanupConfirmation?.stopped === true) for (const [id, subject] of owned) {
      for (const kind of ['ordered-output', 'native-history'] as const) {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(Error('Private evidence read deadline')), 10000)
        try {
          const value = await tracked<unknown>(kind === 'ordered-output' ? host.client.readRunReplay({ runId: subject.runId }, 0, 'raw') : history(id, controller.signal))
          const path = 'retained-' + id + '-' + kind + '.json', bytes = JSON.stringify(value, null, 2)
          await durableWriteFile(join(input.evidence, path), bytes, { requireDirectorySync: true })
          result.artifactPreservation.push({ id, runId: subject.runId, kind, path, sha256: hash(bytes), status: 'read' })
        } catch (error) { result.artifactPreservation.push({ id, runId: subject.runId, kind, status: 'unavailable', error: (error as Error).message }) }
        finally { clearTimeout(timer) }
      }
    }
    for (const cleanup of [...observations.map(one => async () => {
      try { await one.close() } catch (error) {
        if ((error as Error).message !== 'attachment is already closed') throw error
        const actual = await native.status(one.runId)
        assert.equal(actual.id, one.runId)
        if (actual.state.type === 'running') throw error
        ;(result.alreadyClosedOutputObservations ??= []).push({ runId: one.runId, state: actual.state, reason: (error as Error).message })
      }
    }),
      () => win && !win.isDestroyed() ? call('dispose') : undefined, () => disposeIpc?.(), () => runtime.dispose(), () => host?.stop()]) {
      try { await cleanup() } catch (error) { errors.push((error as Error).message) }
    }
    if (win && !win.isDestroyed()) win.destroy()
    if (inflight.size) errors.push('Private observations remain in flight: ' + inflight.size)
    result.cleanup = { errors, exactPrivateRunsStopped: errors.length === 0 && result.nativeCleanupConfirmation?.stopped === true,
      ownedRuns: [...owned.entries()], nativeConfirmation: result.nativeCleanupConfirmation ?? null }
    if (errors.length) result.passed = false
    await writeFile(join(input.evidence, 'owner.json'), JSON.stringify(result, null, 2))
  }
  return result.passed
}
