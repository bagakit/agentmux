import { fixturePath as _tailFixturePath } from "../../../test/fixture-values.mjs"
import { afterEach, expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'
import { runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxFileAgentSessionStore } from '../dist/index.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it.runIf(process.platform === 'darwin').each([
  ['connection deadline', 'Error: account route request timed out\nCaused by: connection deadline exceeded'],
  ['configuration access', "Configuration could not be loaded:\nPermission denied while reading " + _tailFixturePath("private/example/config")]
])('public CLI Resume reopens only the frontend after %s on the same live Runtime and native actor, with the original diagnostic, a fresh handshake and no old prompt', async (_shape, diagnostic) => {
  const scope = await headlessFixture(); cleanup.push(scope.cleanup)
  const sdk = await scope.client()
  const program = join(scope.root, 'private-codex.mjs'), events = join(scope.root, 'frontend.ndjson'), detach = join(scope.root, 'detach')
  const transcript = join(scope.root, 'rollout-private.jsonl'), heartbeat = join(scope.root, 'heartbeat'), nativeRequests = join(scope.root, 'native-requests.ndjson')
  const sid = '00000000-0000-4000-8000-000000000001'
  await writeFile(program, `#!/usr/bin/env node
import NativeWebSocket from ${JSON.stringify(createRequire(import.meta.url).resolve('ws'))}
import {appendFileSync,openSync,writeSync,writeFileSync,existsSync} from 'node:fs'
const args=process.argv.slice(2),events=${JSON.stringify(events)},detach=${JSON.stringify(detach)},sid=${JSON.stringify(sid)}
if(args.includes('--version')) {console.log('codex-cli 0.163.0');process.exit(0)}
if(args.includes('--help')) {console.log('codex resume --no-alt-screen --sandbox --ask-for-approval');process.exit(0)}
if(args.includes('app-server')) {
  const fd=openSync(${JSON.stringify(transcript)},'a')
  writeSync(fd,JSON.stringify({type:'session_meta',payload:{id:sid,source:'cli',thread_source:'user',cwd:process.cwd()}})+'\\n')
  writeSync(fd,JSON.stringify({type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'task_started',turn_id:'original-turn'}})+'\\n')
  setInterval(()=>writeFileSync(${JSON.stringify(heartbeat)},JSON.stringify({pid:process.pid,at:Date.now()})),20)
  const server=new NativeWebSocket.WebSocketServer({port:0,host:'127.0.0.1'})
  server.on('connection',(ws,req)=>{if(req.headers.authorization!=='Bearer '+process.env.AGENTMUX_CODEX_ACTOR_TOKEN)return ws.close()
    ws.on('message',bytes=>{const p=JSON.parse(String(bytes));if(!Object.hasOwn(p,'id'))return
      if(p.method==='turn/start') {appendFileSync(${JSON.stringify(nativeRequests)},JSON.stringify(p)+'\\n');if(p.params.input[0].text.includes('UNKNOWN_INPUT_MUST_REMAIN_ONCE'))return ws.close()}
      ws.send(JSON.stringify({jsonrpc:'2.0',id:p.id,result:p.method==='thread/read'?{thread:{id:sid,sessionId:'same-loaded-object',canAcceptDirectInput:true}}:p.method==='turn/start'?{turn:{id:'confirmed-native-turn'}}:{}}))})})
} else {
  const reconnect=args.includes('resume')
  appendFileSync(events,JSON.stringify({type:'spawn',args,pid:process.pid})+'\\n')
  process.stdin.setRawMode(true)
  let query=false,ready=false
  process.stdin.on('data',bytes=>{if(String(bytes).includes('\\x1b[?0u')){
    appendFileSync(events,JSON.stringify({type:'handshake',query,reconnect,pid:process.pid})+'\\n')
    ready=true;process.stdout.write('\\x1b[?2026h› \\x1b[?2026l')
  }else process.stdout.write('OBSERVED:'+String(bytes))})
  setTimeout(()=>{query=true;process.stdout.write('\\x1b[?u')},reconnect?350:0)
  setInterval(()=>{if(!reconnect&&ready&&existsSync(detach))process.stderr.write(${JSON.stringify(diagnostic)}+'\\n',()=>process.exit(1))},20)
}
`, { mode: 0o700 })
  const original = await sdk.createAgent({ providerId: 'codex', executorId: 'codex', agentSessionId: 'managed-frontend-public',
    createOperationId: 'managed-frontend-create', workspacePath: scope.root, commandOverride: program,
    prompt: 'ORIGINAL_CREATION_PROMPT_MUST_NOT_REPLAY', injectAgentMuxGuide: false })
  cleanup.push(async () => { await sdk.stopAgent(original.agentSessionId, original.run).catch(() => {}) })
  const terminalOutput: string[] = []
  const off = sdk.onEvent(event => { if (event.type === 'terminal-output') terminalOutput.push(event.data) })
  cleanup.push(async () => off())
  const attachment = await sdk.reattachAgent(original.agentSessionId, 0)
  expect(attachment.attachment.run.runId).toBe(original.run.runId)
  const before = await until(() => sdk.statusAgent(original.agentSessionId), value => value.session.nativeHandle?.sessionId === sid && value.session.terminalFrontend?.state === 'attached', 'initial exact actor')
  const store = new AgentMuxFileAgentSessionStore(scope.env.AGENTMUX_AGENT_SESSION_STORE!)
  const originalPrivate = await store.readMetadata(original.agentSessionId)
  const backend = JSON.parse(await readFile(heartbeat, 'utf8'))
  await writeFile(detach, 'exit original frontend')
  const detached = await until(() => sdk.statusAgent(original.agentSessionId), value => value.session.terminalFrontend?.state === 'detached', 'detached frontend')
  expect(detached.run).toMatchObject({ runId: before.run.runId, pid: before.run.pid, state: 'running' })
  expect(detached.session.terminalFrontend).toMatchObject({ exitCode: 1, message: diagnostic })
  await until(() => terminalOutput.join(''), value => value.includes(diagnostic.replaceAll('\n', '\r\n')), 'original stderr bytes remain in the terminal PTY')
  expect(detached.observation.readiness).toBe('pending')
  const laterHeartbeat = await until(async () => JSON.parse(await readFile(heartbeat, 'utf8')), value => value.at > backend.at, 'backend task continues')
  expect(laterHeartbeat.pid).toBe(backend.pid)
  const nativeInput = (operationId: string, prompt: string) => ({ agentSessionId: original.agentSessionId, expectedRun: original.run, operationId,
    admissionIntent: { kind: 'native-conversation' as const, source: { providerId: 'codex', nativeSessionId: sid } },
    execution: 'immediate' as const, prompt, authorHuman: true })
  await sdk.submitAgentPrompt(nativeInput('detached-native-input', 'NATIVE_INPUT_WORKS_WITHOUT_TUI'))
  try {
    await until(() => sdk.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: original.agentSessionId, expectedRun: original.run, submissionId: 'detached-native-input' }),
      value => value?.admission?.transport === 'native' && value.admission.native.outcome === 'admitted', 'independent healthy native route')
  } catch (error) {
    throw new Error(String(error) + '\n' + JSON.stringify({ input: await sdk.inspectAgentInput({ key: { kind: 'prompt', agentSessionId: original.agentSessionId,
      expectedRun: original.run, submissionId: 'detached-native-input' } }), status: await sdk.statusAgent(original.agentSessionId),
      nativeRequests: await readFile(nativeRequests, 'utf8').catch(() => 'none') }))
  }
  await sdk.submitAgentPrompt(nativeInput('unknown-original-input', 'UNKNOWN_INPUT_MUST_REMAIN_ONCE'))
  const unknown = await until(() => sdk.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: original.agentSessionId, expectedRun: original.run, submissionId: 'unknown-original-input' }),
    value => value?.admission?.transport === 'native' && value.admission.native.outcome === 'unknown', 'original unknown native receipt')
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: scope.socketPath } }); cleanup.push(() => rpc.dispose())
  const inspected = await rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: original.agentSessionId } })
  expect(inspected.session.terminalFrontend).toEqual(detached.session.terminalFrontend)
  const cliInspect = await runCompiledObjectCli(['--endpoint', `unix:${scope.socketPath}`, 'agent', 'inspect', '--session', original.agentSessionId], scope.env)
  expect(cliInspect.code, cliInspect.stderr + cliInspect.stdout).toBe(0)
  expect(JSON.parse(cliInspect.stdout).result.session.terminalFrontend.message).toBe(diagnostic)
  const args = ['--endpoint', `unix:${scope.socketPath}`, 'agent', 'resume', '--session', original.agentSessionId, '--operation-id', 'same-public-frontend-resume']
  const cli = await runCompiledObjectCli(args, scope.env)
  expect(cli.code, cli.stderr + cli.stdout).toBe(0)
  const after = await until(() => sdk.statusAgent(original.agentSessionId), value => value.session.terminalHandshake?.frontendId !== undefined &&
    value.session.terminalHandshake.acknowledged && value.session.terminalFrontend?.state === 'attached', 'reconnected new frontend and exact handshake')
  expect(after.run).toMatchObject({ runId: before.run.runId, pid: before.run.pid, state: 'running' })
  expect(after.session.nativeHandle).toEqual(before.session.nativeHandle)
  expect(after.session.terminalFrontend?.message).toBeUndefined()
  expect(after.session.terminalHandshake?.operationId).not.toBe(before.session.terminalHandshake?.operationId)
  expect(after.session.terminalHandshake!.outputAfterByte).toBeGreaterThan(0)
  expect((await store.readMetadata(original.agentSessionId))!.nativeActor).toEqual(originalPrivate!.nativeActor)
  const repeated = await runCompiledObjectCli(args, scope.env)
  expect(repeated.code, repeated.stderr + repeated.stdout).toBe(0)
  const log = (await readFile(events, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const spawns = log.filter(row => row.type === 'spawn'), handshakes = log.filter(row => row.type === 'handshake')
  expect(spawns).toHaveLength(2)
  expect(spawns[1].args.slice(4)).toEqual(['resume', sid, '--dangerously-bypass-hook-trust'])
  expect(JSON.stringify(spawns[1])).not.toContain('ORIGINAL_CREATION_PROMPT_MUST_NOT_REPLAY')
  expect(handshakes).toHaveLength(2)
  expect(handshakes.every(row => row.query === true)).toBe(true)
  expect(after.session.terminalFrontend?.frontendId).not.toBe(detached.session.terminalFrontend?.frontendId)
  expect(await sdk.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: original.agentSessionId, expectedRun: original.run, submissionId: 'unknown-original-input' })).toEqual(unknown)
  const nativeLog = (await readFile(nativeRequests, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(nativeLog.filter(row => row.params.input[0].text.includes('UNKNOWN_INPUT_MUST_REMAIN_ONCE'))).toHaveLength(1)
  await sdk.writeAgent({ agentSessionId: original.agentSessionId, expectedRun: original.run, source: 'user', data: 'ORIGINAL_ATTACHMENT_STILL_LIVE' })
  await until(() => terminalOutput.join(''), value => value.includes('OBSERVED:ORIGINAL_ATTACHMENT_STILL_LIVE'), 'original terminal Attachment remains live')
  process.kill(backend.pid, 'SIGTERM') // Exact backend PID captured from this test-owned actor.
  await until(() => sdk.statusAgent(original.agentSessionId), value => value.run.state !== 'running', 'owned backend ended')
  const settled = await runCompiledObjectCli(args, scope.env)
  expect(settled.code).toBe(1)
  const settledReceipt = (settled.stdout || settled.stderr).trim().split('\n').find(line => line.startsWith('{'))
  expect(JSON.parse(settledReceipt!).error.code).toBe('AGENT_CONTINUITY_SUPERSEDED')
  expect((await readFile(events, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'spawn')).toHaveLength(2)
  await sdk.stopAgent(original.agentSessionId, original.run)
}, 60_000)
