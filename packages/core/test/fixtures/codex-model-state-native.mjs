import './model-state-main-bridge.mjs'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { promisify, stripVTControlCharacters } from 'node:util'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { activateRuntime } from '../../node_modules/@ctxmux/sdk/dist/index.js'
import headless from '@xterm/headless'
import { createModelStateMainBridge } from './model-state-main-bridge.mjs'

/** The same real Core, Runtime, native producer and TUI are shared with public/Renderer consumers. */
export async function createNativeModelStateFixture({ onRuntimeEvent } = {}) {
  const candidate = process.env.AMX_INFORMATION_CANDIDATE
  if (!candidate) throw new Error('The native model fixture requires the exact compiled candidate.')
  const core = await import(pathToFileURL(join(candidate, 'core/dist/index.js')).href)
  const { nativeProcessTcpListeners, nativeProcessExecutable } = await import(pathToFileURL(join(candidate, 'core/dist/agent-native-process.js')).href)
  const { connectCodexNativeActor } = await import(pathToFileURL(join(candidate, 'providers/dist/codex/native-rpc.js')).href)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-model-native-')))
  const home = join(root, 'home'), workspace = join(root, 'work'), runtime = join(root, 'r'), state = join(root, 's')
  for (const path of [home, workspace, runtime, state]) await mkdir(path, { mode: 0o700 })
  const previous = new Map(), change = (key, value) => {
    if (!previous.has(key)) previous.set(key, process.env[key])
    if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) change(key, undefined)
  for (const [key, value] of Object.entries({ HOME: home, CODEX_HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'), AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: state,
    AGENTMUX_AGENT_SESSION_STORE: join(state, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(state, 'messages.ndjson'),
    NODE_OPTIONS: '--import=' + pathToFileURL(resolve(import.meta.dirname, 'agent-information-loader.mjs')).href })) change(key, value)
  const proof = { version: '', setup: { purpose: 'Materialize the private original native thread so its actual remote TUI can join.', turns: null, modelHttpRequests: 0 },
    catalog: [], publications: [], terminalActions: [], cleanup: false }
  const disposers = [], waits = new Set(), outputListeners = new Set()
  let activation, client, original, connection, bridge, offline, closing, terminalOutput = ''
  const terminal = new headless.Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  let replaying = false, terminalReady = false, parserTail = Promise.resolve(), protocolTail = Promise.resolve()
  const liveFrames = []
  const screen = () => Array.from({ length: terminal.rows }, (_, index) =>
    terminal.buffer.active.getLine(terminal.buffer.active.baseY + index)?.translateToString(true) ?? '').join('\n')
  const sendProtocol = data => {
    if (replaying || !original) return
    protocolTail = protocolTail.then(async () => {
      await client.writeAgent({ agentSessionId: original.agentSessionId, expectedRun: original.run, source: 'terminal-protocol', data })
      proof.terminalProtocolReplies = (proof.terminalProtocolReplies ?? 0) + 1
    })
    void protocolTail.catch(() => {})
  }
  const terminalData = terminal.onData(sendProtocol)
  disposers.push(() => terminal.dispose(), () => terminalData.dispose())
  const parse = (bytes, historical = false) => {
    parserTail = parserTail.then(() => new Promise(done => {
      replaying = historical
      terminal.write(bytes, () => { replaying = false; for (const check of outputListeners) check(); done() })
    }))
    return parserTail
  }
  const stopWaits = () => { for (const cancel of waits) cancel(); waits.clear() }
  const close = () => closing ??= (async () => {
    stopWaits()
    const failures = []
    const attempt = async run => { try { await run() } catch (error) { failures.push(String(error)) } }
    await attempt(async () => { connection?.dispose(); await bridge?.close() })
    await attempt(async () => {
      if (client && original && (await client.statusAgent(original.agentSessionId)).run.state === 'running')
        await client.stopAgent(original.agentSessionId, original.run)
    })
    for (const dispose of disposers.reverse()) await attempt(dispose)
    await attempt(async () => { await client?.dispose() })
    await attempt(async () => {
      if (!activation) return
      for (const run of await activation.client.list()) {
        if (run.state.type === 'running') await activation.client.stop(await activation.client.prepareStop(run.id))
        await activation.client.remove(run.id)
      }
      proof.remainingRuns = (await activation.client.list()).length
      await activation.shutdown(); await activation.dispose()
    })
    if (proof.identity) await attempt(async () => {
      proof.nativeProcessesExited = [proof.identity.processId, proof.identity.nativeProcessId].every(pid => {
        try { process.kill(pid, 0); return false } catch (error) { if (error.code === 'ESRCH') return true; throw error }
      })
      assert.equal(proof.nativeProcessesExited, true, 'Both the private managed producer and native backend must have exited.')
    })
    await attempt(async () => { await rm(root, { recursive: true, force: true }) })
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    process.removeListener('SIGTERM', terminate)
    proof.cleanup = failures.length === 0
    if (failures.length) throw new AggregateError(failures, 'The private native model fixture could not finish cleanup.')
  })()
  const terminate = () => { void close().finally(() => process.exit(1)) }
  process.once('SIGTERM', terminate)
  function sessionWait(predicate, label, timeoutMs = 20000) {
    const pending = new Promise((done, reject) => {
      let release = () => {}
      const finish = (error, value) => { clearTimeout(timer); release(); waits.delete(cancel); error ? reject(error) : done(value) }
      const cancel = () => finish(new Error('The private native fixture closed while waiting: ' + label))
      const timer = setTimeout(() => finish(new Error('The native machine publication did not confirm: ' + label)), timeoutMs)
      waits.add(cancel)
      const accept = session => { if (session.agentSessionId === original?.agentSessionId && predicate(session)) finish(undefined, session) }
      release = client.onEvent(event => { if (event.type === 'agent-session') accept(event.session) }, { observeMessages: false })
      if (original) accept(client.agentSession(original.agentSessionId))
    })
    void pending.catch(() => {}); return pending
  }
  const waitConfiguration = (predicate, label) => sessionWait(session => !!session.nativeConfiguration && predicate(session.nativeConfiguration), label)
  function terminalWait(predicate, label) {
    // Terminal bytes are only the human-facing menu render witness. Native/Core machine facts decide every model outcome.
    const pending = new Promise((done, reject) => {
      const cancel = () => finish(new Error('The private TUI closed: ' + label))
      const finish = error => { clearTimeout(timer); outputListeners.delete(check); waits.delete(cancel); error ? reject(error) : done() }
      const check = () => { if (predicate(screen())) finish() }
      const timer = setTimeout(() => finish(new Error('The actual private TUI did not render: ' + label)), 10000)
      waits.add(cancel); outputListeners.add(check); check()
    })
    void pending.catch(() => {}); return pending
  }
  try {
    const { installTerminalOscHandlers } = await import('../../../../apps/desktop/src/renderer/src/lib/terminal-capability-replies.ts')
    const osc = installTerminalOscHandlers(terminal, { isReplaying: () => replaying, respondFromRenderer: true, sendInput: sendProtocol })
    disposers.push(() => osc.dispose())
    offline = await (await import('../helpers/codex-offline-endpoint.ts')).offlineEndpoint(home, [], workspace)
    disposers.push(async () => { for (const socket of offline.sockets) socket.destroy(); await new Promise(done => offline.endpoint.close(done)) })
    await writeFile(join(home, 'config.toml'), 'check_for_update_on_startup=false\n' + await readFile(join(home, 'config.toml'), 'utf8'))
    const command = process.env.AGENTMUX_TEST_CODEX_EXECUTABLE ?? 'codex'
    proof.version = (await promisify(execFile)(command, ['--version'], { env: process.env })).stdout.trim()
    assert.ok(proof.version, 'Native protocol evidence records the actual installed version.')
    const executable = await realpath(isAbsolute(command) ? command : (await promisify(execFile)('which', [command], { env: process.env })).stdout.trim())
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(executable)) digest.update(chunk)
    proof.binary = { executable, sha256: digest.digest('hex') }
    const binary = fileURLToPath(new URL('../../vendor/ctxmux/' + process.platform + '-' + process.arch + '/bin/ctxmuxd', import.meta.url))
    activation = await activateRuntime({ executable: binary, socketPath: join(runtime, 'ctxmux.sock'), stateDir: join(state, 'ctxmux'),
      env: { AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined }, timeoutMs: 10000,
      childDisposition: { mode: 'detached', stdout: 'ignore', stderr: 'pipe' } })
    const store = new core.AgentMuxFileAgentSessionStore(join(state, 'sessions.json'))
    client = new core.AgentMuxClient({ store }); await client.connect()
    disposers.push(client.onEvent(event => {
      if (event.type === 'agent-session' && event.session.nativeConfiguration) proof.publications.push(structuredClone(event.session.nativeConfiguration))
      if (event.type === 'terminal-output' && event.run.runId === original?.run.runId) {
        terminalOutput += event.data
        if (terminalReady) void parse(event.dataBytes)
        else liveFrames.push(event)
      }
    }, { observeMessages: false }))
    original = await client.createAgent({ agentSessionId: 'model-sync-original', createOperationId: 'model-sync-create-original',
      providerId: 'codex', executorId: 'codex', commandOverride: command, workspacePath: workspace,
      prompt: 'PRIVATE_QUEUE_MODEL_SYNC_SETUP', injectAgentMuxGuide: false,
      args: ['--no-alt-screen', '--dangerously-bypass-hook-trust', '--sandbox', 'read-only', '--ask-for-approval', 'never', '--model', 'private-queue'],
      env: { HOME: home, CODEX_HOME: home, TERM: 'xterm-256color', NODE_OPTIONS: process.env.NODE_OPTIONS, AMX_INFORMATION_CANDIDATE: candidate,
        ...(process.env.AMX_MODEL_SYNC_NATIVE_TRACE ? { AMX_MODEL_SYNC_NATIVE_TRACE: process.env.AMX_MODEL_SYNC_NATIVE_TRACE } : {}),
        ...(process.env.AMX_INFORMATION_COMPILED_EDIT ? { AMX_INFORMATION_COMPILED_EDIT: process.env.AMX_INFORMATION_COMPILED_EDIT } : {}),
        ...(process.env.AMX_INFORMATION_COMPILED_LOADED ? { AMX_INFORMATION_COMPILED_LOADED: process.env.AMX_INFORMATION_COMPILED_LOADED } : {}) } })
    const ready = await sessionWait(session => session.nativeHandle?.kind === 'provider' && session.terminalFrontend?.state === 'attached' &&
      session.terminalFrontend.initialization?.native.state === 'confirmed' &&
      session.terminalFrontend.initialization.native.sessionId === session.nativeHandle.sessionId, 'original native identity and real TUI attachment')
    const { attachment: attached } = await client.reattachAgent(original.agentSessionId)
    assert.equal(attached.run.runId, original.run.runId)
    terminalOutput = attached.replay.map(chunk => chunk.data).join('') + terminalOutput
    for (const chunk of attached.replay) await parse(chunk.dataBytes, true)
    terminalReady = true
    for (const event of liveFrames.splice(0)) if (event.evidence.outputByteRange.endByte > attached.run.latestOutputBytes) void parse(event.dataBytes)
    terminal.resize(100, 38)
    await client.resizeAgent(original.agentSessionId, original.run, 100, 38)
    const write = async data => { await parserTail; await protocolTail
      return await client.writeAgent({ agentSessionId: original.agentSessionId, expectedRun: original.run, source: 'user', data }) }
    // The pinned remote TUI still reviews its own hooks even when its launch has the bypass flag.
    // This model test needs no Hook grant. Dismiss that independent review through its native Esc action.
    await terminalWait(text => stripVTControlCharacters(text).includes('Hooks need review'), 'private native hook review')
    // Match upstream directory_trust's fresh-input pacing after this protected screen.
    // This delays a UI key only; every result below still requires original native machine facts.
    await new Promise(done => setTimeout(done, 200))
    await write('3')
    await terminalWait(text => stripVTControlCharacters(text).includes('PRIVATE_QUEUE_COMPLETE'), 'original completed setup visible in the actual native TUI')
    proof.setup.privateHookReview = 'The actual native TUI chose Continue without trusting for its independent startup Hook review. No Hook trust success is claimed and no host trust was read or written.'
    const saved = await store.readMetadata(original.agentSessionId)
    assert.equal(saved.nativeActor.configurationObservation, true)
    assert.equal(saved.nativeActor.frontendControl, true)
    assert.equal(saved.nativeHandle.sessionId, ready.nativeHandle.sessionId)
    const listeners = await nativeProcessTcpListeners(ready.run?.pid ?? (await client.statusAgent(original.agentSessionId)).run.pid, new AbortController().signal)
    assert.equal(listeners.length, 1)
    const mappedBinary = await nativeProcessExecutable(listeners[0].processId, new AbortController().signal)
    const nativeDigest = createHash('sha256')
    for await (const chunk of createReadStream(mappedBinary.path)) nativeDigest.update(chunk)
    proof.nativeBinary = { executable: mappedBinary.path, device: String(mappedBinary.device), inode: String(mappedBinary.inode), sha256: nativeDigest.digest('hex') }
    connection = await connectCodexNativeActor(listeners[0].endpoint, saved.nativeActor.token, new AbortController().signal, 'agentmux_model_sync_readonly')
    let runtimeSessionId
    const nativeRead = async () => {
      const result = await connection.request('thread/read', { threadId: saved.nativeHandle.sessionId, includeTurns: true })
      assert.equal(result.thread.id, saved.nativeHandle.sessionId)
      if (runtimeSessionId) assert.equal(result.thread.sessionId, runtimeSessionId)
      else runtimeSessionId = result.thread.sessionId
      return result.thread
    }
    const initial = await nativeRead()
    assert.equal(initial.turns.length, 1)
    assert.equal(initial.turns[0].status, 'completed')
    assert.equal(typeof initial.path, 'string')
    // Materialization includes the original owner's adoption of the source, not only Native writing a file.
    const materialized = await sessionWait(session => session.nativeHandle?.kind === 'provider' &&
      session.nativeHandle.sessionId === initial.id && session.nativeHandle.transcriptPath === initial.path,
      'Core adopted the original materialized native source')
    proof.materializedNativeHandle = structuredClone(materialized.nativeHandle)
    proof.setup.turns = initial.turns.length; proof.setup.modelHttpRequests = offline.requests.length
    assert.ok(proof.setup.modelHttpRequests >= 1)
    proof.identity = { agentSessionId: original.agentSessionId, run: original.run, processId: (await client.statusAgent(original.agentSessionId)).run.pid,
      nativeProcessId: listeners[0].processId,
      nativeSessionId: initial.id, nativeRuntimeSessionId: initial.sessionId, actorId: saved.nativeActor.actorId,
      lifecycleOperationId: saved.nativeActor.lifecycleOperationId, modelProvider: initial.modelProvider }
    bridge = await createModelStateMainBridge({ client, directory: root, agentSessionId: original.agentSessionId, onRuntimeEvent })
    const inspection = await bridge.inspectConfiguration()
    const model = inspection.snapshot.options.find(option => option.category === 'model')
    assert.equal(model.type, 'select'); assert.ok(model.choices.length >= 2, 'The actual native catalog must supply selectable models.')
    proof.catalog = model.choices.map(choice => ({ id: choice.value, name: choice.name }))
    assert.equal(inspection.snapshot.observation.state, 'confirmed')
    assert.ok(inspection.snapshot.observation.sequence > 0)
    proof.modelSceneStartedMonotonicNs = process.hrtime.bigint().toString()
    const openMenu = async () => {
      const rendered = terminalWait(text => /Select Model|Select model|Select a model/u.test(text), 'native model menu')
      await write('\x1b[200~/model\x1b[201~'); await write('\x1b[13u'); await rendered
    }
    const selectInTui = async () => {
      const before = await nativeRead(), count = offline.requests.length
      const changed = waitConfiguration(value => value.observation?.state === 'confirmed' && value.options.some(option => option.category === 'model' && option.currentValue !== before.model), 'real TUI selection propagated through original producer')
      await openMenu()
      const reasoning = terminalWait(text => /Select[^\r\n]*(?:reasoning|Reasoning)|Reasoning (?:Level|Effort)/u.test(text), 'native reasoning menu after model selection')
      await write('2'); await reasoning; await write('\x1b[13u')
      let publication
      try { publication = await changed } catch (error) {
        const native = await nativeRead(), current = client.agentSession(original.agentSessionId).nativeConfiguration
        proof.missingNativeConfigurationPublication = { nativeModel: native.model, nativeSessionId: native.id,
          nativeRuntimeSessionId: native.sessionId, core: current, eventDeadline: String(error) }
        assert.equal(current?.options.find(option => option.category === 'model')?.currentValue, native.model,
          'The real TUI changed the original native model, but its original producer did not publish that model to Core.')
        assert.equal(current?.observation?.state, 'confirmed', 'The original native model changed without a confirmed Core observation.')
        throw error
      }
      const snapshot = publication.nativeConfiguration
      const after = await nativeRead()
      assert.notEqual(after.model, before.model); assert.ok(proof.catalog.some(choice => choice.id === after.model))
      assert.equal(snapshot.options.find(option => option.category === 'model').currentValue, after.model)
      assert.equal(after.turns.length, 1); assert.equal(offline.requests.length, count)
      proof.terminalActions.push({ action: 'real-tui-model-menu', before: before.model, after: after.model, sequence: snapshot.observation.sequence,
        throughOutput: terminalOutput.length })
      return snapshot
    }
    const verifyExternalInTui = async model => {
      const label = proof.catalog.find(choice => choice.id === model)?.name ?? model
      // External setting changes render through the original TUI. This is UI evidence, not an ACK or Provider fact.
      await terminalWait(text => [model, label].some(value => text.includes(value)), 'external native setting visible in the same real TUI')
      const start = terminalOutput.length
      await openMenu()
      const menu = screen(), escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
      assert.match(menu, new RegExp('(?:' + escape(model) + '|' + escape(label) + ')[^\\r\\n]*\\(current\\)', 'u'),
        'The reopened real TUI model menu must mark the external selection current.')
      await write('\x1b[27u')
      const receipt = { action: 'real-tui-reopened-model-menu', model, menu, outputBytes: terminalOutput.length - start }
      proof.terminalActions.push(receipt)
      return receipt
    }
    return { root, client, bridge, original, proof, inspection, nativeRead, waitConfiguration, selectInTui, verifyExternalInTui,
      get terminalOutput() { return terminalOutput }, get modelHttpRequests() { return offline.requests.length }, close }
  } catch (error) {
    proof.setup.modelHttpRequests = offline?.requests.length ?? 0
    if (original && client) {
      proof.status = await client.statusAgent(original.agentSessionId).catch(failure => ({ error: String(failure) }))
      if (!terminalOutput) terminalOutput = await client.readRunReplay(original.run).then(value => value.replay.map(chunk => chunk.data).join(''), failure => String(failure))
    }
    proof.failure = String(error); proof.terminalTail = terminalOutput.slice(-8000)
    proof.screen = screen()
    await close(); Object.defineProperty(error, 'nativeProof', { value: proof }); throw error
  }
}
