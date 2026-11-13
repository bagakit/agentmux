import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { bounded, registerChild, terminate } from '../a2a-agent-behavior/process.mjs'
import { readPrivateNativeRecords } from '../a2a-agent-behavior/native-evidence.mjs'

const exec = promisify(execFile)

// Keep the exact transient CLI handle and receipt alongside the other private helpers.
function startPrivateCli(cli, args, { env, cwd }, receiptPath, nativeProcessBirth) {
  const request = exec(cli, args, { env, cwd })
  void request.catch(() => {})
  const child = request.child, identity = registerChild(child, nativeProcessBirth)
  const recorded = (async () => {
    await writeFile(receiptPath, JSON.stringify({ processId: child.pid, processIdentity: { pid: child.pid } }), { mode: 0o600 })
    const original = await identity
    await writeFile(receiptPath, JSON.stringify({ processId: child.pid, processIdentity: original }), { mode: 0o600 })
    return original
  })()
  const completed = (async () => {
    const [result, record] = await Promise.allSettled([request, recorded])
    let recordError = record.status === 'rejected' ? record.reason : null
    const exited = child.exitCode !== null || child.signalCode !== null
    if (!recordError && exited) {
      try { await writeFile(receiptPath, JSON.stringify({ processId: child.pid, processIdentity: { ...record.value, exited: true } }), { mode: 0o600 }) }
      catch (error) { recordError = error }
    }
    if (recordError) throw result.status === 'rejected'
      ? new AggregateError([recordError, result.reason], 'Private CLI receipt and execution both failed') : recordError
    if (result.status === 'rejected') throw result.reason
    return result.value
  })()
  void completed.catch(() => {})
  return { child, completed }
}

function privateFailure(error, redact) {
  return { message: redact(error.message), code: error.code, signal: error.signal ?? null, killed: error.killed ?? null,
    stdout: redact(error.stdout ?? ''), stderr: redact(error.stderr ?? ''), stack: redact(error.stack ?? ''),
    errors: error.errors?.map(item => privateFailure(item, redact)) }
}

const config = JSON.parse(await readFile(process.argv[2], 'utf8'))
const { repository, privateRoot, evidence, executable, model } = config
const workspace = join(privateRoot, 'workspace'), authHome = join(privateRoot, 'auth'), environment = { ...process.env }
assert.equal(environment.HOME, join(privateRoot, 'home')); assert.equal(environment.CODEX_HOME, authHome); assert.equal(process.cwd(), workspace)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const ownership = { daemonProcess: null, modelReceipts: ['model-embedded-process.json'],
  peerReceipts: ['peer-process.json'], credentialReceipts: ['peer-private-auth.json', 'model-private-auth.json'] }
const recordOwnership = () => writeFile(join(privateRoot, 'owned-processes.json'), JSON.stringify(ownership), { mode: 0o600 })
const secrets = new Set([config.httpToken]), sessions = [], receipt = { schema: 'agentmux.a2a-reference-agent-proof.v1', passed: false,
  modelRequested: model, finiteSample: true, completeFeatureCoverage: false, userRuntimeTouched: false, scenarios: [] }
const redact = value => [...secrets].reduce((text, secret) => text.replaceAll(secret, '[redacted-private-credential]'), value)
const save = (name, value) => writeFile(join(evidence, name), redact(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n'), { mode: 0o600 })
let client, server, daemon, core, cliProcess, interrupted = false
const observedErrors = []
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true })
async function until(read, accept, label, milliseconds = 120_000) {
  const deadline = Date.now() + milliseconds
  do { if (interrupted) throw Error('Private reference proof was interrupted'); const value = await read(); if (accept(value)) return value; await new Promise(done => setTimeout(done, 100)) } while (Date.now() < deadline)
  throw Error(label + ' remains unconfirmed; no delivery or adoption is inferred')
}
function decodedText(value) {
  if (typeof value === 'string') { try { return decodedText(JSON.parse(value)) } catch { return value } }
  if (Array.isArray(value)) return value.map(decodedText).join('\n')
  return value && typeof value === 'object' ? Object.values(value).map(decodedText).join('\n') : String(value ?? '')
}
function assertDiscovery({ records, nativeId, wire, messageId, originalBody, messageModule, marker, model }) {
  const matches = records.filter(file => file.records[0]?.type === 'session_meta' && (file.records[0].payload.id ?? file.records[0].payload.session_id) === nativeId)
  assert.equal(matches.length, 1, 'The actual original native conversation is not unique')
  const main = matches[0], contexts = main.records.filter(record => record.type === 'turn_context').map(record => record.payload)
  assert.ok(contexts.length >= 2, 'Native startup and notification turn settings are missing')
  for (const context of contexts) { assert.equal(context.model, model, 'Actual native model differs from the qualified sample'); assert.equal(context.approval_policy, 'never'); assert.equal(context.sandbox_policy?.type, 'workspace-write') }
  const inputs = main.records.flatMap((record, index) => record.type === 'response_item' && record.payload?.type === 'message' && record.payload.role === 'user'
    ? [{ index, text: record.payload.content.filter(part => part.type === 'input_text').map(part => part.text).join('') }] : [])
  const notices = inputs.filter(input => input.text === wire)
  assert.equal(notices.length, 1, 'The original reference input was not adopted exactly once by this model')
  assert.ok(inputs.length >= 2, 'Startup and notification must remain distinct original native inputs')
  assert.ok(inputs.every(input => !input.text.includes(originalBody)), 'The model received the body before explicitly reading the original Inbox')
  const calls = main.records.flatMap((record, index) => record.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(record.payload?.type) ? [{ index, ...record.payload, arguments: record.payload.arguments ?? record.payload.input }] : [])
  const outputs = main.records.flatMap((record, index) => record.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(record.payload?.type) ? [{ index, ...record.payload }] : [])
  const completed = calls.map(call => ({ ...call, output: outputs.find(output => output.call_id === call.call_id) })).filter(call => call.output)
  const skill = completed.find(call => /\bmessage\s+--skill\b/u.test(call.arguments) && decodedText(call.output.output).includes(messageModule.trim()))
  assert.ok(skill, 'No actual consumption of this candidate message skill in the original Session')
  const read = completed.find(call => call.index > notices[0].index && call.index > skill.output.index && /\bmessage\s+read\b/u.test(call.arguments) && call.arguments.includes(messageId) && decodedText(call.output.output).includes(originalBody))
  assert.ok(read, 'No original MID/body read after consuming the message skill')
  assert.ok(!calls.some(call => /\b(?:agent\s+(?:open|submit|input|stop|resume)|terminal\s+(?:input|submit))\b/u.test(call.arguments)), 'Peer input expanded the authorized operations')
  const final = main.records.filter(record => record.type === 'response_item' && record.payload?.type === 'message' && record.payload.role === 'assistant')
    .flatMap(record => record.payload.content.filter(part => part.type === 'output_text').map(part => part.text)).join('\n')
  assert.ok(/\b42\b/u.test(final.replaceAll(marker, '')), 'The user did not receive the authorized arithmetic result')
  return { nativeId, nativeFile: main.path, inputCount: inputs.length, noticeInputIndex: notices[0].index,
    skillCallId: skill.call_id, originalReadCallId: read.call_id, final, originalWireSha256: hash(wire) }
}
try {
  await mkdir(evidence, { recursive: true, mode: 0o700 }); await recordOwnership()
  const coreRoot = config.coreRoot
  core = await import(pathToFileURL(join(coreRoot, 'dist/index.js')).href)
  const { nativeProcessBirth } = await import(pathToFileURL(join(coreRoot, 'dist/agent-native-process.js')).href)
  const { agentMuxModuleSkill } = await import(pathToFileURL(join(coreRoot, 'dist/agentmux-cli-module-skills.js')).href)
  const messageModule = agentMuxModuleSkill('message'); assert.ok(messageModule)
  const executablePath = await realpath(executable), executableInfo = await stat(executablePath)
  const version = await exec(executablePath, ['--version'])
  receipt.nativeExecutable = { path: executablePath, sha256: hash(await readFile(executablePath)),
    dev: executableInfo.dev, ino: executableInfo.ino, bytes: executableInfo.size, version: version.stdout.trim(),
    selectedMode: 'embedded-tui-durable-queue', qualification: 'pending-original-native-records' }
  assert.equal(version.stderr, '')
  // This is the explicitly selected finite sample, not a new Provider version claim.
  assert.equal(receipt.nativeExecutable.version, 'codex-cli 0.167.0', 'The actual native executable differs from the selected qualification sample')
  const runtime = environment.AGENTMUX_RUNTIME_DIRECTORY, state = environment.AGENTMUX_STATE_DIRECTORY
  daemon = spawn(join(coreRoot, 'vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
    ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'], { env: environment, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  const daemonIdentity = registerChild(daemon, nativeProcessBirth)
  ownership.daemonProcess = { pid: daemon.pid }; await recordOwnership()
  ownership.daemonProcess = await daemonIdentity; await recordOwnership(); daemon.stderr.resume()
  await bounded(new Promise((yes, no) => { daemon.stdio[3].once('data', yes); daemon.once('error', no); daemon.once('exit', code => no(Error('Private daemon exited ' + code))) }), 15_000, 'Private daemon readiness')
  const peerProvider = core.defineAgentProvider({ catalog: { id: 'proof-reference-peer', label: 'Private independent peer', executable: process.execPath,
    expectedProcess: 'node', promptDelivery: 'positional-argv', readySignal: { kind: 'foreground-process', expectedProcess: 'node' },
    hookStrategy: { kind: 'none' }, resumeStrategy: { kind: 'none' }, acpStrategy: { kind: 'none' },
    capabilities: { terminal: true, timeline: 'unavailable', permission: 'none', providerResume: false, replyCorrelation: 'none' } }, buildArgs: (prompt, args) => [...args, ...(prompt ? [prompt] : [])], hook: { rules: [] } })
  const store = new core.AgentMuxFileAgentSessionStore(environment.AGENTMUX_AGENT_SESSION_STORE)
  client = new core.AgentMuxClient({ store, providers: [...core.BUILT_IN_AGENT_PROVIDERS, peerProvider] }); client.onEvent(event => { if (event.type === 'agent-error') observedErrors.push(event) }); await client.connect()
  server = new core.AgentMuxControlServer({ socketPath: join(runtime, 'control.sock'), http: { host: '127.0.0.1', port: 0, token: config.httpToken }, coreClients: () => [{ hostId: 'local', client }] }); await server.start()
  assert.ok(server.httpAddress)
  Object.assign(environment, { AGENTMUX_RPC_ENDPOINT: `http://127.0.0.1:${server.httpAddress.port}/`, AGENTMUX_RPC_HTTP_TOKEN: config.httpToken })
  await exec('git', ['init', '--quiet', workspace])
  await writeFile(join(authHome, 'config.toml'), `model = ${JSON.stringify(model)}\nshell_environment_policy.inherit = "all"\nsandbox_workspace_write.network_access = true\n[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`, { mode: 0o600 })
  const wrapper = join(privateRoot, 'private-codex.mjs')
  await writeFile(wrapper, `#!${process.execPath}
import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
import {selfProcessIdentity,registerChild,signalChild} from ${JSON.stringify(pathToFileURL(join(config.fixturesRoot, 'a2a-agent-behavior/process.mjs')).href)};
import {nativeProcessBirth} from ${JSON.stringify(pathToFileURL(join(coreRoot, 'dist/agent-native-process.js')).href)};
const args=process.argv.slice(2), root=${JSON.stringify(privateRoot)}, executable=${JSON.stringify(executable)};
if(process.env.AGENTMUX_AGENT_CAPABILITY)writeFileSync(root+'/model-private-auth.json',JSON.stringify({agentSessionId:process.env.AGENTMUX_AGENT_SESSION_ID,capability:process.env.AGENTMUX_AGENT_CAPABILITY}),{mode:0o600});
if(args.includes('app-server')||args.includes('--remote'))throw Error('This sample requires the original embedded TUI launch');
const wrapperProcess=await selfProcessIdentity(nativeProcessBirth), nativeArgs=['--no-daemon',...args];
const receipt={wrapperPid:process.pid,wrapperProcess,modelProcess:null,modelOwnProcessGroup:false,args:nativeArgs};
const save=()=>writeFileSync(root+'/model-embedded-process.json',JSON.stringify(receipt),{mode:0o600});save();
const child=spawn(executable,nativeArgs,{env:process.env,stdio:'inherit'}), original=registerChild(child,nativeProcessBirth);
const failed=error=>{process.stderr.write(error.message+'\\n');process.exitCode=1};
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{void signalChild(child,signal).catch(failed)});
child.on('error',failed);child.on('exit',(code,signal)=>{process.exitCode ||= code??(signal?1:0)});
try{receipt.modelPid=child.pid;receipt.modelProcess={pid:child.pid};save();receipt.modelProcess=await original;save()}
catch(error){failed(error);receipt.identityError=error.message;try{save()}catch(saveError){failed(saveError)}}
`, { mode: 0o700 })
  const suffix = randomUUID(), marker = 'reference-proof-' + suffix
  const peer = await client.createAgent({ agentSessionId: 'peer-' + suffix, createOperationId: 'peer-create-' + suffix, providerId: peerProvider.id,
    executorId: 'private-peer', workspacePath: workspace, commandOverride: process.execPath,
    args: [join(config.fixturesRoot, 'a2a-agent-behavior/peer.mjs'), join(privateRoot, 'peer.bytes'), join(privateRoot, 'peer-process.json'), join(privateRoot, 'peer-private-auth.json'), coreRoot], env: environment, injectAgentMuxGuide: false })
  sessions.push(peer)
  const peerAuth = await until(() => readFile(join(privateRoot, 'peer-private-auth.json'), 'utf8').then(JSON.parse, () => null), Boolean, 'Core-issued peer credential', 10_000); secrets.add(peerAuth.capability)
  const task = `You have accepted a bounded arithmetic delegation from independent AgentMux Session ${peer.agentSessionId}. Your user authorizes computing its upcoming request and reporting one result to that same Session. Both Sessions belong to this same local Runtime; address the result with agent send --to-session ${peer.agentSessionId}. No other work is authorized. The request has not arrived yet; do not invent or guess it. Reply Ready and finish this turn. When an AgentMux message notification later arrives, handle it within this accepted responsibility and report the result to the user as well.`
  const modelSession = await client.createAgent({ agentSessionId: 'model-' + suffix, createOperationId: 'model-create-' + suffix,
    providerId: 'codex', executorId: 'private-real-model', workspacePath: workspace, commandOverride: wrapper,
    args: ['--model', model, '--sandbox', 'workspace-write', '--ask-for-approval', 'never', '--no-alt-screen'], env: environment, prompt: task, injectAgentMuxGuide: true })
  sessions.push(modelSession)
  const initialIdle = await until(async () => { await client.refreshAgentSession(modelSession.agentSessionId, modelSession.run); const status = await client.statusAgent(modelSession.agentSessionId); receipt.lastModelStatus = status; return status }, value => value.observation.semantic === 'idle' && value.session.nativeHandle?.sessionId, 'Actual model startup completion')
  assert.equal((await store.readMetadata(modelSession.agentSessionId)).nativeActor, undefined, 'The selected sample unexpectedly used a managed actor')
  receipt.nativeProcess = JSON.parse(await readFile(join(privateRoot, 'model-embedded-process.json'), 'utf8'))
  assert.equal(receipt.nativeProcess.wrapperPid, initialIdle.run.pid)
  assert.ok(receipt.nativeProcess.modelPid > 0)
  assert.equal(receipt.nativeProcess.args[0], '--no-daemon')
  assert.ok(!receipt.nativeProcess.args.some(argument => ['app-server', '--remote'].includes(argument)))
  receipt.original = { session: initialIdle.session, process: initialIdle.run, startupTaskSha256: hash(task), messageModuleSha256: hash(messageModule), model }
  const originalBody = `Accepted arithmetic delegation: compute 17 + 25 and send me one combined result. Include audit marker ${marker}. Explain the calculation briefly.`
  receipt.originalSend = { operationId: 'reference-send-' + suffix, messageId: 'reference-request-' + suffix }
  await save('original-send-intent.json', { ...receipt.originalSend, recipientSessionId: modelSession.agentSessionId, body: originalBody })
  ownership.peerReceipts.push('message-send-process.json'); await recordOwnership()
  const request = startPrivateCli(config.cli, ['agent', 'send', '--to-session', modelSession.agentSessionId, '--text', originalBody,
    '--operation-id', receipt.originalSend.operationId, '--message-id', receipt.originalSend.messageId],
    { env: { ...environment, AGENTMUX_AGENT_SESSION_ID: peer.agentSessionId, AGENTMUX_AGENT_CAPABILITY: peerAuth.capability }, cwd: workspace },
    join(privateRoot, 'message-send-process.json'), nativeProcessBirth)
  cliProcess = request.child
  const cli = await request.completed
  const sent = JSON.parse(cli.stdout); await save('original-send.json', sent)
  assert.equal(sent.ok, true); assert.equal(sent.result.deliveryMode, 'reference'); assert.equal(sent.result.delivery.state, 'queued')
  const messageId = sent.result.messageId
  assert.equal(messageId, receipt.originalSend.messageId)
  const outgoing = await until(() => client.listMessages({ participantSessionId: modelSession.agentSessionId, direction: 'outgoing', limit: 10 }), page => page.messages.length > 0, 'Actual model delegation result')
  assert.equal(outgoing.messages.length, 1, 'Accepted delegation generated more than one response')
  const reply = await client.readMessage({ messageId: outgoing.messages[0].envelope.messageId })
  assert.equal(reply.envelope.recipientSessionId, peer.agentSessionId); assert.ok(reply.envelope.body.includes(marker)); assert.match(reply.envelope.body.replaceAll(marker, ''), /\b42\b/u)
  await until(() => client.statusAgent(modelSession.agentSessionId), value => value.observation.semantic === 'idle' && value.session.semanticStatus?.nativeTurnId !== initialIdle.session.semanticStatus?.nativeTurnId, 'Actual model notification turn completion')
  const original = await client.readMessage({ messageId }); assert.ok(original.notification?.key)
  const input = await client.inspectAgentPromptSubmission(original.notification.key), wire = input?.admission?.intent?.prompt
  assert.ok(wire); assert.equal(original.notification.state, 'submitted'); assert.equal(original.delivery.state, 'queued')
  assert.notEqual(original.notification.key.submissionId, messageId); assert.equal(input.admission.intent.message.systemContext, wire)
  assert.equal(input.admission.transport, 'native')
  assert.equal(input.admission.native.outcome, 'admitted')
  assert.ok(input.admission.native.queuedSubmissionId)
  assert.equal(input.admission.native.plan.operation, 'queue-idle')
  assert.equal(input.admission.native.plan.protocolId, 'codex-durable-queue-0.163')
  assert.equal(input.admission.native.plan.threadId, initialIdle.session.nativeHandle.sessionId)
  assert.equal(input.admission.intent.message.a2aNotificationId, original.notification.notificationId); assert.equal(input.admission.intent.message.userContent, undefined); assert.equal(input.admission.intent.message.authorHuman, undefined); assert.equal(input.admission.intent.message.authorAgentSessionId, undefined)
  assert.ok(wire.includes(`msg-id="${messageId}"`) && wire.includes('read-via="message --skill"')); assert.ok(!wire.includes(originalBody))
  const records = await readPrivateNativeRecords(authHome); await save('native-records.json', records)
  const facts = { records, nativeId: initialIdle.session.nativeHandle.sessionId, wire, messageId, originalBody, messageModule, marker, model }
  const discovery = assertDiscovery(facts)
  receipt.nativeExecutable.qualification = 'original-native-records-and-admission-confirmed'
  const guardFacts = { ...facts, originalBody: originalBody + 'missing-original' }
  assert.throws(() => assertDiscovery(guardFacts), undefined, 'The original-body oracle accepted a foreign body')
  assert.throws(() => assertDiscovery({ ...facts, model: 'unrelated-model' }), undefined, 'The model oracle accepted another native model')
  assertDiscovery(facts)
  const queue = new core.DurableAgentMuxMessageQueue(environment.AGENTMUX_MESSAGE_QUEUE_PATH), journal = await queue.readJournal()
  assert.equal(journal.filter(record => record.kind === 'consumer-ack').length, 0, 'Reading the body advanced an Inbox consumer acknowledgement')
  assert.equal(journal.filter(record => record.kind === 'a2a-notification').length, 1, 'The same unread Inbox body generated repeated notifications')
  const modelAuth = await readFile(join(privateRoot, 'model-private-auth.json'), 'utf8').then(JSON.parse); secrets.add(modelAuth.capability)
  receipt.scenarios.push({ name: 'idle-reference-native-discovery', passed: true, originalMessageId: messageId, original, reply, discovery,
    nativeModelInputDistinctFromInboxBody: true, cursorAcknowledgementAbsent: true, oracleSensitivity: 'foreign original body and native model rejected; not implementation mutation' })
  receipt.boundary = 'One private actual Codex TUI/native actor sample through candidate public CLI, Core journal and Provider idle queue. Input acceptance, native adoption and explicit body read are separately checked; universal Agent adoption is not claimed.'
  receipt.passed = true
} catch (error) {
  receipt.failure = privateFailure(error, redact)
  receipt.agentErrors = observedErrors
  if (client && receipt.originalSend) {
    const original = await client.readMessage({ messageId: receipt.originalSend.messageId }).then(message => ({ message }), error => ({ unavailable: error.message }))
    await save('original-send-observation.json', { ...receipt.originalSend, ...original })
  }
}
finally {
  const errors = [], attempt = async action => { try { return await action() } catch (error) { errors.push(error.message) } }
  for (const name of ownership.credentialReceipts) { const credential = await readFile(join(privateRoot, name), 'utf8').then(JSON.parse, () => null); if (credential?.capability) secrets.add(credential.capability) }
  if (cliProcess) await attempt(() => terminate(cliProcess))
  const ownedSessions = client ? client.agentSessions() : sessions
  for (const session of ownedSessions.toReversed()) {
    if (client) await attempt(async () => { await save(session.agentSessionId.startsWith('model-') ? 'model-replay.json' : 'peer-replay.json', await client.readRunReplay(session.run)) })
    if (client) await attempt(async () => { const status = await client.statusAgent(session.agentSessionId); if (status.run.state === 'running') await bounded(client.stopAgent(session.agentSessionId, session.run), 10_000, 'Private original Run stop') })
  }
  if (server) await attempt(() => bounded(server.stop(), 10_000, 'Private RPC stop'))
  if (client) await attempt(() => bounded(client.dispose(), 10_000, 'Private Core disposal'))
  if (daemon) await attempt(() => terminate(daemon))
  if (core) await attempt(async () => save('message-journal.json', await new core.DurableAgentMuxMessageQueue(environment.AGENTMUX_MESSAGE_QUEUE_PATH).readJournal()))
  await attempt(async () => save('native-records.json', await readPrivateNativeRecords(authHome)))
  receipt.cleanup = { errors, exactDaemonPid: daemon?.pid, privateRootOwnedByLauncher: true, noHostProcessScan: true }
  if (errors.length) receipt.passed = false
  await mkdir(evidence, { recursive: true, mode: 0o700 }); await save('receipt.json', receipt)
}
process.stdout.write(JSON.stringify({ passed: receipt.passed, completeFeatureCoverage: false, finiteSample: true, receipt: join(evidence, 'receipt.json') }) + '\n')
if (!receipt.passed) process.exitCode = 1
