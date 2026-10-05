import { afterEach, expect, it, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { execFile } from 'node:child_process'
import { promisify, stripVTControlCharacters } from 'node:util'
import { join, resolve } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'
import { AgentMuxFileAgentSessionStore, loadAgentSessions } from '../src/agent-session-store.js'
import type { AgentMuxAgentSession, AgentMuxClientEvent, AgentMuxStoredAgentSession } from '../src/types.js'
import type { AgentMuxHostedClient } from '../src/hosted-client-contract.js'

const scopes: Array<Awaited<ReturnType<typeof headlessFixture>>> = []
afterEach(async () => { for (const scope of scopes.splice(0)) await scope.cleanup(); vi.unstubAllEnvs() })
async function fixture() {
  vi.stubEnv('AGENTMUX_TEST_OWNER_ENTRY', resolve(import.meta.dirname, 'fixtures/hook-restoration-worker.mjs'))
  const scope = await headlessFixture(); scopes.push(scope)
  const client = await scope.client(), command = resolve(import.meta.dirname, 'fixtures/fake-codex-cli.mjs')
  const create = async (operation: string) => {
    const session = await client.createAgent({ providerId: 'codex', executorId: 'codex', workspacePath: scope.root,
      createOperationId: operation, injectAgentMuxGuide: false, commandOverride: command, env: { AGENTMUX_FAKE_NATIVE_RECORD: '1' } })
    await until(() => client.agentSession(session.agentSessionId), value => value.semanticStatus?.state === 'done', 'original native Stop')
    return session
  }
  const first = await create('private-hook-first'), second = await create('private-hook-second')
  const store = new AgentMuxFileAgentSessionStore(scope.env.AGENTMUX_AGENT_SESSION_STORE!)
  const tracePath = join(scope.env.AGENTMUX_STATE_DIRECTORY!, 'hook-binding-trace.ndjson')
  const trace = async () => (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line).agentSessionId as string)
  return { scope, client, first, second, store, tracePath, trace }
}
async function inputEcho(client: AgentMuxHostedClient, session: AgentMuxAgentSession, text: string) {
  await client.attachTerminal(session.run.runId, 0, 'raw')
  const run = (await client.statusAgent(session.agentSessionId)).run
  await client.writeTerminal(session.run, { ownerInstanceId: client.runtimeIdentity().instanceId,
    operationId: text, expectedByte: run.acceptedInputBytes!, data: text })
  return await until(async () => {
    const replay = await client.readRunReplay(session.run, 0, 'raw')
    return stripVTControlCharacters(Buffer.concat(replay.replay.map(value => Buffer.from(value.dataBytes))).toString('utf8'))
  }, value => value.includes(text), 'same Run terminal input echo')
}

it('restarts the real private Headless owner with 257 ended Sessions and one failed live binding, keeping original public identity and input', async () => {
  const f = await fixture(), originalOwner = f.scope.owner
  const original = await Promise.all([f.client.statusAgent(f.first.agentSessionId), f.client.statusAgent(f.second.agentSessionId)])
  const ended: AgentMuxStoredAgentSession[] = []
  // These are actual native Runs. Only their retained semantic metadata is seeded;
  // no new Session is invented as a replacement for either original live Agent.
  for (let offset = 0; offset < 257; offset += 8) {
    const values = await Promise.all(Array.from({ length: Math.min(8, 257 - offset) }, (_, n) => f.client.createTerminal({
      createOperationId: `ended-${offset + n}`, workspacePath: f.scope.root, command: process.execPath, args: ['-e', 'process.exit(0)'] })))
    for (const [n, value] of values.entries()) ended.push({ kind: 'agent', agentSessionId: `private-ended-${offset + n}`,
      providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: f.scope.root, run: { runId: value.runId }, retiredRuns: [],
      hookBindingId: randomBytes(32).toString('base64url'), hookToken: randomBytes(32).toString('base64url'), createdAt: 1, updatedAt: 1 })
  }
  await until(() => f.client.listRuns(), values => values.filter(value => value.state !== 'running').length === 257, '257 actual ended native Runs')
  await f.client.dispose(); await f.scope.stopOwner()
  for (const session of ended) await f.store.compareAndSwap(null, session)
  const before = (await loadAgentSessions(f.store)).find(value => value.agentSessionId === f.first.agentSessionId)!
  const bad = { ...before, hookBindingId: 'invalid', updatedAt: before.updatedAt + 1 }
  await f.store.compareAndSwap(before, bad); await writeFile(f.tracePath, '')
  const restarted = await f.scope.restart(), client = await f.scope.client()
  expect(restarted.owner.runtimeId).toBe(originalOwner.runtimeId)
  expect(restarted.owner.ownerInstanceId).not.toBe(originalOwner.ownerInstanceId)
  expect(client.agentSessions()).toHaveLength(259)
  expect((await f.trace()).sort(), 'ended Sessions never allocate a binding').toEqual([f.first.agentSessionId, f.second.agentSessionId].sort())
  const failure = { run: f.first.run, phase: 'binding', code: 'INVALID_HOOK_BINDING' }
  expect(client.agentSession(f.first.agentSessionId).hookIngressObservation, 'initial bootstrap cannot miss the earlier failure').toMatchObject(failure)
  expect(client.agentSession(f.second.agentSessionId).hookIngressObservation).toBeUndefined()
  for (const [index, session] of [f.first, f.second].entries()) {
    const status = await client.statusAgent(session.agentSessionId)
    expect(status.run).toMatchObject({ runId: session.run.runId, pid: original[index]!.run.pid, state: 'running' })
    expect(status.session.agentSessionId).toBe(session.agentSessionId)
  }
  const inspected = await promisify(execFile)(process.execPath, [resolve(import.meta.dirname, '../bin/amux'), '--endpoint', `unix:${f.scope.socketPath}`,
    'agent', 'inspect', '--session', f.first.agentSessionId], { env: f.scope.env })
  expect(JSON.parse(inspected.stdout).result.session.hookIngressObservation).toMatchObject(failure)
  await inputEcho(client, f.first, 'private-failed-hook-original-input')
  expect(client.agentSession(f.first.agentSessionId).hookIngressObservation).toMatchObject(failure)
  const fixed = { ...bad, hookBindingId: before.hookBindingId, updatedAt: bad.updatedAt + 1 }
  await f.store.compareAndSwap(bad, fixed)
  const events: AgentMuxClientEvent[] = []; client.onEvent(event => { events.push(event) })
  await expect(client.refreshAgentSession(f.first.agentSessionId, { runId: 'wrong-run' })).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  expect((await client.refreshAgentSession(f.first.agentSessionId, f.first.run)).hookIngressObservation).toBeUndefined()
  await until(() => client.agentSession(f.first.agentSessionId), value => !value.hookIngressObservation, 'exact Hook recovery projection')
  expect(events.some(value => value.type === 'agent-session' && value.session.agentSessionId === f.first.agentSessionId && !value.session.hookIngressObservation)).toBe(true)
  expect((await loadAgentSessions(f.store)).every(value => !('hookIngressObservation' in value))).toBe(true)
  await client.stopAgent(f.first.agentSessionId, f.first.run); await client.stopAgent(f.second.agentSessionId, f.second.run)
}, 120_000)

it('retains listener failure in bootstrap and refreshes only the requested original binding after the private port recovers', async () => {
  const f = await fixture(), original = await f.client.statusAgent(f.first.agentSessionId)
  await f.client.dispose(); await f.scope.stopOwner()
  const port = 40_000 + createHash('sha256').update(f.scope.env.AGENTMUX_RUNTIME_DIRECTORY!).digest().readUInt16BE(0) % 20_000
  const blocker = createServer()
  await new Promise<void>((yes, no) => { blocker.once('error', no); blocker.listen(port, '127.0.0.1', yes) })
  try {
    await f.scope.restart()
    const client = await f.scope.client()
    const failure = { phase: 'listen', code: 'EADDRINUSE' }
    expect(client.agentSession(f.first.agentSessionId).hookIngressObservation).toMatchObject({ ...failure, run: f.first.run })
    expect(client.agentSession(f.second.agentSessionId).hookIngressObservation).toMatchObject({ ...failure, run: f.second.run })
    expect((await client.statusAgent(f.first.agentSessionId)).run).toMatchObject({ runId: f.first.run.runId, pid: original.run.pid, state: 'running' })
    await new Promise<void>((yes, no) => blocker.close(error => error ? no(error) : yes()))
    expect((await client.refreshAgentSession(f.first.agentSessionId, f.first.run)).hookIngressObservation).toBeUndefined()
    await until(() => client.agentSession(f.first.agentSessionId), value => !value.hookIngressObservation, 'first listener recovery')
    expect(client.agentSession(f.second.agentSessionId).hookIngressObservation).toMatchObject(failure)
    expect((await client.refreshAgentSession(f.second.agentSessionId, f.second.run)).hookIngressObservation).toBeUndefined()
    await client.stopAgent(f.first.agentSessionId, f.first.run); await client.stopAgent(f.second.agentSessionId, f.second.run)
  } finally { if (blocker.listening) await new Promise<void>(yes => blocker.close(() => yes())) }
}, 120_000)
