import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startHeadlessAgentMux } from '../../../src/headless-runtime.ts'
import { agentInteractionActiveRequest } from '../../../src/agent-interaction-state.ts'

const root = process.env.AGENTMUX_CLAUDE_PERMISSION_ROOT
assert(root && resolve(root) === root, 'A private proof directory is required')
const packageRoot = fileURLToPath(new URL('../../../', import.meta.url))
const modelRequests = [], sessions = [], children = [], cleanupErrors = [], cliReceipts = [], cases = [], sockets = new Set()
let runtime, native, failure
const wait = async (test, message, milliseconds = 20000) => {
  const end = performance.now() + milliseconds
  while (performance.now() < end) { if (await test()) return; await new Promise(resolve => setTimeout(resolve, 50)) }
  assert.fail(message)
}
const run = (command, args, env = process.env, input = '') => new Promise((yes, no) => {
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child)
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
  child.once('error', no); child.once('close', (code, signal) => yes({ code, signal, stdout, stderr }))
  child.stdin.end(input)
})
const cli = async (args, input = '') => {
  const result = await run(process.execPath, [join(packageRoot, 'bin/amux'), '--endpoint', `unix:${runtime.socketPath}`, ...args], process.env, input)
  const packets = [...result.stdout.split('\n'), ...result.stderr.split('\n')].flatMap(line => { try { const packet = JSON.parse(line); return typeof packet.ok === 'boolean' ? [packet] : [] } catch { return [] } })
  assert.equal(packets.length, 1, 'The actual object CLI returns one operation envelope')
  const receipt = { args, ...result, packet: packets[0] }; cliReceipts.push(receipt); return receipt
}
const model = createServer(async (request, response) => {
  try {
    let text = ''; for await (const bytes of request) text += bytes
    if (!request.url.includes('/messages')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}'); return }
    if (request.url.includes('count_tokens')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"input_tokens":100}'); return }
    const body = JSON.parse(text); modelRequests.push(body)
    const prompt = JSON.stringify(body.messages), mode = prompt.includes('CASE_DENY') ? 'deny' : 'allow'
    const results = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(value => value.type === 'tool_result')
    const content = results.length ? [{ type: 'text', text: 'NATIVE_PERMISSION_COMPLETE' }] : [{ type: 'tool_use', id: `toolu_permission_${mode}`, name: 'Bash',
      input: { command: `printf ${mode} > '${join(root, mode, 'effect.txt')}'`, description: 'Write one private permission proof sentinel' } }]
    const message = { id: 'msg_permission_' + modelRequests.length, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content,
      stop_reason: results.length ? 'end_turn' : 'tool_use', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 30 } }
    if (!body.stream) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(message)); return }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`)
    send('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } })
    for (const [index, part] of content.entries()) {
      send('content_block_start', { type: 'content_block_start', index, content_block: part.type === 'text' ? { type: 'text', text: '' } : { type: 'tool_use', id: part.id, name: part.name, input: {} } })
      send('content_block_delta', { type: 'content_block_delta', index, delta: part.type === 'text' ? { type: 'text_delta', text: part.text } : { type: 'input_json_delta', partial_json: JSON.stringify(part.input) } })
      send('content_block_stop', { type: 'content_block_stop', index })
    }
    send('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 30 } })
    send('message_stop', { type: 'message_stop' }); response.end()
  } catch (error) { failure ??= error; response.writeHead(500); response.end(String(error)) }
})
model.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
try {
  const version = await run('claude', ['--version']); assert.equal(version.code, 0); assert.match(version.stdout, /Claude Code/u)
  for (const directory of ['home', 'claude', 'runtime', 'state', 'allow', 'deny']) await mkdir(join(root, directory), { recursive: true, mode: 0o700 })
  await writeFile(join(root, 'claude/.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: Object.fromEntries(['allow', 'deny'].map(mode => [join(root, mode), { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true }])) }))
  const ask = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask"}}'` }] }] } }
  for (const mode of ['allow', 'deny']) { await mkdir(join(root, mode, '.claude')); await writeFile(join(root, mode, '.claude/settings.json'), JSON.stringify(ask)) }
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${model.address().port}`
  process.env.ANTHROPIC_AUTH_TOKEN = 'isolated-permission-proof'
  native = spawn(join(packageRoot, 'vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
    ['--socket', join(root, 'runtime/ctxmux.sock'), '--state-dir', join(root, 'state/ctxmux'), '--readiness-fd', '3'], { env: process.env, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  let nativeError = ''; native.stderr.on('data', bytes => { nativeError += bytes })
  await Promise.race([once(native.stdio[3], 'data'), once(native, 'exit').then(() => assert.fail('Private ctxmux exited before readiness: ' + nativeError))])
  runtime = await startHeadlessAgentMux(); await runtime.client.connect()
  for (const mode of ['allow', 'deny']) {
    const created = await runtime.client.createAgent({ providerId: 'claude', executorId: 'claude', workspacePath: join(root, mode), injectAgentMuxGuide: false,
      prompt: `CASE_${mode.toUpperCase()}: perform the one supplied Bash tool and then finish.`,
      args: ['--model', 'claude-sonnet-4-6', '--setting-sources', 'project'], cols: 100, rows: 30 })
    sessions.push(created)
    let pending
    await wait(async () => { pending = (await runtime.client.readAgentSession(created.agentSessionId))?.pendingInteraction?.request; return pending?.kind === 'permission' }, 'Real Claude must publish its original permission request')
    assert.equal(pending.kind, 'permission')
    assert(pending.permissionHook, 'Real Claude must keep the original native permission callback addressable')
    // A native security plugin may intentionally pass classic hooks over our module.
    // The exact callback remains answerable without borrowing a nearby invocation ID.
    if (pending.nativeToolCallId) assert.equal(pending.nativeToolCallId, `toolu_permission_${mode}`)
    assert.deepEqual(pending.options.map(item => item.id), ['allow-once', 'reject-once'], 'Only the declared one-shot native decisions may be offered')
    if (mode === 'allow') {
      await new Promise(resolve => setTimeout(resolve, 11000))
      pending = (await runtime.client.readAgentSession(created.agentSessionId)).pendingInteraction.request
      assert.equal(pending.permissionHook.closed, undefined, 'The original callback remains open beyond the short observer timeout')
    }
    const operationId = `permission-${mode}`, response = { kind: 'permission', requestId: pending.id, decision: { outcome: 'selected', optionId: mode === 'allow' ? 'allow-once' : 'reject-once' } }
    const beforeBytes = (await runtime.client.statusAgent(created.agentSessionId)).run.acceptedInputBytes
    assert.equal(typeof beforeBytes, 'number', 'Real Runtime must confirm its ordered input position')
    const input = { agentSessionId: created.agentSessionId, expectedRun: created.run, expectedRequest: pending, operationId, response }
    const wrong = await cli(['agent', 'interaction', 'respond', '--input', '-'], JSON.stringify({ ...input, expectedRun: { runId: 'foreign-run' } }))
    assert.equal(wrong.packet.ok, false); assert.equal(wrong.packet.error.code, 'STALE_AGENT_SESSION')
    const answered = await cli(['agent', 'interaction', 'respond', '--input', '-'], JSON.stringify(input))
    assert.equal(answered.packet.ok, true, 'Actual object CLI must deliver the exact native decision: ' + JSON.stringify(answered.packet))
    assert.equal(answered.packet.result.delivery, 'hook-written'); assert.equal(answered.packet.result.nativeAdoption, 'unknown')
    const afterBytes = (await runtime.client.statusAgent(created.agentSessionId)).run.acceptedInputBytes
    assert.equal(afterBytes, beforeBytes, 'Semantic decision delivery must not write any PTY input bytes')
    await wait(async () => !agentInteractionActiveRequest((await runtime.client.readAgentSession(created.agentSessionId)).pendingInteraction),
      'A decision returned on the original callback must leave the active human-answer projection')
    await wait(async () => modelRequests.some(body => body.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'tool_result' && part.tool_use_id === `toolu_permission_${mode}`))), 'Real Claude must consume the exact tool result')
    const effect = await readFile(join(root, mode, 'effect.txt'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
    assert.equal(effect, mode === 'allow' ? mode : null, 'Native allow executes exactly the private tool; native deny executes nothing')
    const repeated = await cli(['agent', 'interaction', 'respond', '--input', '-'], JSON.stringify(input))
    assert.equal(repeated.packet.ok, true); assert.equal(repeated.packet.result.operationId, operationId)
    assert.equal(await readFile(join(root, mode, 'effect.txt'), 'utf8').catch(() => null), effect)
    const inspected = await cli(['agent', 'interaction', 'inspect', '--session', created.agentSessionId, '--operation-id', operationId])
    assert.equal(inspected.packet.ok, true)
    if (pending.nativeToolCallId) assert(inspected.packet.result.nativeCompleted)
    else {
      assert.equal(inspected.packet.result.nativeCompleted, undefined, 'An unreported invocation ID cannot claim exact Native completion')
      assert((await runtime.client.readAgentSession(created.agentSessionId)).pendingInteraction, 'Original unbound request and response remain inspectable')
    }
    const installed = JSON.parse(await readFile(join(root, mode, '.claude/settings.json'), 'utf8'))
    cases.push({ mode, agentSessionId: created.agentSessionId, run: created.run, request: pending, operation: inspected.packet.result, effect, beforeBytes, afterBytes,
      managedPermissionHooks: installed.hooks.PermissionRequest, actualCli: true })
  }
  assert.equal(failure, undefined)
  await writeFile(join(root, 'native-proof.json'), JSON.stringify({ passed: true, nativeVersion: version.stdout.trim(), cases, cliReceipts, modelRequests: modelRequests.length }, null, 2))
} catch (error) {
  failure = error
  const originals = []
  for (const session of sessions) {
    try {
      const record = await runtime.client.readAgentSession(session.agentSessionId)
      const replay = await runtime.client.readRunReplay(session.run, 0, 'raw')
      originals.push({ session: record, replay: Buffer.concat(replay.replay.map(chunk => Buffer.from(chunk.dataBytes))).toString() })
    } catch (observation) { originals.push({ agentSessionId: session.agentSessionId, run: session.run, unavailable: String(observation) }) }
  }
  await writeFile(join(root, 'failure.json'), JSON.stringify({ name: error.name, message: error.message, stack: error.stack, cliReceipts, cases, modelRequests, originals }, null, 2))
}
finally {
  for (const session of sessions) { try { await runtime.client.stopAgent(session.agentSessionId, session.run) } catch (error) { cleanupErrors.push(String(error)) } }
  try { await runtime?.stop() } catch (error) { cleanupErrors.push(String(error)) }
  if (native && native.exitCode === null && native.signalCode === null) { const closed = once(native, 'close'); native.kill('SIGTERM'); await closed }
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill('SIGTERM'); await closed }
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => model.close(resolve))
  await writeFile(join(root, 'cleanup.json'), JSON.stringify({ passed: cleanupErrors.length === 0, errors: cleanupErrors }, null, 2))
}
if (failure) throw failure
assert.deepEqual(cleanupErrors, [])
