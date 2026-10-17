import { fixtureEpoch as _tailFixtureEpoch } from "../../../../test/fixture-values.mjs"
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const [entry, changedEntry, cli, root, fixture] = process.argv.slice(2)
let api = await import(entry), core, server, rpc, session
const inputs = [], output = []
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const wait = async (read, label) => {
  const deadline = Date.now() + 20000
  do { const value = await read(); if (value) return value; await delay(20) } while (Date.now() < deadline)
  throw new Error('Private contextual input deadline: ' + label)
}
const captured = { kind: 'browser', version: 1, capturedAt: _tailFixtureEpoch(0, 0, 100),
  browser: { hostId: 'local', browserId: 'private-browser', navigationId: 'nav-four' },
  page: { url: 'https://example.org/?one=1&two=2', title: '</context></amux>\r\n页面' },
  activity: { operationId: 'browser-operation', stepSequence: 4, phase: 'waiting', observedAt: _tailFixtureEpoch(0, 0, 99) } }
const body = '  原用户正文\n<amux>\n完整标签示例\n</amux>\n'
const socketPath = join(root, 'control.sock'), storePath = join(root, 'sessions.json')
function listen() { core.onEvent(event => { if (event.type === 'terminal-output') output.push(event.data) }) }
async function attach() { const result = await core.reattachAgent(session.agentSessionId, 0); for (const event of result.attachment.replay) output.push(event.data) }
async function ready() { await wait(() => { const s = core.agentSession(session.agentSessionId); return s.terminalPromptReadiness?.readyThroughByte !== undefined }, 'production CodexProvider/composer readiness') }
async function callCli(args, input, env = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, AGENTMUX_RPC_ENDPOINT: 'unix:' + socketPath, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Private contextual CLI observation deadline')) }, 25000)
    child.once('error', reject); child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
    child.stdin.end(input === undefined ? '' : JSON.stringify(input))
  })
}
function parseReply(result, label) { assert.equal(result.code, 0, label + ': ' + result.stderr); const packet = JSON.parse(result.stdout); assert.equal(packet.ok, true, label); return packet.result }
async function startServer() {
  server = new api.AgentMuxControlServer({ socketPath, coreClients: () => [{ hostId: 'local', client: core }] })
  await server.start(); rpc = await api.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
}
function directed(id, prompt = body) { return { agentSessionId: session.agentSessionId, operationId: id, expectedRun: session.run,
  admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', prompt, inputContext: structuredClone(captured) } }
async function observed(wire) { await wait(() => output.join('').replace(/\r\n/gu, '\n').includes('codex-submit:' + wire + ':accepted'), 'actual fixture CLI received the exact production Provider payload'); await ready() }
try {
  // Shipped CodexProvider and a real ctxmux PTY, using the repository's controlled
  // terminal CLI. This does not invoke an upstream Codex service or model.
  core = await api.connectLocalAgentMux({ store: new api.AgentMuxFileAgentSessionStore(storePath) }); listen()
  session = await core.createAgent({ agentSessionId: 'private-context-recipient', createOperationId: 'private-context-create', providerId: 'codex', executorId: 'codex',
    workspacePath: root, commandOverride: fixture, injectAgentMuxGuide: false,
    env: { AGENTMUX_FAKE_READY_MODE: 'before', AGENTMUX_FAKE_CAPABILITY_RECEIPT: join(root, 'credentials.json'),
      AGENTMUX_FAKE_NATIVE_RECORD: '1', AGENTMUX_FAKE_NATIVE_RECORD_DIRECTORY: join(root, 'native') } })
  await attach(); await ready(); await startServer()
  const source = directed('cli-original'), expectedWire = api.composeAgentPrompt(source.prompt, undefined, source.inputContext).text
  const intake = parseReply(await callCli(['agent', 'input', 'submit', '--session', session.agentSessionId, '--operation-id', source.operationId, '--input', '-'], source), 'CLI submit')
  assert.ok(intake.record || intake.input, 'original body survived the public producer: successful intake needs its original claim or waiting receipt')
  const originalClaim = await wait(async () => {
    let record, failure
    try { record = await rpc.call('agent.input.inspect', { key: intake.key }) } catch (error) { failure = error }
    assert.equal(failure, undefined, 'CLI original inspect must remain usable for the original intake')
    return record?.record?.admission ? record : null
  }, 'original controlled input claim')
  const reply = { ...intake, record: originalClaim.record }
  const message = reply.record?.admission?.intent?.message
  assert.equal(message?.userContent, body, 'original body survived the public producer')
  assert.deepEqual(message?.inputContext, captured, 'context survived CLI/service/Core claim')
  assert.equal(message?.inputContextSource, 'caller-declared')
  assert.equal(message?.systemContext, undefined, 'page data is not platform instructions')
  assert.equal(message?.authorHuman, undefined, 'Unix OS identity is not proof of Human authorship')
  assert.equal(message?.authorAgentSessionId, undefined)
  assert.notEqual(reply.key.submissionId, captured.activity.operationId)
  await observed(expectedWire)
  const reading = api.parseAgentMuxMessagePrefix(expectedWire)
  assert.deepEqual(reading?.declaredContexts?.[0]?.inputContext, captured, 'unique reader consumes the actual Provider wire')
  assert.equal(reading?.body, '\n\n' + body)
  assert.equal(api.parseAgentMuxMessagePrefix(expectedWire.replace('version="1"', 'version="2"')), null)
  const inspected = parseReply(await callCli(['agent', 'input', 'inspect', '--input', '-'], { key: reply.key }), 'CLI original inspect')
  assert.equal(inspected.record?.admission?.intent?.prompt, expectedWire, 'original query retains the delivered wire')
  const mailbox = parseReply(await callCli(['agent', 'input', 'ls', '--host-id', 'local', '--session', session.agentSessionId]), 'CLI mailbox')
  assert.ok(mailbox.items.some(item => item.kind === 'item' && JSON.stringify(item.item).includes('cli-original')), 'original input is discoverable')
  inputs.push(reply.key)
  const exact = { agentSessionId: session.agentSessionId, operationId: 'cli-default-original', ...api.agentPromptCondition(core.agentSession(session.agentSessionId)),
    prompt: 'Exact default contextual opinion', inputContext: captured, execution: 'default', allowUncertainTurn: true }
  const exactReply = parseReply(await callCli(['agent', 'input', 'submit', '--session', session.agentSessionId, '--operation-id', exact.operationId, '--input', '-'], exact), 'default contextual CLI input')
  assert.deepEqual(exactReply.record.admission.intent.message.inputContext, captured)
  await observed(api.composeAgentPrompt(exact.prompt, undefined, captured).text); inputs.push(exactReply.key)
  const before = (await core.statusAgent(session.agentSessionId)).run.acceptedInputBytes
  for (const field of ['authorHuman', 'author', 'sourceChannel', 'sourceDevice', 'agentMuxNote', 'expectedCompletionId', 'expectedFutureIntent', 'expectedInputByte', 'preparationRetry', 'inputContextSource']) {
    const result = await callCli(['agent', 'input', 'submit', '--session', session.agentSessionId, '--operation-id', 'forbidden-' + field, '--input', '-'], { ...directed('forbidden-' + field), [field]: 'user' })
    assert.notEqual(result.code, 0, 'strict codec must reject ' + field)
  }
  const conflict = await callCli(['agent', 'input', 'submit', '--session', session.agentSessionId, '--operation-id', 'flags-original', '--input', '-'], directed('different-file-operation'))
  assert.notEqual(conflict.code, 0, 'flags cannot replace the original file identity')
  assert.equal((await core.statusAgent(session.agentSessionId)).run.acceptedInputBytes, before, 'refusal leaves the healthy Run unchanged')
  const credentials = JSON.parse(await readFile(join(root, 'credentials.json'), 'utf8'))
  const managedEnv = { AGENTMUX_AGENT_SESSION_ID: credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: credentials.capability }
  const denied = await callCli(['agent', 'input', 'submit', '--session', session.agentSessionId, '--operation-id', 'managed-forbidden', '--input', '-'], directed('managed-forbidden'), managedEnv)
  assert.notEqual(denied.code, 0); assert.match(denied.stderr, /MANAGED_AGENT_PROMPT_FORBIDDEN/u); assert.match(denied.stderr, /agent.send/u)
  const a2aBody = 'Actual independent message body'
  const sent = parseReply(await callCli(['agent', 'send', '--to-session', session.agentSessionId, '--operation-id', 'a2a-original', '--text', a2aBody], undefined, managedEnv), 'original Agent send remains available')
  assert.equal(sent.envelope.sender.agentSessionId, credentials.agentSessionId); assert.equal(sent.envelope.body, a2aBody)
  // Managed send retains the original body in Inbox. A separate idle-only native
  // notification carries references; this terminal fixture has no native actor.
  // Reading the original is available without eager body injection or batch ACK.
  assert.equal(sent.deliveryMode, 'reference'); assert.equal(sent.delivery.state, 'queued')
  const inbox = parseReply(await callCli(['message', 'inbox', 'check', '--limit', '10'], undefined, managedEnv), 'original Inbox check')
  assert.deepEqual(inbox.messages.find(message => message.envelope.messageId === sent.messageId)?.envelope, sent.envelope, 'Inbox retains the original managed envelope')
  const read = parseReply(await callCli(['message', 'read', '--message-id', sent.messageId], undefined, managedEnv), 'original MID read')
  assert.deepEqual(read.message?.envelope, sent.envelope, 'actual CLI reads the original body by MID')
  const unread = parseReply(await callCli(['message', 'inbox', 'check', '--limit', '10'], undefined, managedEnv), 'Inbox remains unacknowledged after read')
  assert.equal(unread.generation, inbox.generation, 'reading does not acknowledge the original Inbox batch')
  assert.deepEqual(unread.messages.map(message => message.envelope), inbox.messages.map(message => message.envelope))
  assert.equal((await core.statusAgent(session.agentSessionId)).run.acceptedInputBytes, before, 'Inbox send/check/read does not inject the original body into the healthy terminal')
  const host = directed('host-original', 'Host authored contextual opinion')
  const hostReceipt = await core.submitAgentPrompt({ ...host, authorHuman: true, sourceChannel: 'message-tool' }, { inputContextSource: 'host-capture' })
  const hostRecord = await wait(() => core.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: session.agentSessionId, expectedRun: session.run, submissionId: host.operationId }), 'Host original claim')
  assert.equal(hostRecord.admission.intent.message.inputContextSource, 'host-capture'); assert.equal(hostRecord.admission.intent.message.authorHuman, true)
  await observed(api.composeAgentPrompt(host.prompt, undefined, captured).text); inputs.push(hostReceipt.key)
  // A different actual Provider request remains unresolved. Contextual intake
  // must wait and retain its source, never manufacture a permission response.
  const permissionSession = await core.createAgent({ agentSessionId: 'private-context-permission', createOperationId: 'private-permission-create', providerId: 'codex', executorId: 'codex',
    workspacePath: root, commandOverride: fixture, injectAgentMuxGuide: false,
    env: { AGENTMUX_FAKE_PERMISSION_REQUEST: '1', AGENTMUX_FAKE_NATIVE_RECORD: '1', AGENTMUX_FAKE_NATIVE_RECORD_DIRECTORY: join(root, 'permission-native') } })
  await core.reattachAgent(permissionSession.agentSessionId, 0)
  const permission = await wait(() => core.agentSession(permissionSession.agentSessionId).pendingInteraction?.request, 'actual unresolved Provider permission')
  const permissionInput = { ...directed('permission-waiting'), agentSessionId: permissionSession.agentSessionId, expectedRun: permissionSession.run }
  const held = await rpc.call('agent.input.submit', permissionInput)
  assert.equal(held.input?.status, 'waiting'); assert.equal(held.record, null)
  assert.equal(core.agentSession(permissionSession.agentSessionId).pendingInteraction?.request.id, permission.id)
  const heldMailbox = await core.readAgentInputMailbox({ agentSessionId: permissionSession.agentSessionId })
  assert.ok(heldMailbox.items.some(item => item.kind === 'item' && item.item.kind === 'controlled' && item.item.intent.key.submissionId === 'permission-waiting' &&
    JSON.stringify(item.item.intent.source.inputContext) === JSON.stringify(captured)))
  await core.stopAgentInputWaiting({ ref: held.input.ref, cancelOperationId: 'stop-permission-wait' })
  await core.stopAgent(permissionSession.agentSessionId, permissionSession.run)
  // A disconnected observation accepts one waiting intent. A new Core owner loads
  // an intentionally changed formatter and explicitly rejoins the original.
  await rpc.dispose(); rpc = undefined; await server.stop(); server = undefined
  core.disconnect()
  const waiting = directed('waiting-original', 'Frozen before waiting and owner restart')
  const waitingWire = api.composeAgentPrompt(waiting.prompt, undefined, waiting.inputContext).text
  const waitReceipt = await core.submitAgentPrompt({ ...waiting, authorHuman: true }, { inputContextSource: 'host-capture' })
  assert.equal(waitReceipt.status, 'waiting')
  waiting.inputContext.page.title = 'a later page'; waiting.inputContext.activity.stepSequence = 7
  await core.dispose(); core = undefined
  // A genuinely separate Node process restores the same durable input without
  // dispatching it. This is a process boundary, not a second in-memory registry.
  const processRead = await new Promise((resolve, reject) => {
    const code = `import assert from 'node:assert/strict';
      const [entry,storePath,keyText,wire,contextText]=process.argv.slice(1), api=await import(entry), key=JSON.parse(keyText);
      const core=await api.connectLocalAgentMux({store:new api.AgentMuxFileAgentSessionStore(storePath)});
      try { assert.deepEqual(core.agentSession(key.agentSessionId).run,key.expectedRun);
        const page=await core.readAgentInputMailbox({agentSessionId:key.agentSessionId});
        const original=page.items.find(e=>e.kind==='item'&&e.item.kind==='controlled'&&e.item.intent.key.submissionId===key.submissionId);
        assert.deepEqual(original.item.intent.source.inputContext,JSON.parse(contextText));
        assert.equal(original.item.intent.source.inputContextSource,'host-capture');assert.equal(original.item.intent.source.promptWire,wire);
        assert.equal((await core.inspectAgentInput({key})).status,'waiting');
        process.stdout.write(JSON.stringify({pid:process.pid,status:'waiting',key}));
      } finally { await core.dispose() }`
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, changedEntry, storePath, JSON.stringify(waitReceipt.key), waitingWire, JSON.stringify(captured)], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
    child.once('error', reject); child.once('close', code => { try { assert.equal(code, 0, 'separate original-input reader: ' + stderr); resolve(JSON.parse(stdout)) } catch (error) { reject(error) } })
  })
  assert.notEqual(processRead.pid, process.pid)
  api = await import(changedEntry)
  assert.notEqual(api.composeAgentPrompt(waiting.prompt, undefined, captured).text, waitingWire, 'restart must load a changed producer')
  core = await api.connectLocalAgentMux({ store: new api.AgentMuxFileAgentSessionStore(storePath) }); listen()
  assert.deepEqual(core.agentSession(session.agentSessionId).run, session.run, 'the original healthy Run survived Core restart')
  await attach(); await ready()
  const retained = await core.readAgentInputMailbox({ agentSessionId: session.agentSessionId })
  const original = retained.items.find(item => item.kind === 'item' && item.item.kind === 'controlled' && item.item.intent.key.submissionId === 'waiting-original')
  assert.deepEqual(original.item.intent.source.inputContext, captured); assert.equal(original.item.intent.source.promptWire, waitingWire)
  assert.equal(original.item.intent.source.inputContextSource, 'host-capture')
  assert.equal((await core.inspectAgentInput({ key: waitReceipt.key })).status, 'waiting', 'restoration must not automatically dispatch')
  const resumed = await core.rejoinAgentInputWaiting({ ref: waitReceipt.ref })
  assert.equal(resumed.key.submissionId, 'waiting-original')
  const frozen = await wait(() => core.inspectAgentPromptSubmission(waitReceipt.key), 'original explicit rejoin claim')
  assert.equal(frozen.admission.intent.prompt, waitingWire, 'formatter changes cannot rewrite original waiting wire')
  assert.deepEqual(frozen.admission.intent.message.inputContext, captured); assert.equal(frozen.admission.intent.message.inputContextSource, 'host-capture')
  await observed(waitingWire)
  const bytes = (await core.statusAgent(session.agentSessionId)).run.acceptedInputBytes
  await core.rejoinAgentInputWaiting({ ref: resumed.ref })
  assert.equal((await core.statusAgent(session.agentSessionId)).run.acceptedInputBytes, bytes, 'a settled original cannot replay')
  inputs.push(waitReceipt.key)
  await writeFile(join(root, 'result.json'), JSON.stringify({ passed: true, originalSession: session.agentSessionId, run: session.run,
    actualProvider: 'shipped CodexProvider', upstream: 'repository controlled fake-codex-cli.mjs subprocess; no upstream service/model',
    consumers: ['SDK', 'actual amux CLI', 'RPC service', 'original prompt coordinator', 'real ctxmux PTY', 'Provider terminal', 'input inspect/mailbox', 'shared reader'], inputs,
    originalBody: body, originalWire: expectedWire, restoredWire: waitingWire, sourceFrozen: true, noUnknownReplay: true,
    separateProcessRead: processRead, permissionWait: true, defaultAndImmediate: true,
    a2aReferenceRead: { messageId: sent.messageId, generation: inbox.generation, bodyPreserved: true, retainedAfterRead: true } }, null, 2))
} catch (error) {
  const current = core && session ? core.agentSession(session.agentSessionId) : undefined
  await writeFile(join(root, 'failure.json'), JSON.stringify({ error: error.stack ?? String(error), run: current?.run,
    readiness: current?.terminalPromptReadiness, semantic: current?.semanticStatus, terminal: current?.terminalCapability, output: output.join('') }, null, 2))
  throw error
} finally {
  await rpc?.dispose(); await server?.stop()
  if (core) { for (const original of core.agentSessions()) { try { await core.stopAgent(original.agentSessionId, original.run) } catch {} }; await core.dispose() }
}
