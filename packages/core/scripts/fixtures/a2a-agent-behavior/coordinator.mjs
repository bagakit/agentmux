import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { bounded, terminate } from './process.mjs'
import { readPrivateNativeRecords, nativeSession, assertNativeCollaboration, nativeEvidenceGuards } from './native-evidence.mjs'
import { scenarios, assertBehavior, behaviorEvidenceGuard, assertProgressiveDiscovery, progressiveDiscoveryEvidenceGuard } from './scenarios.mjs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

// This process is started with the private environment before any Core import.
const config = JSON.parse(await readFile(process.argv[2], 'utf8'))
const { repository, privateRoot, evidence, executable: codexExecutable, model, minimumOnly } = config
const coreRoot = join(repository, 'packages/core'), fixture = import.meta.dirname
const exec = promisify(execFile), hash = value => createHash('sha256').update(value).digest('hex')
const sourceHashes = async () => Object.fromEntries(await Promise.all(config.sourceInputs.map(async path => [path, hash(await readFile(join(repository, path)))])))
const environment = { ...process.env }, workspace = join(privateRoot, 'workspace'), authHome = join(privateRoot, 'auth')
assert.equal(environment.HOME, join(privateRoot, 'home'))
assert.equal(environment.CODEX_HOME, authHome)
assert.equal(process.cwd(), workspace)
const ownership = { daemonPid: null, runPids: [], modelReceipts: [], peerReceipts: ['peer-process.json'], credentialReceipts: ['peer-private-auth.json'] }
const recordOwnership = () => writeFile(join(privateRoot, 'owned-processes.json'), JSON.stringify(ownership), { mode: 0o600 })
let interrupted = false
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { interrupted = true })
const knownSecrets = new Set()
const redact = text => [...knownSecrets].reduce((value, secret) => value.replaceAll(secret, '[redacted-private-credential]'), text).replace(/(AGENTMUX_AGENT_CAPABILITY["'=:\s]+)[^\s"']+/gu, '$1[redacted]')
  .replace(/\bsk-[A-Za-z0-9_-]{16,}/gu, '[redacted-api-key]')
const save = async (name, value) => writeFile(join(evidence, name), redact(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n'), { mode: 0o600 })
const receipt = { schema: 'agentmux.a2a-agent-behavior-proof.v1', provisional: minimumOnly, completeFeatureCoverage: false,
  passed: false, scenarios: [], modelRequested: model ?? 'CLI default; actual model must come from native evidence', credentialContentRead: false }

let client, server, daemon, peerSession
const models = [], privateCredentials = ['peer-private-auth.json']
try {
  await mkdir(evidence, { recursive: true, mode: 0o700 })
  receipt.sourceBefore = await sourceHashes()
  const { staleDistComplaint } = await import(pathToFileURL(join(repository, 'vitest.dist-freshness.ts')).href)
  assert.equal(await staleDistComplaint(coreRoot), null, 'Build this candidate Core before running real models')
  const core = await import(pathToFileURL(join(coreRoot, 'dist/index.js')).href)
  const { composeAgentLaunchPrompt } = await import(pathToFileURL(join(coreRoot, 'dist/agent-outbound-message.js')).href)
  const { agentMuxModuleSkill } = await import(pathToFileURL(join(coreRoot, 'dist/agentmux-cli-module-skills.js')).href)
  const { agentMuxCommandHelp } = await import(pathToFileURL(join(coreRoot, 'dist/agentmux-cli-help.js')).href)
  const messageContract = core.AGENTMUX_AGENT_MESSAGING_GUIDANCE
  const messageModule = agentMuxModuleSkill('message'), sendHelp = agentMuxCommandHelp('agent.send')
  assert.ok(messageModule?.includes(messageContract) && sendHelp, 'Candidate communication contract/help is unavailable')
  const bootstrap = composeAgentLaunchPrompt('bootstrap-proof-body', true).systemContext
  assert.ok(bootstrap && !bootstrap.includes(messageContract), 'Bootstrap eagerly contains the complete communication contract')
  receipt.guidanceSha256 = hash(messageContract)
  receipt.discoveryInputs = { bootstrapSha256: hash(bootstrap), messageModuleSha256: hash(messageModule), sendHelpSha256: hash(sendHelp) }
  receipt.cliVersion = (await exec(codexExecutable, ['--version'])).stdout.trim()
  const runtime = environment.AGENTMUX_RUNTIME_DIRECTORY, state = environment.AGENTMUX_STATE_DIRECTORY
  await recordOwnership()
  const daemonPath = join(coreRoot, 'vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd')
  daemon = spawn(daemonPath, ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'],
    { env: environment, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  ownership.daemonPid = daemon.pid; await recordOwnership()
  let daemonError = ''; daemon.stderr.on('data', bytes => { daemonError += bytes })
  await bounded(new Promise((yes, no) => {
    daemon.stdio[3].once('data', yes)
    daemon.once('error', no)
    daemon.once('exit', code => no(Error('Private daemon exited ' + code + ': ' + daemonError)))
  }), 15_000, 'Private daemon readiness')
  receipt.privateDaemonPid = daemon.pid
  receipt.privateEnvironment = { home: environment.HOME, authHome, runtime, state, cli: config.cli, importedAfterIsolation: true }
  // An actual noninteractive Codex process has no TUI handshake. This explicit
  // verification Provider declares that native exec contract; it does not mock
  // Core, public RPC, author checks, Input, Runtime or the original journal.
  const provider = core.defineAgentProvider({ catalog: { id: 'proof-codex-exec', label: 'Private real Codex exec', executable: process.execPath,
    expectedProcess: 'node', promptDelivery: 'positional-argv', readySignal: { kind: 'foreground-process', expectedProcess: 'node' },
    hookStrategy: { kind: 'none' }, resumeStrategy: { kind: 'none' }, acpStrategy: { kind: 'none' },
    capabilities: { terminal: true, timeline: 'unavailable', permission: 'none', providerResume: false, replyCorrelation: 'none' } },
    buildArgs: (prompt, args) => [...args, ...(prompt ? [prompt] : [])], hook: { rules: [] } })
  client = new core.AgentMuxClient({ store: new core.AgentMuxFileAgentSessionStore(environment.AGENTMUX_AGENT_SESSION_STORE), providers: [provider] })
  await client.connect()
  const httpToken = config.httpToken; knownSecrets.add(httpToken)
  server = new core.AgentMuxControlServer({ socketPath: join(runtime, 'control.sock'), http: { host: '127.0.0.1', port: 0, token: httpToken }, coreClients: () => [{ hostId: 'local', client }] })
  await server.start()
  assert.ok(server.httpAddress, 'Private loopback HTTP RPC is unavailable')
  environment.AGENTMUX_RPC_ENDPOINT = `http://127.0.0.1:${server.httpAddress.port}/`
  environment.AGENTMUX_RPC_HTTP_TOKEN = httpToken
  const sandboxArgs = ['-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=true']
  const preflights = []
  for (const [label, executable, args] of [
    ['direct-private-public-cli', config.cli, ['system', 'endpoint', '--inspect']],
    ['native-network-sandbox', codexExecutable, ['--no-daemon', ...sandboxArgs, 'sandbox', config.cli, 'system', 'endpoint', '--inspect']]
  ]) {
    try { const result = await exec(executable, args, { env: environment, cwd: workspace, timeout: 10_000 }); preflights.push({ label, code: 0, stdout: result.stdout, stderr: result.stderr }) }
    catch (error) { preflights.push({ label, code: error.code, stdout: error.stdout, stderr: error.stderr }) }
  }
  await save('sandbox-preflight.json', preflights)
  assert.equal(preflights[0].code, 0, 'Direct private public CLI preflight failed')
  assert.equal(preflights[1].code, 0, 'The model sandbox cannot reach the private public endpoint')
  receipt.privateEnvironment.rpcEndpoint = environment.AGENTMUX_RPC_ENDPOINT
  const { renderAgentMuxMessageEnvelope } = await import(pathToFileURL(join(coreRoot, 'dist/agent-message-render.js')).href)
  const prefix = randomUUID(), token = 'audit-' + prefix, peerBytes = join(privateRoot, 'peer.bytes')
  peerSession = await client.createAgent({ agentSessionId: 'peer-' + prefix, createOperationId: 'peer-create-' + prefix,
    providerId: provider.id, executorId: 'private-peer', workspacePath: workspace, commandOverride: process.execPath,
    args: [join(fixture, 'peer.mjs'), peerBytes, join(privateRoot, 'peer-process.json'), join(privateRoot, 'peer-private-auth.json')], env: environment, injectAgentMuxGuide: false })
  ownership.runPids.push((await client.listRuns()).find(run => run.runId === peerSession.run.runId)?.pid); await recordOwnership()
  const peerDeadline = Date.now() + 5000
  let peerAuth
  do { peerAuth = await readFile(join(privateRoot, 'peer-private-auth.json'), 'utf8').then(JSON.parse, () => null); if (!peerAuth) await new Promise(done => setTimeout(done, 25)) } while (!peerAuth && Date.now() < peerDeadline)
  assert.equal(peerAuth?.agentSessionId, peerSession.agentSessionId); assert.ok(peerAuth.capability)
  knownSecrets.add(peerAuth.capability)
  const selected = scenarios(peerSession.agentSessionId, token, minimumOnly)
  assert.equal(selected.length, minimumOnly ? 1 : 5, 'The real behavior scenario set must be nonempty and complete')
  receipt.expectedScenarioNames = selected.map(value => value.name)
  receipt.boundary = 'Real Codex exec through an explicit private verification Provider, actual Core lifecycle/journal and public HTTP RPC/CLI. Native TUI startup is not claimed; finite samples do not guarantee universal model behavior.'
  for (const [index, scenario] of selected.entries()) {
    const caseName = String(index + 1) + '-' + scenario.name
    const plan = { authHome, home: environment.HOME, workspace, cli: config.cli, userContext: scenario.userContext,
      credentials: join(privateRoot, caseName + '-private-auth.json'), events: join(privateRoot, caseName + '.jsonl'), stderr: join(privateRoot, caseName + '.stderr'),
      processReceipt: join(privateRoot, caseName + '-process.json'), args: ['--no-daemon', '-a', 'never', ...sandboxArgs, '--enable', 'multi_agent',
        '-c', 'shell_environment_policy.inherit="all"', '--model', model, 'exec', '--ignore-user-config', '--ignore-rules',
        '--skip-git-repo-check', '--color', 'never', '--json'] }
    ownership.modelReceipts.push(caseName + '-process.json'); ownership.credentialReceipts.push(caseName + '-private-auth.json'); privateCredentials.push(caseName + '-private-auth.json'); await recordOwnership()
    const planPath = join(privateRoot, caseName + '-plan.json'); await writeFile(planPath, JSON.stringify(plan), { mode: 0o600 })
    const modelSession = await client.createAgent({ agentSessionId: 'model-' + index + '-' + prefix, createOperationId: 'model-create-' + index + '-' + prefix,
      providerId: provider.id, executorId: 'private-real-model', workspacePath: workspace, commandOverride: process.execPath,
      args: [join(fixture, 'codex-exec.mjs'), codexExecutable, planPath], env: environment, prompt: scenario.task, injectAgentMuxGuide: scenario.guide,
      ...(scenario.userContext ? { initialMessage: { callerAgentSessionId: peerSession.agentSessionId, capability: peerAuth.capability } } : {}) })
    models.push({ session: modelSession, plan, caseName })
    ownership.runPids.push((await client.listRuns()).find(run => run.runId === modelSession.run.runId)?.pid); await recordOwnership()
    const outcome = { name: scenario.name, passed: false, originalSession: modelSession, expectation: scenario }
    receipt.scenarios.push(outcome)
    const deadline = Date.now() + 120_000
    let modelRun
    do {
      if (interrupted) throw Error('Private coordinator interrupted')
      modelRun = (await client.listRuns()).find(run => run.runId === modelSession.run.runId)
      if (modelRun && modelRun.state !== 'running') break
      await new Promise(done => setTimeout(done, 100))
    } while (Date.now() < deadline)
    assert.ok(modelRun && modelRun.state !== 'running', 'The bounded real-model run did not finish; original identity is retained')
    const modelAuth = JSON.parse(await readFile(plan.credentials, 'utf8')); knownSecrets.add(modelAuth.capability)
    const eventsText = await readFile(plan.events, 'utf8'), events = eventsText.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line))
    outcome.nativeRecords = await readPrivateNativeRecords(authHome)
    await save(caseName + '-native-records.json', outcome.nativeRecords)
    const completed = events.filter(event => event.type === 'item.completed').map(event => event.item)
    const commands = completed.filter(item => item.type === 'command_execution'), collab = completed.filter(item => item.type === 'collab_tool_call')
    const finalText = completed.filter(item => item.type === 'agent_message').map(item => item.text).join('\n')
    const outgoingPage = await client.listMessages({ participantSessionId: modelSession.agentSessionId, direction: 'outgoing', limit: 20 })
    const incomingPage = await client.listMessages({ participantSessionId: modelSession.agentSessionId, direction: 'incoming', limit: 20 })
    const outgoing = await Promise.all(outgoingPage.messages.map(value => client.readMessage({ messageId: value.envelope.messageId })))
    const incoming = await Promise.all(incomingPage.messages.map(value => client.readMessage({ messageId: value.envelope.messageId })))
    const processReceipt = JSON.parse(await readFile(plan.processReceipt, 'utf8')), peerInput = await readFile(peerBytes, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
    const originalWork = await readFile(join(workspace, 'unrelated-result.txt'), 'utf8').catch(() => null)
    Object.assign(outcome, { modelRun, originalIncoming: incoming, originalOutgoing: outgoing, finalText, actualCommands: commands, nativeCollaboration: collab })
    // Save observations before the behavior oracle. A failed sample retains its
    // original message, actual tool receipt and exact native input for attribution.
    await save(caseName + '-events.jsonl', eventsText); await save(caseName + '-process.json', processReceipt)
    await save(caseName + '-journal.json', { incoming, outgoing }); await save(caseName + '-peer-bytes.txt', peerInput)
    if (originalWork !== null) await save(caseName + '-user-work.txt', originalWork)
    const native = nativeSession(outcome.nativeRecords, events, model, processReceipt.args.at(-1))
    outcome.nativeSource = { threadId: native.threadId, model: model, path: native.main.path }
    if (index > 0) assert.equal(native.calls.filter(call => call.name === 'spawn_agent').length, 0, 'Another scenario created an unauthorized native child')
    assert.ok(!native.calls.some(call => call.name === 'send_message' && JSON.parse(call.arguments).target === peerSession.agentSessionId), 'Independent Session was incorrectly addressed through a native queue')
    assert.ok(events.some(event => event.type === 'turn.completed'), 'Native model completion is unconfirmed')
    assert.equal(modelRun.exitCode, 0, 'Native model process did not finish successfully')
    assert.equal(processReceipt.home, environment.HOME); assert.equal(processReceipt.cli, config.cli)
    assert.equal(processReceipt.authHome, authHome); assert.equal(processReceipt.workspace, workspace)
    assert.ok(processReceipt.args.includes('--no-daemon') && processReceipt.args.includes('--ignore-user-config') && processReceipt.args.includes('--ignore-rules'))
    assert.equal(incoming.length, scenario.userContext ? 1 : 0)
    const originalBody = scenario.userContext ? renderAgentMuxMessageEnvelope(incoming[0].envelope) : scenario.task
    const expectedInput = composeAgentLaunchPrompt(originalBody, scenario.guide)
    assert.equal(processReceipt.originalCorePrompt, expectedInput.text, 'Actual model input differs from the original Core message and this candidate bootstrap')
    assert.equal(Boolean(expectedInput.systemContext), scenario.guide, 'Guide-off discovery acquired platform bootstrap')
    const discoveryFacts = { scenario, commands, messageModule, sendHelp, agentSessionId: modelSession.agentSessionId, runId: modelSession.run.runId }
    outcome.discovery = { originalCorePromptSha256: hash(processReceipt.originalCorePrompt),
      ...(expectedInput.systemContext ? { bootstrapSha256: hash(expectedInput.systemContext) } : {}) }
    for (const original of incoming) {
      assert.equal(original.envelope.senderSessionId, peerSession.agentSessionId)
      assert.equal(original.envelope.senderRunId, peerSession.run.runId)
      assert.equal(original.envelope.recipientSessionId, modelSession.agentSessionId)
      assert.equal(original.envelope.body, scenario.task)
      assert.ok(processReceipt.originalCorePrompt.includes(renderAgentMuxMessageEnvelope(original.envelope)), 'The actual native model did not receive the original Core envelope bytes')
    }
    for (const original of outgoing) {
      assert.equal(original.envelope.senderSessionId, modelSession.agentSessionId)
      assert.equal(original.envelope.senderRunId, modelSession.run.runId)
      assert.equal(original.envelope.recipientSessionId, peerSession.agentSessionId)
      assert.equal(original.deliveryMode, 'reference')
      assert.equal(original.delivery.state, 'queued')
      assert.ok(commands.some(item => item.exit_code === 0 && /agent\s+send/u.test(item.command ?? '') && item.aggregated_output?.includes(original.envelope.messageId)), 'No actual public CLI success matches the journal MID')
    }
    assert.equal(peerInput, '', 'Default reference intake wrote terminal bytes to the private peer')
    const peerStatus = await client.statusAgent(peerSession.agentSessionId)
    assert.equal(peerStatus.run.runId, peerSession.run.runId)
    assert.equal(peerStatus.run.acceptedInputBytes, 0, 'The Inbox-only private peer received terminal input')
    outcome.peerInputAudit = { messageIds: outgoing.map(original => original.envelope.messageId), peerRunId: peerStatus.run.runId,
      acceptedInputBytes: peerStatus.run.acceptedInputBytes, terminalBytes: Buffer.byteLength(peerInput) }
    assert.equal((await client.listRuns()).find(run => run.runId === peerSession.run.runId)?.state, 'running', 'The original independent peer was operated or replaced')
    assert.deepEqual((await client.readAgentSessions()).map(session => session.agentSessionId).sort(), [peerSession.agentSessionId, ...models.map(value => value.session.agentSessionId)].sort(), 'Model created or replaced an independent Core Session')
    try {
      Object.assign(outcome.discovery, assertProgressiveDiscovery(discoveryFacts))
      outcome.discoveryEvidenceGuard = progressiveDiscoveryEvidenceGuard(discoveryFacts)
      const facts = { scenario, commands, collab, finalText, outgoing, token, originalWork, nativeRecords: outcome.nativeRecords, events, model, actualPrompt: processReceipt.args.at(-1) }
      assertBehavior(facts)
      outcome.oracleSensitivity = behaviorEvidenceGuard(facts)
      if (index === 0) {
        outcome.nativeRoute = assertNativeCollaboration(outcome.nativeRecords, events, model, processReceipt.args.at(-1))
        outcome.nativeOracleSensitivity = nativeEvidenceGuards(outcome.nativeRecords, events, model, processReceipt.args.at(-1))
      }
      outcome.passed = true
    } catch (error) { outcome.failure = { message: error.message, stack: error.stack }; await save(caseName + '-failure.json', outcome.failure) }
  }
  assert.equal(receipt.scenarios.filter(value => value.passed).length, minimumOnly ? 1 : 5)
  receipt.sourceAfter = await sourceHashes(); assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore)
  receipt.completeFeatureCoverage = !minimumOnly
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, code: error.code, stack: redact(error.stack ?? '') } }
finally {
  const cleanupErrors = []
  for (const name of privateCredentials) {
    const auth = await readFile(join(privateRoot, name), 'utf8').then(JSON.parse, () => null)
    if (auth?.capability) knownSecrets.add(auth.capability)
  }
  for (const { session, plan, caseName } of models) {
    await save(caseName + '-runtime-replay.json', await client.readRunReplay(session.run).catch(error => ({ error: error.message }))).catch(error => cleanupErrors.push(error.message))
    for (const [source, name] of [[plan.events, caseName + '-events.jsonl'], [plan.stderr, caseName + '-stderr.log'], [plan.processReceipt, caseName + '-process.json']]) {
      const bytes = await readFile(source, 'utf8').catch(() => null)
      if (bytes !== null) await save(name, bytes).catch(error => cleanupErrors.push(error.message))
    }
  }
  for (const session of [...models.map(value => value.session), peerSession].filter(Boolean)) {
    try {
      const run = (await client.listRuns()).find(run => run.id === session.run.runId || run.runId === session.run.runId)
      if (run?.state === 'running') await bounded(client.stopAgent(session.agentSessionId, session.run), 10_000, 'Private Run stop')
    } catch (error) { cleanupErrors.push(error.message) }
  }
  if (server) await bounded(server.stop(), 10_000, 'Private control stop').catch(error => cleanupErrors.push(error.message))
  if (client) await bounded(client.dispose(), 10_000, 'Private client dispose').catch(error => cleanupErrors.push(error.message))
  if (daemon) await terminate(daemon).catch(error => cleanupErrors.push(error.message))
  receipt.cleanup = { errors: cleanupErrors, privateRootOwnedByLauncher: true,
    exactDaemonPid: daemon?.pid, noHostProcessScan: true }
  if (cleanupErrors.length) receipt.passed = false
  await mkdir(evidence, { recursive: true, mode: 0o700 }); await save('receipt.json', receipt)
}
process.stdout.write(JSON.stringify({ passed: receipt.passed, formalGatePassed: receipt.passed && !minimumOnly, provisional: minimumOnly,
  completeFeatureCoverage: receipt.completeFeatureCoverage, scenarios: receipt.scenarios.map(value => ({ name: value.name, passed: value.passed })), receipt: join(evidence, 'receipt.json') }) + '\n')
if (!receipt.passed) process.exitCode = 1
