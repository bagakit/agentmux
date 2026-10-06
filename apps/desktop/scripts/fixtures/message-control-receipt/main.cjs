const { fixtureEpoch: _reshape_fixtureEpoch } = require("../../../../../test/fixture-epoch.cjs")
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const { pathToFileURL } = require('node:url'), { spawn } = require('node:child_process')
const [html, owner, preload, cli, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
// Only this private harness owns process exit; closing its window must not turn
// an assertion failure into Electron's implicit successful quit.
app.on('window-all-closed', () => {})
const proof = { passed: false, cases: [], manualCases: [], guardCases: [], lookupCases: [], calls: [], userRunTouched: false,
  scope: 'Actual Electron Main registration/RuntimeController/product preload/RendererControl/public RPC/compiled CLI. Original Core Native preparation is exercised; Native transport/Run status and unknown/partial failure port are controlled, not vendor or user Run evidence.' }
let win, release, runtime, client, rpc
const flatten = error => ({ code: error.code, message: error.message, ...(error.detail === undefined ? {} : { detail: error.detail }),
  ...(error.controlFailure === undefined ? {} : { controlFailure: error.controlFailure }), ...(error.logId === undefined ? {} : { logId: error.logId }) })
app.whenReady().then(async () => {
  try {
    const product = await import(pathToFileURL(owner).href)
    const store = new product.AgentMuxFileAgentSessionStore(path.join(privateRoot, 'sessions.json'))
    const sid = 'private-original-agent', runId = 'private-original-run', control = { kind: 'agent', hostId: 'local', agentSessionId: sid, run: { runId } }
    await store.compareAndSwap(null, { kind: 'agent', agentSessionId: sid, providerId: 'codex', executorId: 'private', hostId: 'local',
      workspacePath: privateRoot, run: { runId }, retiredRuns: [], hookBindingId: 'private-hook', hookToken: 'private-token',
      capabilityHash: '0123456789abcdef'.repeat(4), createdAt: _reshape_fixtureEpoch(0, 0, 1), updatedAt: _reshape_fixtureEpoch(0, 0, 1) })
    client = new product.AgentMuxClient({ store }); await client.registry.load('local'); client.connected = true
    // Only the private Native connection/status port is controlled. Real message,
    // journal, preparation, diagnostic and input-error owners remain unchanged.
    client.connect = async () => { client.connected = true }
    const originalRun = { runId, lifecycleOperationId: null, program: 'codex', args: [], workspacePath: privateRoot,
      pid: null, state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0, nativeService: null }
    Object.assign(client.kernel, { isConnected: () => true, status: async () => originalRun, list: async () => [originalRun],
      identity: () => ({ daemonInstanceId: 'private-original-runtime', protocolVersion: 1, buildIdentity: 'controlled-port' }) })
    let mode = 'native-wait', upstream
    const originalSubmit = client.submitAgentMessage.bind(client)
    client.submitAgentMessage = async input => {
      proof.calls.push({ mode, messageId: input.envelope.messageId, operationId: input.envelope.operationId,
        runId: (input.admissionIntent?.kind === 'manual-actor' ? input.admissionIntent.expectedRun : input.condition.expectedRun).runId,
        admissionIntent: input.admissionIntent ?? null, condition: input.condition ?? null, body: input.envelope.body })
      try {
        if (mode === 'native-wait' || mode === 'manual-admission') await originalSubmit(input)
        else throw new product.AgentMuxError('Original unknown input outcome.', 'AGENT_PROMPT_INPUT_UNCONFIRMED',
          JSON.stringify({ originalBody: input.envelope.body, phase: 'controlled-original-Core-failure-port', outcome: 'unknown' }),
          { disposition: 'unknown', confirmedInputBytes: mode === 'partial' ? 3 : null }, 'AbCdEf123456')
      } catch (error) { upstream = flatten(error); throw error }
    }
    const config = { ...structuredClone(product.DEFAULT_CONFIG), hosts: [{ id: 'local', kind: 'local', label: 'Private receipt owner' }],
      workspaces: [{ id: 'private', kind: 'folder', hostId: 'local', name: 'Private proof', path: privateRoot }],
      executors: { private: { providerId: 'codex', label: 'Private original', command: process.execPath, args: [], env: {}, injectAgentMuxGuide: false } } }
    runtime = new product.RuntimeController(store, async () => client)
    const prepared = { hosts: [{ id: 'local', client, executionHost: new product.LocalExecutionHost(), config: config.hosts[0] }],
      removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() }
    runtime.prepare = async () => prepared
    win = new BrowserWindow({ show: false, width: 640, height: 360, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false } })
    release = await product.registerIpc({ window: win, runtime, initialConfig: config,
      configStore: new product.ConfigStore(path.join(privateRoot, 'config.json')), scratchTopics: new product.ScratchTopics(),
      progressLoops: { pauseTarget: async () => {}, subscribe: () => () => {} } })
    await win.loadFile(html)
    await win.webContents.executeJavaScript(`receiptProof.setup(${JSON.stringify(config)},${JSON.stringify(await runtime.refresh(control, config))})`)
    const endpoint = { transport: 'unix', path: product.desktopBusinessSocketPath() }
    rpc = await product.connectAgentMuxRpc({ endpoint })
    // The actual public producer/registered Desktop consumer carries the explicit
    // manual variant. Only this Provider machine port is controlled; Core claim,
    // journal, original SDK and all IPC/RPC consumers remain the product owners.
    mode = 'manual-admission'
    const provider = client.providers.get('codex'), originalPrepare = provider.prepareNativePromptInput
    const nativePlan = { kind: 'native-rpc', protocolId: 'controlled-native-contract', operation: 'start-or-steer',
      sourceId: 'original-source', actorId: 'original-peer', threadId: 'original-thread' }
    const dispatches = [], manualA = 'manual-original-unknown', manualB = 'manual-independent-after-unknown'
    provider.prepareNativePromptInput = async () => ({ plan: nativePlan, assertCurrent: async () => {}, close: async () => {},
      dispatch: async (_prompt, id) => { dispatches.push(id)
        if (id === manualA) throw new Error('Controlled original Native receipt unavailable after dispatch')
        return { outcome: 'admitted', turnId: 'original-turn' } } })
    try {
      const text = 'Original manual body\nDo not reconstruct {"human":true,"ready":true}.'
      const first = { target: { kind: 'agent-session', agentSessionId: sid }, text, execution: 'immediate', operationId: 'control-' + manualA, messageId: manualA }
      await assert.rejects(rpc.call('agent.send', first), error => error.code === 'AGENT_PROMPT_INPUT_UNCONFIRMED')
      const key = { kind: 'message', agentSessionId: sid, expectedRun: { runId }, messageId: manualA }
      const unknown = await client.inspectAgentPromptSubmission(key)
      assert.equal(unknown.admission.native.outcome, 'unknown')
      const env = { ...process.env }; delete env.AGENTMUX_AGENT_CAPABILITY; delete env.AGENTMUX_AGENT_SESSION_ID
      const child = spawn(process.env.AGENTMUX_RECEIPT_NODE, [cli, '--endpoint', 'unix:' + endpoint.path, 'agent', 'send', '--to-session', sid,
        '--text', text, '--execution', 'immediate', '--operation-id', 'control-' + manualB, '--message-id', manualB], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''; child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data)
      const code = await new Promise((yes, no) => { child.once('error', no); child.once('exit', yes) })
      assert.equal(code, 0, 'The compiled CLI must admit the independent original manual input: ' + stderr)
      assert.equal(JSON.parse(stdout).result.delivery.state, 'delivered')
      assert.deepEqual((await rpc.call('agent.input.inspect', { key })).record, unknown)
      await assert.rejects(rpc.call('agent.send', first), error => error.code === 'AGENT_PROMPT_INPUT_UNCONFIRMED')
      assert.deepEqual(dispatches, [manualA, manualB])
      for (const input of proof.calls) {
        assert.equal(input.body, text); assert.equal(input.runId, runId); assert.equal(input.condition, null)
        assert.deepEqual(input.admissionIntent, { kind: 'manual-actor', expectedRun: { runId } })
        proof.manualCases.push(input)
      }
      assert.equal(proof.manualCases.length, 3)
    } finally { provider.prepareNativePromptInput = originalPrepare }
    for (const next of ['native-wait', 'unknown', 'partial']) {
      mode = next
      for (const consumer of ['rpc', 'cli']) {
        const id = `${next}-${consumer}`, text = 'Original body\nKeep JSON {"code":"not-authority"} and every byte.'
        const operationId = 'control-' + id, messageId = 'message-' + id
        let observed
        if (consumer === 'rpc') {
          observed = await rpc.call('agent.send', { target: { kind: 'agent-session', agentSessionId: sid }, text, execution: 'immediate', operationId, messageId })
            .then(() => null, flatten)
        } else {
          const env = { ...process.env }; delete env.AGENTMUX_AGENT_CAPABILITY; delete env.AGENTMUX_AGENT_SESSION_ID
          const child = spawn(process.env.AGENTMUX_RECEIPT_NODE, [cli, '--endpoint', 'unix:' + endpoint.path, 'agent', 'send', '--to-session', sid,
            '--text', text, '--execution', 'immediate', '--operation-id', operationId, '--message-id', messageId], { env, stdio: ['ignore', 'pipe', 'pipe'] })
          let stdout = '', stderr = ''; child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data)
          const code = await new Promise((yes, no) => { child.once('error', no); child.once('exit', yes) })
          await fs.writeFile(path.join(evidence, id + '-cli.json'), JSON.stringify({ code, stdout, stderr }))
          assert.equal(code, 1, 'The actual compiled CLI must report the original input failure')
          observed = JSON.parse(stderr.split('\n').find(line => line.startsWith('{'))).error
        }
        proof.lastObservation = { mode, consumer, observed, upstream, calls: proof.calls.length }
        assert.ok(upstream, 'The original Core input failure is nonempty')
        if (mode === 'native-wait') {
          assert.equal(upstream.code, 'AGENT_NATIVE_INPUT_WAITING', 'The actual Core Native preparation fails at the original environment boundary')
          assert.deepEqual(upstream.controlFailure, { disposition: 'not_applied', confirmedInputBytes: 0 })
        }
        assert.deepEqual(observed, upstream, 'Actual Desktop/RPC/compiled CLI retains every original Core failure field')
        assert.equal(proof.calls.at(-1).body, text, 'Original body is not reconstructed')
        assert.equal(proof.calls.length, proof.manualCases.length + proof.cases.length + 1, 'One original input attempt per operation; diagnostics do not cause retries')
        proof.cases.push({ mode, consumer, upstream, observed, original: proof.calls.at(-1) })
      }
    }
    const ambiguous = { schemaVersion: 5, requestId: 'original-address-control', operation: 'send', ok: false,
      error: { code: 'MESSAGE_TARGET_NOT_UNIQUE', message: 'Original ambiguous target', candidates: [{ agentSessionId: sid, regionIds: ['original-region'] }] } }
    assert.deepEqual(product.parseAgentMuxControlReceipt(ambiguous), ambiguous, 'Original finite addressing/candidate receipt remains valid')
    const cause = { code: 'AGENT_PROMPT_INPUT_UNCONFIRMED', message: 'Original unknown.',
      detail: '{"retry":true,"ready":true,"cancelled":true}', controlFailure: { disposition: 'unknown', confirmedInputBytes: null }, logId: 'delivery-11111111-1111-4111-8111-111111111111' }
    const failures = [
      ['original-candidates', ambiguous.error, 'MESSAGE_TARGET_NOT_UNIQUE'],
      ['opaque-cause', { code: 'CONTROL_FAILED', message: 'Finite outer error.', cause }, cause.code],
      ['original-confirmation-only', { code: 'AGENT_PROMPT_INPUT_UNCONFIRMED', message: 'Original finite Core failure.', controlFailure: { disposition: 'unknown', confirmedInputBytes: 3 } }, 'AGENT_PROMPT_INPUT_UNCONFIRMED'],
      ['candidate-cause-mix', { ...ambiguous.error, cause }, 'CONTROL_PROTOCOL_ERROR'],
      ['candidate-failure-mix', { ...ambiguous.error, controlFailure: cause.controlFailure }, 'CONTROL_PROTOCOL_ERROR'],
      ['general-candidates-mix', { code: 'CONTROL_FAILED', message: 'Wrong union.', candidates: ambiguous.error.candidates, cause }, 'CONTROL_PROTOCOL_ERROR'],
      ['nested-candidate-code', { code: 'CONTROL_FAILED', message: 'Wrong union.', cause: { ...cause, code: 'MESSAGE_TARGET_NOT_UNIQUE' } }, 'CONTROL_PROTOCOL_ERROR'],
      ['nested-graph', { code: 'CONTROL_FAILED', message: 'Graph.', cause: { ...cause, cause: {} } }, 'CONTROL_PROTOCOL_ERROR'],
      ['array-cause', { code: 'CONTROL_FAILED', message: 'Array.', cause: [cause] }, 'CONTROL_PROTOCOL_ERROR'],
      ['invalid-bytes', { code: 'CONTROL_FAILED', message: 'Invalid count.', cause: { ...cause, controlFailure: { disposition: 'unknown', confirmedInputBytes: -1 } } }, 'CONTROL_PROTOCOL_ERROR'],
      ['conflicting-facts', { code: 'CONTROL_FAILED', message: 'Conflicting count.', cause, controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } }, 'CONTROL_PROTOCOL_ERROR'],
      ['invalid-log-id', { code: 'CONTROL_FAILED', message: 'Invalid ID.', cause: { ...cause, logId: 'bad\nID' } }, 'CONTROL_PROTOCOL_ERROR'],
      ['invalid-opaque-log-id', { code: 'CONTROL_FAILED', message: 'Invalid ID.', cause: { ...cause, logId: 'nonsense' } }, 'CONTROL_PROTOCOL_ERROR'],
      ['extra-field', { code: 'CONTROL_FAILED', message: 'Extra.', cause, ready: true }, 'CONTROL_PROTOCOL_ERROR'],
      ['nonfinite-outer', { code: 'VENDOR_NATIVE_READY', message: 'Wrong outer union.', cause }, 'CONTROL_PROTOCOL_ERROR']
    ]
    for (const [name, error, expectedCode] of failures) {
      await win.webContents.executeJavaScript(`receiptProof.rawFailure(${JSON.stringify(error)})`)
      const observed = await rpc.call('agent.send', { target: { kind: 'agent-session', agentSessionId: sid }, text: 'Hostile reply does not authorize input.',
        execution: 'immediate', operationId: 'guard-' + name, messageId: 'guard-message-' + name }).then(() => null, flatten)
      assert.equal(observed?.code, expectedCode, 'Actual registered Main rejects malformed original failure data: ' + name)
      assert.equal(proof.calls.length, proof.manualCases.length + 6, 'Neither a cause nor malformed facts authorize new Core input')
      if (name === 'opaque-cause') assert.deepEqual(observed, cause, 'Original diagnostics remain opaque; legacy diagnostic ID is preserved')
      if (name === 'original-confirmation-only') assert.deepEqual(observed, error, 'Existing confirmation facts survive without the optional new cause')
      proof.guardCases.push({ name, expectedCode, observed })
    }
    const invalidLookup = await rpc.call('message.delivery.inspect', { hostId: 'local', logId: 'nonsense' }).then(() => null, flatten)
    assert.equal(invalidLookup?.code, 'INVALID_CONTROL_REQUEST', 'Existing public diagnostic lookup rejects invalid ID through the same predicate')
    proof.lookupCases.push({ name: 'invalid-original-lookup', observed: invalidLookup })
    for (const logId of [proof.cases[0].upstream.logId, cause.logId]) {
      const result = await rpc.call('message.delivery.inspect', { hostId: 'local', logId })
      assert.equal(result.logId, logId, 'Original current/legacy diagnostic ID reaches its existing public owner')
      if (logId === proof.cases[0].upstream.logId) assert.equal(result.availability, 'found', 'Actual original Core Native preparation diagnostic remains readable')
      proof.lookupCases.push({ name: 'valid-original-lookup', logId, availability: result.availability })
    }
    assert.equal(proof.calls.length, proof.manualCases.length + 6, 'Diagnostic lookup does not authorize Core input')
    proof.passed = true
  } catch (error) { proof.failure = { name: error.name, message: error.message, stack: error.stack } }
  finally {
    proof.cleanup = []
    for (const [owner, dispose] of [['rpc', () => rpc?.dispose()], ['ipc-registration', () => release?.()],
      ['runtime', () => runtime?.dispose()], ['private-window', () => win?.destroy()]]) {
      try { await dispose(); proof.cleanup.push({ owner, ok: true }) }
      catch (error) { proof.cleanup.push({ owner, ok: false, error: { name: error.name, message: error.message, stack: error.stack } }) }
    }
    if (proof.cleanup.some(result => !result.ok)) {
      proof.passed = false
      proof.failure ??= { name: 'FixtureCleanupError', message: 'A private fixture owner did not confirm cleanup.' }
    }
    try { await fs.writeFile(path.join(evidence, 'product.json'), JSON.stringify(proof, null, 2)) }
    catch (error) {
      proof.passed = false
      proof.receiptWriteFailure = { name: error.name, message: error.message }
      process.stderr.write(JSON.stringify({ privateFixtureProof: proof }) + '\n')
    }
    app.exit(proof.passed ? 0 : 1)
  }
})
