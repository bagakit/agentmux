import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry, type AgentProvider } from '../src/agent-provider.js'
import { AgentMuxFileAgentSessionStore, loadAgentSessions } from '../src/agent-session-store.js'
import { nativeProcessFiles } from '../src/agent-native-process.js'
import * as runner from '../src/process-runner.js'
import type { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxClientEvent, AgentMuxStoredAgentSession, AgentProviderNativeSessionDiscoveryContext } from '../src/types.js'

const SID = 'private-native-owner', NATIVE = 'exact-native-main', RUN = 'same-original-run'
const BODY = '\n  Genuine recorded final 原文\n'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks() })

async function succeeds<T>(operation: Promise<T>): Promise<T> {
  const outcome: { value?: T; error?: unknown } = await operation.then(value => ({ value }), error => ({ error }))
  expect(outcome).not.toHaveProperty('error')
  return outcome.value!
}

async function fixture(provider?: AgentProvider, contents?: Array<{ source: unknown; id?: string; raw?: string }>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-native-discovery-')))
  const records = contents ?? [{ source: 'cli' }, { source: { subagent: { thread_spawn: { parent_thread_id: NATIVE } } }, id: 'native-child' }]
  const files = await Promise.all(records.map(async (record, index) => {
    const path = join(root, `rollout-owned-${index}.jsonl`)
    await writeFile(path, record.raw ?? JSON.stringify({ type: 'session_meta', payload: { id: record.id ?? NATIVE, source: record.source } }) + '\n')
    return path
  }))
  const holder = spawn(process.execPath, ['-e', `const fs=require('fs'); for(const p of process.argv.slice(1)) fs.openSync(p,'r'); console.log(process.pid);setInterval(()=>{},1000);`, ...files], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  await once(holder.stdout!, 'data')
  const processId = holder.pid!
  const nativeProvider = provider ?? new AgentProviderRegistry().get('codex')
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: SID, providerId: nativeProvider.id,
    executorId: nativeProvider.id, hostId: 'local', workspacePath: root, run: { runId: RUN }, retiredRuns: [],
    hookBindingId: 'private-binding', hookToken: 'private-token', createdAt: 1, updatedAt: 1 }
  await store.compareAndSwap(null, session)
  const client = new AgentMuxClient({ store, providers: [nativeProvider] })
  const kernel = Reflect.get(client, 'kernel') as CtxmuxRunAdapter
  const registry = Reflect.get(client, 'registry') as { load(hostId: string): Promise<void> }
  await registry.load('local'); Reflect.set(client, 'connected', true)
  vi.spyOn(kernel, 'isConnected').mockReturnValue(true)
  const run = { runId: RUN, state: { type: 'running' }, pid: processId, workspacePath: root, acceptedInputBytes: 0 }
  const status = vi.spyOn(kernel, 'status').mockResolvedValue(run as Awaited<ReturnType<CtxmuxRunAdapter['status']>>)
  const controls = (['connect', 'start', 'resize', 'stop', 'attach'] as const).map(name => vi.spyOn(kernel, name).mockImplementation(() => { throw new Error('Forbidden Run control: ' + name) }))
  const events: AgentMuxClientEvent[] = []; client.onEvent(event => events.push(event))
  const producer = join(root, 'read-only-producer.mjs')
  const nativeInput = [{ turnId: 'real-turn', item: { type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: BODY }] } },
    { turnId: 'real-turn', item: { type: 'agentMessage', id: 'progress-1', phase: 'commentary', text: 'Recorded progress' } },
    { turnId: 'real-turn', item: { type: 'agentMessage', id: 'final-1', phase: 'final_answer', text: BODY } },
    { turnId: 'real-turn', item: { type: 'userMessage', id: 'user-2', content: [{ type: 'text', text: BODY }] } }]
  const requests = join(root, 'requests.jsonl')
  await writeFile(producer, `import {appendFileSync} from 'node:fs';import {createInterface} from 'node:readline';
const data=${JSON.stringify(nativeInput)};createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);appendFileSync(${JSON.stringify(requests)},line+'\\n'); const send=result=>process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');if(r.method==='initialize')send({userAgent:'controlled-readonly'});else if(r.method==='thread/read')send({thread:{id:${JSON.stringify(NATIVE)},historyMode:'paginated'}});else if(r.method==='thread/items/list')send({data:r.params.cursor ? []:[...data].reverse(),nextCursor:r.params.cursor ? null:'actual-opaque-earlier'});});`)
  const options = { commandOverride: process.execPath, args: [producer] }
  cleanups.push(async () => {
    await client.dispose(); if (holder.exitCode === null && holder.signalCode === null) { const end = once(holder, 'exit'); holder.kill('SIGTERM'); await end }
    for (const control of controls) expect(control).not.toHaveBeenCalled()
    await rm(root, { recursive: true, force: true })
  })
  return { root, files, holder, processId, store, client, kernel, status, run, session, events, options, nativeInput,
    read: () => client.sessionHistoryPage(SID, options) }
}

it.each(['codex', 'traex'])('%s discovers the exact open main independently of Hook and uses registered Reader/observer thereafter', async providerId => {
  const f = await fixture(new AgentProviderRegistry().get(providerId)), os = vi.spyOn(runner, 'runProcess')
  const page = await succeeds(f.read())
  expect(page.items.map(item => item.id)).toEqual(['user-1', 'progress-1', 'final-1', 'user-2'])
  expect(page.items[2]).toMatchObject({ kind: 'assistant-message', messagePhase: 'final', contentParts: [{ kind: 'text', text: BODY }] })
  expect(page.nextCursor).toBe('actual-opaque-earlier')
  const stored = (await loadAgentSessions(f.store))[0]!
  expect(stored.nativeHandle).toEqual({ kind: 'provider', providerId, sessionId: NATIVE, transcriptPath: f.files[0] })
  expect(stored.semanticStatus).toBeUndefined(); expect(f.events.some(event => event.type === 'agent-session')).toBe(true)
  const discoveredCalls = os.mock.calls.length; expect(discoveredCalls).toBeGreaterThan(0)
  const changes: unknown[] = []
  const observer = await f.client.observeSessionHistory(SID, event => changes.push(event), f.options)
  const acquiredCalls = os.mock.calls.length
  expect(acquiredCalls).toBeGreaterThan(discoveredCalls)
  await appendFile(f.files[0]!, JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'newly recorded' } }) + '\n')
  await vi.waitFor(() => expect(changes.length).toBeGreaterThan(0))
  expect(changes[0]).toMatchObject({ kind: 'invalidated', source: page.source })
  await f.read(); expect(os.mock.calls).toHaveLength(acquiredCalls); observer.dispose()
  const proof = process.env.AMX_NATIVE_DISCOVERY_PROOF
  if (proof) { await mkdir(proof, { recursive: true }); await writeFile(join(proof, 'public-page.json'), JSON.stringify(page, null, 2)+'\n');
    await writeFile(join(proof, 'producer-input.json'), JSON.stringify(f.nativeInput, null, 2)+'\n'); await writeFile(join(proof, 'events.json'), JSON.stringify(f.events, null, 2)+'\n') }
})

it.each([
  ['several mains', [{ source: 'cli' }, { source: 'cli', id: 'another-main' }]],
  ['only child', [{ source: { subagent: { thread_spawn: { parent_thread_id: NATIVE } } }, id: 'native-child' }]],
  ['unknown source', [{ source: 'future' }]],
  ['bad metadata', [{ source: 'cli', raw: '{bad}\n' }]],
  ['oversized metadata', [{ source: 'cli', raw: 'x'.repeat(70 * 1024) + '\n' }]]
])('refuses %s without inventing a locator or changing the healthy Run', async (_name, records) => {
  const f = await fixture(undefined, records)
  await expect(f.read()).rejects.toBeInstanceOf(Error)
  expect((await loadAgentSessions(f.store))[0]!).not.toHaveProperty('nativeHandle')
  expect(f.client.agentSession(SID).run).toEqual({ runId: RUN })
})

it('keeps a save-only failure diagnostic and the exact original read, observer and native Input available', async () => {
  const f = await fixture(); const before = await readFile(join(f.root, 'sessions.json'))
  vi.spyOn(f.store, 'compareAndSwap').mockRejectedValueOnce(Object.assign(new Error('controlled disk failure'), { code: 'ENOSPC' }))
  const page = await succeeds(f.read()); expect(page.items[2]?.id).toBe('final-1')
  expect(await readFile(join(f.root, 'sessions.json'))).toEqual(before)
  const diagnostic = f.events.find(event => event.type === 'agent-error')!
  expect(diagnostic).toMatchObject({ type: 'agent-error', code: 'AGENT_NATIVE_IDENTITY_PERSIST_FAILED', agentSessionId: SID, evidence: { run: { runId: RUN } } })
  expect(f.events.filter(event => event.type === 'agent-session')).toHaveLength(0)
  expect(f.client.agentSession(SID)).not.toHaveProperty('nativeHandle')
  vi.spyOn(f.kernel, 'identity').mockReturnValue({ daemonInstanceId: 'private-instance', protocolVersion: 1, buildIdentity: 'private-build' })
  const input = vi.spyOn(f.kernel, 'input').mockResolvedValue({ run: f.run, appliedByteRange: { startByte: 0, endByte: 1 } } as Awaited<ReturnType<CtxmuxRunAdapter['input']>>)
  await expect(f.client.writeAgent({ agentSessionId: SID, expectedRun: { runId: RUN }, source: 'user', data: 'z' })).resolves.toMatchObject({ runId: RUN })
  expect(input).toHaveBeenCalledOnce()
  const observer = await f.client.observeSessionHistory(SID, () => {}, f.options); observer.dispose()
  const proof = process.env.AMX_NATIVE_DISCOVERY_PROOF
  if (proof) { await mkdir(proof, { recursive: true }); await writeFile(join(proof, 'save-failed-public-page.json'), JSON.stringify(page, null, 2)+'\n'); await writeFile(join(proof, 'save-failed-events.json'), JSON.stringify(f.events, null, 2)+'\n') }
})

it.each(['run', 'host', 'pid', 'epoch', 'different-handle', 'inode'])('rejects late discovery after %s changed', async change => {
  const codex = new AgentProviderRegistry().get('codex')
  const provider: AgentProvider = { ...codex, async discoverNativeSession(context) {
    const discovered = await codex.discoverNativeSession!(context)
    if (change === 'pid') f.status.mockResolvedValue({ ...f.run, pid: f.processId + 1 } as Awaited<ReturnType<CtxmuxRunAdapter['status']>>)
    else if (change === 'epoch') Reflect.set(f.client, 'connectionEpoch', 22)
    else if (change === 'inode') { await rm(f.files[0]!); await writeFile(f.files[0]!, JSON.stringify({ type: 'session_meta', payload: { id: NATIVE, source: 'cli' } })+'\n') }
    else {
      const current = (await loadAgentSessions(f.store))[0]!
      await f.store.compareAndSwap(current, { ...current,
        ...(change === 'run' ? { run: { runId: 'replacement-run' } } : {}),
        ...(change === 'host' ? { hostId: 'other-host' } : {}),
        ...(change === 'different-handle' ? { nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'different-native' } } : {}) })
    }
    return discovered
  } }
  const f = await fixture(provider)
  const readError = await f.read().then(() => undefined, error => error)
  expect(readError).toBeInstanceOf(Error)
  const current = (await loadAgentSessions(f.store))[0]!
  expect(current.nativeHandle?.sessionId).not.toBe(NATIVE)
})

it('reuses the same concurrently confirmed handle but refuses another source', async () => {
  const codex = new AgentProviderRegistry().get('codex')
  const provider: AgentProvider = { ...codex, async discoverNativeSession(context) {
    const result = await codex.discoverNativeSession!(context)
    const current = (await loadAgentSessions(f.store))[0]!
    await f.store.compareAndSwap(current, { ...current, nativeHandle: result!.handle })
    return result
  } }
  const f = await fixture(provider); expect((await f.read()).items[2]?.id).toBe('final-1')
})

it('does not discover existing disconnected history or remote/retired missing locators', async () => {
  const f = await fixture(), os = vi.spyOn(runner, 'runProcess')
  await f.read(); os.mockClear(); vi.mocked(f.kernel.isConnected).mockReturnValue(false)
  expect((await f.read()).items[2]?.id).toBe('final-1'); expect(os).not.toHaveBeenCalled()
  const current = (await loadAgentSessions(f.store))[0]!
  const { nativeHandle: _handle, nativeBinding: _binding, ...missing } = current
  await f.store.compareAndSwap(current, { ...missing, hostId: 'remote' })
  await expect(f.read()).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' }); expect(os).not.toHaveBeenCalled()
})

it.each(['claude', 'pi'])('uses the same Core discovery/Reader boundary for generic %s native records', async id => {
  const builtin = new AgentProviderRegistry().get(id)
  const provider: AgentProvider = { ...builtin, async discoverNativeSession(context: AgentProviderNativeSessionDiscoveryContext) {
    return { handle: { kind: 'provider', providerId: id, sessionId: NATIVE, transcriptPath: join(context.workspacePath, 'generic.jsonl') }, async assertCurrent() {} }
  } }
  const f = await fixture(provider)
  const record = id === 'claude' ? { type: 'assistant', uuid: 'generic-real-id', sessionId: NATIVE, message: { role: 'assistant', content: [{ type: 'text', text: BODY }] } }
    : { type: 'message', id: 'generic-real-id', parentId: null, message: { role: 'assistant', content: [{ type: 'text', text: BODY }] } }
  await writeFile(join(f.root, 'generic.jsonl'), (id === 'pi' ? JSON.stringify({ type: 'session', version: 3, id: NATIVE, cwd: f.root })+'\n' : '') + JSON.stringify(record)+'\n')
  const page = await f.client.sessionHistoryPage(SID)
  expect(page.items[0]).toMatchObject({ id: 'generic-real-id', kind: 'assistant-message', contentParts: [{ kind: 'text', text: BODY }] })
  expect((await loadAgentSessions(f.store))[0]!.nativeHandle).toMatchObject({ kind: 'provider', providerId: id })
})

it.each(['missing tool', 'partial observation', 'wrong process group'])('fails %s explicitly without a false binding', async name => {
  const f = await fixture()
  const actual = runner.runProcess
  vi.spyOn(runner, 'runProcess').mockImplementation(async (command, args, options) => {
    if (name === 'wrong process group' && command === 'ps') return { stdout: '2\n', stderr: '', exitCode: 0 }
    if (command === 'lsof') {
      if (name === 'missing tool') throw Object.assign(new Error('missing lsof'), { code: 'ENOENT' })
      return { stdout: '', stderr: 'permission partial', exitCode: 1 }
    }
    return actual(command, args, options)
  })
  await expect(f.read()).rejects.toBeInstanceOf(Error)
  expect((await loadAgentSessions(f.store))[0]!).not.toHaveProperty('nativeHandle')
})

it('keeps failed-save native observation active and reports only the diagnostic', async () => {
  const f = await fixture()
  vi.spyOn(f.store, 'compareAndSwap').mockRejectedValueOnce(Object.assign(new Error('controlled save failure'), { code: 'EIO' }))
  const changes: unknown[] = []
  const observer = await succeeds(f.client.observeSessionHistory(SID, value => changes.push(value), f.options))
  expect((await loadAgentSessions(f.store))[0]!).not.toHaveProperty('nativeHandle')
  expect(f.events.some(value => value.type === 'agent-error' && value.code === 'AGENT_NATIVE_IDENTITY_PERSIST_FAILED')).toBe(true)
  await appendFile(f.files[0]!, '{"type":"event_msg"}\n')
  await vi.waitFor(() => expect(changes).toHaveLength(1))
  expect(changes[0]).toMatchObject({ kind: 'invalidated', source: { providerId: 'codex', nativeSessionId: NATIVE } })
  observer.dispose()
})

it('does not inspect local processes for a genuinely retired missing locator', async () => {
  const f = await fixture()
  const reservation = { kind: 'stop' as const, reservationId: 'owned-retirement', ownerId: 'owned-only', ownerPid: process.pid,
    agentSessionId: SID, expectedRun: { runId: RUN }, operationId: 'owned-retire', expiresAt: Date.now()+60_000,
    stopOperation: { daemonInstance: 'private-instance', operationKey: 'owned-stop', runId: RUN } }
  await f.store.reserveLifecycle(reservation); await f.store.commitLifecycle(reservation, null)
  const os = vi.spyOn(runner, 'runProcess')
  await expect(f.read()).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' })
  expect(os).not.toHaveBeenCalled()
})

it('refuses a cancelled discovery before storing or reading an identity', async () => {
  const codex = new AgentProviderRegistry().get('codex')
  const controller = new AbortController()
  const provider: AgentProvider = { ...codex, async discoverNativeSession(context) {
    const result = await codex.discoverNativeSession!(context); controller.abort(); return result
  } }
  const f = await fixture(provider)
  await expect(f.client.observeSessionHistory(SID, () => {}, { ...f.options, signal: controller.signal })).rejects.toBeInstanceOf(Error)
  expect((await loadAgentSessions(f.store))[0]!).not.toHaveProperty('nativeHandle')
})

it('refuses a candidate budget overflow before selecting an apparent main', async () => {
  const f = await fixture(undefined, Array.from({ length: 17 }, (_, index) => ({ source: index ? { subagent: { thread_spawn: { parent_thread_id: NATIVE } } } : 'cli', id: 'native-'+index })))
  await expect(f.read()).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' })
  expect((await loadAgentSessions(f.store))[0]!).not.toHaveProperty('nativeHandle')
})


it('keeps a newly saved native answer readable when Runtime becomes unavailable during Reader work', async () => {
  const codex = new AgentProviderRegistry().get('codex')
  const provider: AgentProvider = { ...codex, async readSessionHistoryPage(context) {
    const page = await codex.readSessionHistoryPage!(context)
    vi.mocked(f.kernel.isConnected).mockReturnValue(false); Reflect.set(f.client, 'connected', false)
    return page
  } }
  const f = await fixture(provider), os = vi.spyOn(runner, 'runProcess')
  const page = await succeeds(f.read())
  expect(page.items[2]).toMatchObject({ id: 'final-1', messagePhase: 'final' })
  expect((await loadAgentSessions(f.store))[0]!.nativeHandle?.sessionId).toBe(NATIVE)
  const discovered = os.mock.calls.length
  const again = await succeeds(f.read()); expect(again.items[2]?.id).toBe('final-1')
  expect(os.mock.calls).toHaveLength(discovered)
})

it('refuses an otherwise plausible open-file observation with its terminal NUL and LF removed', async () => {
  const f = await fixture(), actual = runner.runProcess
  vi.spyOn(runner, 'runProcess').mockImplementation(async (command, args, options) => {
    const result = await actual(command, args, options)
    return command === 'lsof' ? { ...result, stdout: result.stdout.slice(0, -2) } : result
  })
  const error = await f.read().then(() => undefined, value => value)
  expect(error).toMatchObject({ code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' })
  expect((await loadAgentSessions(f.store))[0]!).not.toHaveProperty('nativeHandle')
})


it('keeps a genuinely committed native locator readable when Runtime disappears at the FileStore CAS boundary', async () => {
  const f = await fixture(), actual = f.store.compareAndSwap.bind(f.store)
  vi.spyOn(f.store, 'compareAndSwap').mockImplementation(async (...args) => {
    const committed = await actual(...args)
    if (args[1]?.nativeHandle) {
      expect((await loadAgentSessions(f.store))[0]!.nativeHandle?.sessionId).toBe(NATIVE)
      vi.mocked(f.kernel.isConnected).mockReturnValue(false); Reflect.set(f.client, 'connected', false)
    }
    return committed
  })
  const page = await succeeds(f.read())
  expect(page.items[2]).toMatchObject({ id: 'final-1', messagePhase: 'final', contentParts: [{ kind: 'text', text: BODY }] })
  expect((await loadAgentSessions(f.store))[0]!.nativeHandle?.sessionId).toBe(NATIVE)
})
