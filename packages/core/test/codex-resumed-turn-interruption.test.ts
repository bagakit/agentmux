const { fixtureEpoch: _batchFixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
import { afterEach, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { WebSocketServer } from 'ws'
import { AgentProviderRegistry, type AgentProviderResumedTurnInterruptionContext } from '../src/agent-provider.js'
import { readCodexPromptExecutionEvidence } from '../src/providers/codex-prompt-execution-evidence.js'
import { readCodexResumedTurnInterruption } from '../src/providers/codex-resumed-turn-interruption.js'

const locator = vi.hoisted(() => ({ endpoint: '', changed: '', actual: false, listenerReads: 0,
  rootBirths: 0, actorBirths: 0, rootChanged: false, actorChanged: false, ambiguous: false, laterAmbiguous: false,
  observations: [] as unknown[] }))
vi.mock('../src/agent-native-process.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/agent-native-process.js')>()
  return { ...original,
    nativeProcessBirth: async (pid: number, signal: AbortSignal) => {
      if (locator.actual) {
        try { const result = await original.nativeProcessBirth(pid, signal); locator.observations.push({ pid, birth: result }); return result }
        catch (error) { locator.observations.push({ pid, birthError: String(error) }); throw error }
      }
      const reads = pid === 1234 ? ++locator.rootBirths : ++locator.actorBirths
      return `${pid}-${reads > 1 && (pid === 1234 ? locator.rootChanged : locator.actorChanged) ? 'replacement' : 'original'}`
    },
    nativeProcessTcpListeners: async (pid: number, signal: AbortSignal) => {
      if (locator.actual) {
        try { const result = await original.nativeProcessTcpListeners(pid, signal); locator.observations.push({ pid, listeners: result }); return result }
        catch (error) { locator.observations.push({ pid, listenersError: String(error) }); throw error }
      }
      const reads = ++locator.listenerReads
      return [{ processId: 4321, endpoint: reads > 1 && locator.changed ? locator.changed : locator.endpoint },
        ...(locator.ambiguous || reads > 1 && locator.laterAmbiguous ? [{ processId: 5432, endpoint: locator.endpoint }] : [])]
    }
  }
})
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  Object.assign(locator, { endpoint: '', changed: '', actual: false, listenerReads: 0, rootBirths: 0,
    actorBirths: 0, rootChanged: false, actorChanged: false, ambiguous: false, laterAmbiguous: false, observations: [] })
})
const nativeId = '00000000-0000-4000-8000-000000000001', oldTurn = 'original-incomplete-turn'
const actor = { protocolId: 'codex-app-server-v2-0.163', actorId: 'original-actor', lifecycleOperationId: 'resume-original-run',
  token: 'a'.repeat(64), launch: { command: 'codex', args: [] } }
const records = [
  { type: 'session_meta', payload: { id: nativeId, cli_version: '0.163.0' } },
  { timestamp: new Date(_batchFixtureEpoch(20747, 0, 29828495)).toISOString(), type: 'event_msg', ordinal: 1, payload: { type: 'task_started', turn_id: oldTurn } },
  { timestamp: new Date(_batchFixtureEpoch(20747, 0, 31117366)).toISOString(), type: 'event_msg', ordinal: 2,
    payload: { type: 'item_completed', thread_id: nativeId, turn_id: oldTurn,
      item: { type: 'commandExecution', status: 'completed' } } }
]
const jsonl = (items: unknown[]) => items.map(item => JSON.stringify(item)).join('\n') + '\n'
async function retainedSource() {
  const root = await mkdtemp(join(tmpdir(), 'amux-resumed-turn-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'original.jsonl'); await writeFile(path, jsonl(records))
  const nativeHandle = { kind: 'provider' as const, providerId: 'codex', sessionId: nativeId, transcriptPath: path }
  const previousTurn = await readCodexPromptExecutionEvidence({ args: [], workspacePath: root, nativeHandle })
  if (!previousTurn?.nativeTurnId) throw new Error('Fixture did not retain its exact original turn')
  const context: AgentProviderResumedTurnInterruptionContext = { processId: 1234, nativeActor: actor, nativeHandle,
    previousTurn: { ...previousTurn, nativeTurnId: previousTurn.nativeTurnId }, workspacePath: root, signal: new AbortController().signal }
  return { root, path, context }
}
async function fixture(options: { status?: string; threadStatus?: string; foreign?: 'thread' | 'turn'; sessionId?: string; duplicate?: boolean;
  missing?: boolean; newTurn?: boolean; notDirect?: boolean; disconnect?: boolean; mutateSource?: 'replace' | 'header' | 'turn' } = {}) {
  const f = await retainedSource(), server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening')
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture actor did not listen')
  locator.endpoint = `ws://127.0.0.1:${address.port}`
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [], authorization: Array<string | undefined> = []
  server.on('connection', (socket, request) => {
    authorization.push(request.headers.authorization)
    socket.on('message', async data => {
      const value = JSON.parse(data.toString()); requests.push(value)
      if (!Object.hasOwn(value, 'id')) return
      const reply = (result: unknown) => socket.send(JSON.stringify({ jsonrpc: '2.0', id: value.id, result }))
      if (value.method === 'initialize') return reply({})
      if (value.method === 'thread/read') return reply({ thread: { id: options.foreign === 'thread' ? 'foreign-native-thread' : nativeId,
        sessionId: options.sessionId ?? nativeId, status: { type: options.threadStatus ?? 'idle' }, canAcceptDirectInput: !options.notDirect } })
      if (value.method !== 'thread/turns/list') return reply({ unexpected: true })
      if (options.disconnect) return socket.close()
      if (options.mutateSource === 'replace') {
        await writeFile(f.path + '.replacement', jsonl(records)); await rename(f.path + '.replacement', f.path)
      } else if (options.mutateSource === 'header') {
        await writeFile(f.path, jsonl([{ type: 'session_meta', payload: { id: 'foreign-native-thread' } }, ...records.slice(1)]))
      } else if (options.mutateSource === 'turn') {
        await writeFile(f.path, jsonl([...records, { type: 'event_msg', ordinal: 3, payload: { type: 'task_started', turn_id: 'new-human-turn' } }]))
      }
      const turn = { id: options.foreign === 'turn' ? 'foreign-turn' : oldTurn, status: options.status ?? 'interrupted',
        error: { codexErrorInfo: 'contextWindowExceeded', message: 'Original native failure' } }
      return reply({ data: options.missing ? [] : options.newTurn ? [{ id: 'new-human-turn', status: 'completed' }]
        : [turn, ...(options.duplicate ? [turn] : [])] })
    })
  })
  cleanup.push(async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })
  return { ...f, requests, authorization, read: (context = f.context) => readCodexResumedTurnInterruption(context) }
}

it('reads the exact resumed actor interruption when the original retained protocol has no turn_aborted', async () => {
  const f = await fixture(), before = await readFile(f.path, 'utf8')
  expect(before).not.toContain('turn_aborted'); expect(f.context.previousTurn.state).toBe('working')
  const result = await f.read()
  expect(result).toEqual({ sourceId: f.context.previousTurn.sourceId, nativeTurnId: oldTurn,
    id: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u), state: 'ended', endReason: 'interrupted', observedAt: Date.parse(new Date(_batchFixtureEpoch(20747, 0, 31117366)).toISOString()) })
  expect(result?.id).not.toBe(f.context.previousTurn.id)
  expect((await f.read())?.id).toBe(result?.id)
  expect(await readFile(f.path, 'utf8')).toBe(before)
  expect(f.requests.map(item => item.method)).toEqual(['initialize', 'initialized', 'thread/read', 'thread/turns/list',
    'initialize', 'initialized', 'thread/read', 'thread/turns/list'])
  expect(f.requests.filter(item => item.method === 'thread/read').every(item =>
    JSON.stringify(item.params) === JSON.stringify({ threadId: nativeId, includeTurns: false }))).toBe(true)
  expect(f.requests.filter(item => item.method === 'thread/turns/list').every(item =>
    JSON.stringify(item.params) === JSON.stringify({ threadId: nativeId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' }))).toBe(true)
  expect(f.authorization).toEqual([`Bearer ${actor.token}`, `Bearer ${actor.token}`])
})

it.each(['completed', 'failed'] as const)('keeps native %s distinct from interruption', async status => {
  const f = await fixture({ status }), result = await f.read()
  expect(result).toMatchObject({ state: 'ended', endReason: status, nativeTurnId: oldTurn })
  if (status === 'failed') expect(result?.failure).toMatchObject({ code: 'AGENT_CONTEXT_LIMIT', nativeTurnId: oldTurn })
})

it.each([
  { foreign: 'thread' }, { sessionId: '' }, { foreign: 'turn' }, { duplicate: true }, { missing: true },
  { newTurn: true }, { threadStatus: 'active' }, { threadStatus: 'notLoaded' }, { notDirect: true },
  { status: 'inProgress' }, { status: 'unknown' }, { disconnect: true }
] as const)('keeps inaccurate, superseded or unavailable actor evidence unknown: %j', async options => {
  const f = await fixture(options)
  expect(await f.read()).toBeNull()
  expect(f.requests.every(item => ['initialize', 'initialized', 'thread/read', 'thread/turns/list'].includes(item.method))).toBe(true)
})

it('uses the exact thread identity while allowing the Provider session-tree identity to differ', async () => {
  const f = await fixture({ sessionId: 'original-session-tree' })
  expect(await f.read()).toMatchObject({ nativeTurnId: oldTurn, endReason: 'interrupted' })
})

it.each(['replace', 'header', 'turn'] as const)('does not authorize after original native source changes: %s', async mutateSource => {
  const f = await fixture({ mutateSource }); expect(await f.read()).toBeNull()
})

it.each(['rootChanged', 'actorChanged', 'ambiguous', 'laterAmbiguous', 'endpoint'] as const)('does not authorize a changed exact process/actor: %s', async change => {
  const f = await fixture()
  if (change === 'endpoint') locator.changed = 'ws://127.0.0.1:1'
  else locator[change] = true
  expect(await f.read()).toBeNull()
})

it('does not connect for the wrong Provider capability or frozen source, and cancellation stays unknown', async () => {
  const f = await fixture()
  for (const context of [
    { ...f.context, nativeActor: { ...actor, protocolId: 'another-protocol' } },
    { ...f.context, nativeHandle: { ...f.context.nativeHandle, providerId: 'another-provider' } },
    { ...f.context, previousTurn: { ...f.context.previousTurn, sourceId: 'foreign-source' } },
    { ...f.context, previousTurn: { ...f.context.previousTurn, nativeTurnId: 'foreign-turn' } },
    { ...f.context, signal: AbortSignal.abort() }
  ]) expect(await f.read(context)).toBeNull()
  expect(f.requests).toEqual([])
})

it('exports the optional read through the actual Provider contribution without granting it to other Providers', () => {
  const providers = new AgentProviderRegistry()
  expect(providers.get('codex').readResumedTurnInterruption).toBe(readCodexResumedTurnInterruption)
  expect(providers.get('claude').readResumedTurnInterruption).toBeUndefined()
})

it.runIf(process.platform === 'darwin')('binds an actual isolated actor process and listener instead of launching a detached native history helper', async () => {
  const f = await retainedSource(), script = join(f.root, 'original-actor.cjs')
  await writeFile(script, `const { WebSocketServer } = require(${JSON.stringify(createRequire(import.meta.url).resolve('ws'))});
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
server.on('listening', () => process.send({ listening: true }));
server.on('connection', (socket, request) => {
  if (request.headers.authorization !== ${JSON.stringify(`Bearer ${actor.token}`)}) return socket.close();
  socket.on('message', bytes => {
    const value = JSON.parse(bytes.toString()); if (!Object.hasOwn(value, 'id')) return;
    if (!['initialize', 'thread/read', 'thread/turns/list'].includes(value.method)) return socket.close();
    const result = value.method === 'initialize' ? {} : value.method === 'thread/turns/list' ? { data: [{ id: ${JSON.stringify(oldTurn)}, status: 'interrupted' }] }
      : { thread: { id: ${JSON.stringify(nativeId)}, sessionId: ${JSON.stringify(nativeId)}, canAcceptDirectInput: true, status: { type: 'idle' } } };
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: value.id, result }));
  });
});`)
  const child = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  cleanup.push(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit') } })
  await once(child, 'message'); locator.actual = true
  const result = await readCodexResumedTurnInterruption({ ...f.context, processId: child.pid! })
  expect(result, JSON.stringify(locator.observations)).toMatchObject({
    state: 'ended', endReason: 'interrupted', nativeTurnId: oldTurn, sourceId: f.context.previousTurn.sourceId,
    observedAt: f.context.previousTurn.observedAt })
}, 20_000)
