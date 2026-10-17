import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { bounded, terminate } from '../a2a-agent-behavior/process.mjs'
import { readPrivateNativeRecords } from '../a2a-agent-behavior/native-evidence.mjs'

const config = JSON.parse(await readFile(process.argv[2], 'utf8'))
const { repository, privateRoot, evidence, executable, model } = config
const workspace = join(privateRoot, 'workspace'), authHome = join(privateRoot, 'auth'), environment = { ...process.env }
assert.equal(environment.HOME, join(privateRoot, 'home')); assert.equal(environment.CODEX_HOME, authHome); assert.equal(process.cwd(), workspace)
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), exec = promisify(execFile)
const ownership = { daemonPid: null, runPids: [], modelReceipts: ['model-server-process.json', 'model-frontend-process.json'],
  peerReceipts: ['peer-process.json'], credentialReceipts: ['peer-private-auth.json', 'model-private-auth.json'] }
const recordOwnership = () => writeFile(join(privateRoot, 'owned-processes.json'), JSON.stringify(ownership), { mode: 0o600 })
const secrets = new Set([config.httpToken]), sessions = [], receipt = { schema: 'agentmux.a2a-reference-agent-proof.v1', passed: false,
  modelRequested: model, finiteSample: true, userRuntimeTouched: false, scenarios: [] }
const redact = value => [...secrets].reduce((text, secret) => text.replaceAll(secret, '[redacted-private-credential]'), value)
const save = (name, value) => writeFile(join(evidence, name), redact(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n'), { mode: 0o600 })
let client, server, daemon, interrupted = false
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
  const coreRoot = config.coreRoot ?? join(repository, 'packages/core'), core = await import(pathToFileURL(join(coreRoot, 'dist/index.js')).href)
  const { agentMuxModuleSkill } = await import(pathToFileURL(join(coreRoot, 'dist/agentmux-cli-module-skills.js')).href)
  const messageModule = agentMuxModuleSkill('message'); assert.ok(messageModule)
  assert.equal((await exec(executable, ['--version'])).stdout.trim(), 'codex-cli 0.163.0', 'The actual native actor version is not qualified')
  const runtime = environment.AGENTMUX_RUNTIME_DIRECTORY, state = environment.AGENTMUX_STATE_DIRECTORY
  daemon = spawn(join(coreRoot, 'vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
    ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'], { env: environment, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  ownership.daemonPid = daemon.pid; await recordOwnership(); daemon.stderr.resume()
  await bounded(new Promise((yes, no) => { daemon.stdio[3].once('data', yes); daemon.once('error', no); daemon.once('exit', code => no(Error('Private daemon exited ' + code))) }), 15_000, 'Private daemon readiness')
  const peerProvider = core.defineAgentProvider({ catalog: { id: 'proof-reference-peer', label: 'Private independent peer', executable: process.execPath,
    expectedProcess: 'node', promptDelivery: 'positional-argv', readySignal: { kind: 'foreground-process', expectedProcess: 'node' },
    hookStrategy: { kind: 'none' }, resumeStrategy: { kind: 'none' }, acpStrategy: { kind: 'none' },
    capabilities: { terminal: true, timeline: 'unavailable', permission: 'none', providerResume: false, replyCorrelation: 'none' } }, buildArgs: (prompt, args) => [...args, ...(prompt ? [prompt] : [])], hook: { rules: [] } })
  client = new core.AgentMuxClient({ store: new core.AgentMuxFileAgentSessionStore(environment.AGENTMUX_AGENT_SESSION_STORE), providers: [...core.BUILT_IN_AGENT_PROVIDERS, peerProvider] }); client.onEvent(event => { if (event.type === 'agent-error') observedErrors.push(event) }); await client.connect()
  server = new core.AgentMuxControlServer({ socketPath: join(runtime, 'control.sock'), http: { host: '127.0.0.1', port: 0, token: config.httpToken }, coreClients: () => [{ hostId: 'local', client }] }); await server.start()
  assert.ok(server.httpAddress)
  Object.assign(environment, { AGENTMUX_RPC_ENDPOINT: `http://127.0.0.1:${server.httpAddress.port}/`, AGENTMUX_RPC_HTTP_TOKEN: config.httpToken })
  await exec('git', ['init', '--quiet', workspace])
  await writeFile(join(authHome, 'config.toml'), `model = ${JSON.stringify(model)}\nshell_environment_policy.inherit = "all"\nsandbox_workspace_write.network_access = true\n[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`, { mode: 0o600 })
  const wrapper = join(privateRoot, 'private-codex.mjs')
  await writeFile(wrapper, `#!${process.execPath}\nimport {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
const args=process.argv.slice(2), root=${JSON.stringify(privateRoot)}, executable=${JSON.stringify(executable)};
if(process.env.AGENTMUX_AGENT_CAPABILITY)writeFileSync(root+'/model-private-auth.json',JSON.stringify({agentSessionId:process.env.AGENTMUX_AGENT_SESSION_ID,capability:process.env.AGENTMUX_AGENT_CAPABILITY}),{mode:0o600});
const nativeArgs=args.includes('--remote')?args:['--no-daemon',...args], child=spawn(executable,nativeArgs,{env:process.env,stdio:'inherit'}), name=args.includes('app-server')?'model-server-process.json':args.includes('--remote')?'model-frontend-process.json':null;
if(name)writeFileSync(root+'/'+name,JSON.stringify({wrapperPid:process.pid,modelPid:child.pid,modelOwnProcessGroup:false,args:nativeArgs}),{mode:0o600});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));child.on('error',()=>{process.exitCode=1});child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0)});\n`, { mode: 0o700 })
  const suffix = randomUUID(), marker = 'reference-proof-' + suffix
  const peer = await client.createAgent({ agentSessionId: 'peer-' + suffix, createOperationId: 'peer-create-' + suffix, providerId: peerProvider.id,
    executorId: 'private-peer', workspacePath: workspace, commandOverride: process.execPath,
    args: [join(config.fixturesRoot, 'a2a-agent-behavior/peer.mjs'), join(privateRoot, 'peer.bytes'), join(privateRoot, 'peer-process.json'), join(privateRoot, 'peer-private-auth.json')], env: environment, injectAgentMuxGuide: false })
  sessions.push(peer)
  const peerAuth = await until(() => readFile(join(privateRoot, 'peer-private-auth.json'), 'utf8').then(JSON.parse, () => null), Boolean, 'Core-issued peer credential', 10_000); secrets.add(peerAuth.capability)
  const task = `You have accepted a bounded arithmetic delegation from independent AgentMux Session ${peer.agentSessionId}. Your user authorizes computing its upcoming request and reporting one result to that same Session. No other work is authorized. The request has not arrived yet; do not invent or guess it. Reply Ready and finish this turn. When an AgentMux message notification later arrives, handle it within this accepted responsibility and report the result to the user as well.`
  const modelSession = await client.createAgent({ agentSessionId: 'model-' + suffix, createOperationId: 'model-create-' + suffix,
    providerId: 'codex', executorId: 'private-real-model', workspacePath: workspace, commandOverride: wrapper,
    args: ['--model', model, '--sandbox', 'workspace-write', '--ask-for-approval', 'never', '--no-alt-screen'], env: environment, prompt: task, injectAgentMuxGuide: true })
  sessions.push(modelSession)
  ownership.runPids = (await client.listRuns()).filter(run => sessions.some(session => session.run.runId === run.runId)).map(run => run.pid); await recordOwnership()
  const initialIdle = await until(async () => { await client.refreshAgentSession(modelSession.agentSessionId, modelSession.run); const status = await client.statusAgent(modelSession.agentSessionId); receipt.lastModelStatus = status; return status }, value => value.observation.semantic === 'idle' && value.session.nativeHandle?.sessionId, 'Actual model startup completion')
  receipt.original = { session: initialIdle.session, process: initialIdle.run, startupTaskSha256: hash(task), messageModuleSha256: hash(messageModule), model }
  const originalBody = `Accepted arithmetic delegation: compute 17 + 25 and send me one combined result. Include audit marker ${marker}. Explain the calculation briefly.`
  const cli = await exec(config.cli, ['agent', 'send', '--to-session', modelSession.agentSessionId, '--text', originalBody], { env: { ...environment, AGENTMUX_AGENT_SESSION_ID: peer.agentSessionId, AGENTMUX_AGENT_CAPABILITY: peerAuth.capability }, cwd: workspace, timeout: 15_000 })
  const sent = JSON.parse(cli.stdout); await save('original-send.json', sent)
  assert.equal(sent.ok, true); assert.equal(sent.result.deliveryMode, 'reference'); assert.equal(sent.result.delivery.state, 'queued')
  const messageId = sent.result.messageId
  const outgoing = await until(() => client.listMessages({ participantSessionId: modelSession.agentSessionId, direction: 'outgoing', limit: 10 }), page => page.messages.length > 0, 'Actual model delegation result')
  assert.equal(outgoing.messages.length, 1, 'Accepted delegation generated more than one response')
  const reply = await client.readMessage({ messageId: outgoing.messages[0].envelope.messageId })
  assert.equal(reply.envelope.recipientSessionId, peer.agentSessionId); assert.ok(reply.envelope.body.includes(marker)); assert.match(reply.envelope.body.replaceAll(marker, ''), /\b42\b/u)
  await until(() => client.statusAgent(modelSession.agentSessionId), value => value.observation.semantic === 'idle' && value.session.semanticStatus?.nativeTurnId !== initialIdle.session.semanticStatus?.nativeTurnId, 'Actual model notification turn completion')
  const original = await client.readMessage({ messageId }); assert.ok(original.notification?.key)
  const input = await client.inspectAgentPromptSubmission(original.notification.key), wire = input?.admission?.intent?.prompt
  assert.ok(wire); assert.equal(original.notification.state, 'submitted'); assert.equal(original.delivery.state, 'queued')
  assert.notEqual(original.notification.key.submissionId, messageId); assert.equal(input.admission.intent.message.systemContext, wire)
  assert.equal(input.admission.intent.message.a2aNotificationId, original.notification.notificationId); assert.equal(input.admission.intent.message.userContent, undefined); assert.equal(input.admission.intent.message.authorHuman, undefined); assert.equal(input.admission.intent.message.authorAgentSessionId, undefined)
  assert.ok(wire.includes(`msg-id="${messageId}"`) && wire.includes('read-via="message --skill"')); assert.ok(!wire.includes(originalBody))
  const records = await readPrivateNativeRecords(authHome); await save('native-records.json', records)
  const facts = { records, nativeId: initialIdle.session.nativeHandle.sessionId, wire, messageId, originalBody, messageModule, marker, model }
  const discovery = assertDiscovery(facts)
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
} catch (error) { receipt.failure = { message: redact(error.message), code: error.code, stack: redact(error.stack ?? '') }; receipt.agentErrors = observedErrors; await save('native-records.json', await readPrivateNativeRecords(authHome).catch(error => ({ unavailable: error.message }))) }
finally {
  const errors = [], attempt = async action => { try { return await action() } catch (error) { errors.push(error.message) } }
  for (const name of ownership.credentialReceipts) { const credential = await readFile(join(privateRoot, name), 'utf8').then(JSON.parse, () => null); if (credential?.capability) secrets.add(credential.capability) }
  const ownedSessions = client ? client.agentSessions() : sessions
  if (client) await attempt(async () => { ownership.runPids = (await client.listRuns()).filter(run => ownedSessions.some(session => session.run.runId === run.runId)).map(run => run.pid); await recordOwnership() })
  for (const session of ownedSessions.toReversed()) {
    if (client) await attempt(async () => { await save(session.agentSessionId.startsWith('model-') ? 'model-replay.json' : 'peer-replay.json', await client.readRunReplay(session.run)) })
    if (client) await attempt(async () => { const status = await client.statusAgent(session.agentSessionId); if (status.run.state === 'running') await bounded(client.stopAgent(session.agentSessionId, session.run), 10_000, 'Private original Run stop') })
  }
  if (server) await attempt(() => bounded(server.stop(), 10_000, 'Private RPC stop'))
  if (client) await attempt(() => bounded(client.dispose(), 10_000, 'Private Core disposal'))
  if (daemon) await attempt(() => terminate(daemon))
  receipt.cleanup = { errors, exactDaemonPid: daemon?.pid, privateRootOwnedByLauncher: true, noHostProcessScan: true }
  if (errors.length) receipt.passed = false
  await mkdir(evidence, { recursive: true, mode: 0o700 }); await save('receipt.json', receipt)
}
process.stdout.write(JSON.stringify({ passed: receipt.passed, completeFeatureCoverage: false, finiteSample: true, receipt: join(evidence, 'receipt.json') }) + '\n')
if (!receipt.passed) process.exitCode = 1
