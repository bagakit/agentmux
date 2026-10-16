import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { afterEach, expect, it } from 'vitest'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'
import { runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { fixturePath } from './helpers/fixture-values.js'
import { AgentMuxFileAgentSessionStore, normalizeStoredAgentSession } from '../src/agent-session-store.js'
import { codexFrontendSocketPath } from '../src/providers/codex-managed-frontend.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it('preserves only the original absent or true frontend declaration in private Session metadata', () => {
  const nativeActor = { protocolId: 'fixture-native-input', actorId: 'original-actor', lifecycleOperationId: 'original-create',
    token: 'a'.repeat(64), launch: { command: process.execPath, args: ['original-command'] } }
  const stored = { kind: 'agent', agentSessionId: 'original-session', providerId: 'codex', executorId: 'codex', hostId: 'local',
    workspacePath: fixturePath('tmp/private-frontend-fixture'), run: { runId: 'original-run' }, retiredRuns: [],
    hookBindingId: 'original-hook', hookToken: 'original-hook-token', createdAt: _tailFixtureEpoch(0, 0, 1), updatedAt: _tailFixtureEpoch(0, 0, 1), nativeActor }
  expect(normalizeStoredAgentSession(stored).nativeActor).toEqual(nativeActor)
  expect(normalizeStoredAgentSession({ ...stored, nativeActor: { ...nativeActor, frontendControl: true } }).nativeActor)
    .toEqual({ ...nativeActor, frontendControl: true })
  for (const frontendControl of [false, null, 1, 'true']) {
    expect(() => normalizeStoredAgentSession({ ...stored, nativeActor: { ...nativeActor, frontendControl } }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_AGENT_SESSION_STORE' }))
  }
})

// Actual app-server and TUI children are owned by the production managed wrapper.
// The fixture speaks only its private native protocol; it never substitutes Run facts.
async function nativeCommand(root: string) {
  const command = join(root, 'private-native.mjs'), events = join(root, 'frontend-spawns.ndjson')
  const transcript = join(root, 'rollout-private.jsonl'), nativeSessionId = '00000000-0000-4000-8000-000000000019'
  await writeFile(command, `#!/usr/bin/env node
import NativeWebSocket from ${JSON.stringify(createRequire(import.meta.url).resolve('ws'))}
import {appendFileSync,openSync,writeSync} from 'node:fs'
const args=process.argv.slice(2),sid=${JSON.stringify(nativeSessionId)}
if(args.includes('--version')) {console.log('codex-cli 0.163.0');process.exit(0)}
if(args.includes('--help')) {console.log('codex resume --no-alt-screen --sandbox --ask-for-approval');process.exit(0)}
if(args.includes('app-server')) {
  const fd=openSync(${JSON.stringify(transcript)},'a')
  writeSync(fd,JSON.stringify({type:'session_meta',payload:{id:sid,source:'cli',thread_source:'user',cwd:process.cwd()}})+'\\n')
  writeSync(fd,JSON.stringify({type:'event_msg',timestamp:new Date().toISOString(),payload:{type:'task_started',turn_id:'original-turn'}})+'\\n')
  const server=new NativeWebSocket.WebSocketServer({port:0,host:'127.0.0.1'})
  server.on('connection',(ws,req)=>{if(req.headers.authorization!=='Bearer '+process.env.AGENTMUX_CODEX_ACTOR_TOKEN)return ws.close()
    ws.on('message',bytes=>{const p=JSON.parse(String(bytes));if(!Object.hasOwn(p,'id'))return
      ws.send(JSON.stringify({jsonrpc:'2.0',id:p.id,result:p.method==='thread/read'?{thread:{id:sid,sessionId:'same-native-object',canAcceptDirectInput:true}}:{}}))})})
} else {
  appendFileSync(${JSON.stringify(events)},JSON.stringify({args,pid:process.pid})+'\\n')
  process.stdin.setRawMode(true)
  process.stdin.on('data',bytes=>{if(String(bytes).includes('\\x1b[?0u'))process.stdout.write('\\x1b[?2026h› \\x1b[?2026l')})
  setTimeout(()=>process.stdout.write('\\x1b[?u'),0)
}
`, { mode: 0o700 })
  return { command, events, nativeSessionId }
}

it.runIf(process.platform === 'darwin').each([false, true])(
  'keeps the exact live actor across a semantic owner restart and public Resume with frontend control declared=%s', async declared => {
    const scope = await headlessFixture(); cleanup.push(scope.cleanup)
    const callLog = join(scope.env.AGENTMUX_STATE_DIRECTORY!, 'frontend-call-log')
    await writeFile(callLog, '')
    if (!declared) await writeFile(join(scope.env.AGENTMUX_STATE_DIRECTORY!, 'frontend-control-absent'), 'original launch has only native input')
    const fixture = await nativeCommand(scope.root), sdk = await scope.client(), firstOwner = scope.owner
    const created = await sdk.createAgent({ providerId: 'codex', executorId: 'codex', agentSessionId: 'launch-owned-frontend',
      createOperationId: 'original-launch', workspacePath: scope.root, commandOverride: fixture.command,
      prompt: 'ORIGINAL_PROMPT_MUST_NOT_REPLAY', injectAgentMuxGuide: false })
    const before = await until(() => sdk.statusAgent(created.agentSessionId), value =>
      value.session.nativeHandle?.sessionId === fixture.nativeSessionId && value.session.terminalHandshake?.acknowledged === true &&
      (!declared || value.session.terminalFrontend?.state === 'attached'), 'original native actor and terminal handshake')
    expect(before.run.pid).toBeGreaterThan(0)
    const store = new AgentMuxFileAgentSessionStore(scope.env.AGENTMUX_AGENT_SESSION_STORE!)
    const originalPrivate = (await store.readMetadata(created.agentSessionId))!
    expect(originalPrivate.nativeActor).toBeDefined()
    expect(originalPrivate.nativeActor!.frontendControl).toBe(declared ? true : undefined)
    if (!declared) {
      expect(before.session.terminalFrontend).toBeUndefined()
      expect(await readFile(callLog, 'utf8')).toBe('')
    } else {
      // Remove only this test-owned control pathname. The original native server,
      // TUI, Run and input remain alive; the next semantic owner sees real ENOENT.
      await unlink(codexFrontendSocketPath(originalPrivate.nativeActor!.token))
    }
    await sdk.dispose(); await scope.restart()
    expect(scope.owner.runtimeId).toBe(firstOwner.runtimeId)
    expect(scope.owner.ownerInstanceId).not.toBe(firstOwner.ownerInstanceId)
    expect(scope.owner.ctxmux).toEqual(firstOwner.ctxmux)
    const recovered = await scope.client()
    const after = await recovered.statusAgent(created.agentSessionId)
    expect(after.run).toMatchObject({ runId: before.run.runId, pid: before.run.pid, state: 'running' })
    expect(after.session.nativeHandle).toEqual(before.session.nativeHandle)
    expect((await store.readMetadata(created.agentSessionId))!.nativeActor).toEqual(originalPrivate.nativeActor)
    expect(after.run.nativeService?.input.phase.type).toBe('open')
    const observed = await until(() => recovered.agentSession(created.agentSessionId), value =>
      !declared || value.terminalFrontend?.state === 'unknown', 'exact missing declared frontend remains unknown')
    expect(observed.terminalFrontend?.state).toBe(declared ? 'unknown' : undefined)
    if (declared) expect(observed.terminalFrontend?.message).toContain('ENOENT')
    const args = ['--endpoint', `unix:${scope.socketPath}`, 'agent', 'resume', '--session', created.agentSessionId,
      '--operation-id', 'same-public-resume']
    const resumed = await runCompiledObjectCli(args, scope.env)
    expect(resumed.code, resumed.stdout + resumed.stderr).toBe(declared ? 1 : 0)
    if (declared) expect(resumed.stdout + resumed.stderr).toContain('AGENT_CONTINUITY_PENDING')
    const repeated = await runCompiledObjectCli(args, scope.env)
    expect(repeated.code, repeated.stdout + repeated.stderr).toBe(resumed.code)
    const inspected = await runCompiledObjectCli(['--endpoint', `unix:${scope.socketPath}`, 'agent', 'inspect', '--session', created.agentSessionId], scope.env)
    expect(inspected.code, inspected.stdout + inspected.stderr).toBe(0)
    const final = await recovered.statusAgent(created.agentSessionId)
    expect(final.run).toMatchObject({ runId: before.run.runId, pid: before.run.pid, state: 'running',
      acceptedInputBytes: before.run.acceptedInputBytes })
    expect(final.session.nativeHandle).toEqual(before.session.nativeHandle)
    const finalObservation = await until(() => recovered.agentSession(created.agentSessionId), value =>
      !declared || value.terminalFrontend?.state === 'unknown', 'retained final unknown observation')
    expect(finalObservation.terminalFrontend?.state).toBe(declared ? 'unknown' : undefined)
    expect((await store.readMetadata(created.agentSessionId))!.nativeActor).toEqual(originalPrivate.nativeActor)
    expect((await recovered.listRuns()).map(run => run.runId)).toEqual([created.run.runId])
    const spawns = (await readFile(fixture.events, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(spawns).toHaveLength(1)
    const calls = await readFile(callLog, 'utf8')
    if (declared) { expect(calls).toContain('observe\n'); expect(calls).not.toContain('reconnect\n') }
    else expect(calls).toBe('')
    await recovered.stopAgent(created.agentSessionId, created.run)
  }, 60_000)
