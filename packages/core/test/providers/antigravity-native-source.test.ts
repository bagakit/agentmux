import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFile, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../../src/client.js'
import { AgentProviderRegistry } from '../../src/agent-provider.js'
import { AgentMuxFileAgentSessionStore, loadAgentSessions } from '../../src/agent-session-store.js'
import type { CtxmuxRunAdapter } from '../../src/ctxmux-run-adapter.js'
import type { AgentMuxStoredAgentSession, AgentProviderNativeSessionDiscoveryContext, AgentSessionHistoryObservation } from '../../src/types.js'
import { projectConversationRecords } from '../../../client-ui/src/lib/conversation-records.js'

const openRace = vi.hoisted(() => ({ path: '' }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    if (String(args[0]) === openRace.path && typeof args[1] === 'number') throw Object.assign(new Error('controlled presence open race'), { code: 'ENOENT' })
    return await actual.open(...args)
  } }
})

const NATIVE = '5831805a-da5e-4121-b02e-f8085c84c330'
const CHILD = 'cf0287d4-ab04-4c34-8ba4-79b104ddf0cb'
const SID = 'antigravity-owned-session'
const SOURCE = { providerId: 'antigravity', nativeSessionId: NATIVE }
const provider = () => new AgentProviderRegistry().get('antigravity')
const jsonl = (records: unknown[]) => records.map(record => JSON.stringify(record)).join('\n') + '\n'
const user = (index: number, body: string) => ({ step_index: index, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: `<USER_REQUEST>${body}</USER_REQUEST>` })
const assistant = (index: number, body: string) => ({ step_index: index, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: body })
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { openRace.path = ''; for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })

async function fixture(records: unknown[] = [user(0, 'Original question'), assistant(1, 'Original answer')]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-antigravity-native-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'native-app', 'brain', NATIVE, '.system_generated', 'logs', 'transcript.jsonl')
  const full = join(dirname(path), 'transcript_full.jsonl')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, jsonl(records))
  const storePath = join(root, 'sessions.json'), store = new AgentMuxFileAgentSessionStore(storePath)
  const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: SID, providerId: 'antigravity', executorId: 'antigravity', hostId: 'local', workspacePath: root,
    run: { runId: 'owned-antigravity-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1, hookBindingId: 'private-binding', hookToken: 'private-token',
    nativeHandle: { kind: 'provider', providerId: 'antigravity', sessionId: NATIVE, transcriptPath: path } }
  await store.compareAndSwap(null, session)
  const client = new AgentMuxClient({ store }), kernel = Reflect.get(client, 'kernel') as CtxmuxRunAdapter
  const controls = (['connect', 'start', 'input', 'resize', 'stop', 'attach'] as const).map(name => vi.spyOn(kernel, name).mockImplementation(() => { throw new Error('Forbidden fixture Run control: ' + name) }))
  const before = await readFile(storePath)
  const physicalReads: Promise<unknown>[] = [], load = store.load.bind(store)
  vi.spyOn(store, 'load').mockImplementation(() => { const reading = load(); physicalReads.push(reading); return reading })
  cleanups.push(async () => { await client.dispose(); await Promise.allSettled(physicalReads); for (const control of controls) expect(control).not.toHaveBeenCalled() })
  return { root, path, full, storePath, store, client, kernel, session, before }
}

/** Controlled OS descriptor holder. It is not an Antigravity native writer. */
async function holder(root: string, ids = [NATIVE], childOnly = false) {
  const paths: string[] = []
  for (const id of ids) {
    const path = join(root, 'native-app', 'presence', id + '.lock')
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, ''); paths.push(path)
  }
  const script = childOnly
    ? `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify("const fs=require('node:fs');for(const p of process.argv.slice(1))fs.openSync(p,'r+');console.log('ready');setInterval(()=>{},1000);")},...process.argv.slice(1)],{stdio:['ignore','pipe','inherit']});c.stdout.once('data',()=>console.log('ready'));process.on('SIGTERM',()=>{c.kill();process.exit()});setInterval(()=>{},1000);`
    : `const fs=require('node:fs');for(const p of process.argv.slice(1))fs.openSync(p,'r+');console.log('ready');setInterval(()=>{},1000);`
  const child = spawn(process.execPath, ['-e', script, ...paths], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  await once(child.stdout!, 'data')
  cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited } })
  const context: AgentProviderNativeSessionDiscoveryContext = { processId: child.pid!, command: 'agy', args: [], env: {}, workspacePath: root, signal: new AbortController().signal }
  return { child, context, paths }
}

it('wires exact native discovery and both-file observation into the builtin Provider', () => {
  expect(provider().discoverNativeSession).toBeTypeOf('function')
  expect(provider().observeSessionHistory).toBeTypeOf('function')
})

it('discovers the confirmed entrance PID presence and rejects its later physical replacement', async () => {
  const f = await fixture(), h = await holder(f.root)
  const native = await provider().discoverNativeSession!(h.context)
  expect(native?.handle).toEqual({ kind: 'provider', providerId: 'antigravity', sessionId: NATIVE, transcriptPath: f.path })
  await native!.assertCurrent()
  await rename(h.paths[0]!, h.paths[0]! + '.old'); await writeFile(h.paths[0]!, '')
  await expect(native!.assertCurrent()).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' })
})

it('does not promote a sole child-process presence to the main native identity', async () => {
  const f = await fixture(), h = await holder(f.root, [CHILD], true)
  expect(await provider().discoverNativeSession!(h.context)).toBeNull()
})

it('rejects ambiguous entrance native subjects instead of ordering the presence files', async () => {
  const f = await fixture(), h = await holder(f.root, [NATIVE, CHILD])
  await expect(provider().discoverNativeSession!(h.context)).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' })
})

it('public Client current-source binding consumes the real descriptor witness and persists the exact source', async () => {
  const f = await fixture(), h = await holder(f.root)
  const current = (await loadAgentSessions(f.store))[0]!
  await f.store.compareAndSwap(current, { ...current, nativeHandle: undefined })
  await (Reflect.get(f.client, 'registry') as { load(hostId: string): Promise<void> }).load('local')
  Reflect.set(f.client, 'connected', true); vi.spyOn(f.kernel, 'isConnected').mockReturnValue(true)
  vi.spyOn(f.kernel, 'status').mockResolvedValue({ runId: f.session.run.runId, state: { type: 'running' }, pid: h.child.pid!, workspacePath: f.root } as Awaited<ReturnType<CtxmuxRunAdapter['status']>>)
  const page = await f.client.sessionHistoryPage(SID, { refreshNativeSource: true, requireCurrentSource: true })
  expect(page.source).toEqual(SOURCE); expect(page.items).toHaveLength(2)
  expect((await loadAgentSessions(f.store))[0]!.nativeHandle).toEqual({ kind: 'provider', providerId: 'antigravity', sessionId: NATIVE, transcriptPath: f.path })
  const projected = projectConversationRecords({ agentSessionId: SID, executionHostId: 'local', historyPage: page })
  expect(projected.map(record => [record.kind, record.content])).toEqual([['user-message', 'Original question'], ['assistant-message', 'Original answer']])
  expect(projected[0]!.input!.author).toEqual({ kind: 'unknown' }); expect(projected[0]!.input!.source).not.toHaveProperty('device')
})

it('compact append through an already-open writer invalidates public history and projects appended cards with stable source identities', async () => {
  const f = await fixture(), events: AgentSessionHistoryObservation[] = []
  const writer = await open(f.path, 'a'); cleanups.push(() => writer.close())
  const observed = await f.client.observeSessionHistory(SID, event => events.push(event))
  const prior = await f.client.sessionHistoryPage(SID, { limit: 1 })
  await writer.writeFile(jsonl([user(2, '追加问题'), assistant(3, '追加回答')]))
  await vi.waitFor(() => expect(events.some(event => event.kind === 'invalidated')).toBe(true))
  expect(events.every(event => event.source?.nativeSessionId === NATIVE)).toBe(true)
  const newest = await f.client.sessionHistoryPage(SID), projected = projectConversationRecords({ agentSessionId: SID, historyPage: newest })
  expect(projected.map(record => [record.rawId, record.kind, record.content])).toEqual([
    [NATIVE + ':0', 'user-message', 'Original question'], [NATIVE + ':1', 'assistant-message', 'Original answer'],
    [NATIVE + ':2', 'user-message', '追加问题'], [NATIVE + ':3', 'assistant-message', '追加回答']])
  const older = await f.client.sessionHistoryPage(SID, { limit: 1, cursor: prior.nextCursor! })
  expect(older.items.map(item => item.id)).toEqual([NATIVE + ':0']); expect(older.nextCursor).toBeNull()
  observed.dispose(); observed.dispose(); expect(await readFile(f.storePath)).toEqual(f.before)
})

it('full-only file creation recovers compact truncation and invalidates without changing compact bytes', async () => {
  const f = await fixture([{ ...assistant(0, 'cut'), truncated_fields: ['content'] }]), events: AgentSessionHistoryObservation[] = []
  const compactBefore = await readFile(f.path)
  const observed = await f.client.observeSessionHistory(SID, event => events.push(event))
  const initial = await f.client.sessionHistoryPage(SID)
  expect(initial.items[0]!.contentParts).toContainEqual({ kind: 'text', text: '[Antigravity full transcript unavailable: omitted fields content]' })
  await writeFile(f.full, jsonl([assistant(0, 'Full original answer')]))
  await vi.waitFor(() => expect(events.some(event => event.kind === 'invalidated')).toBe(true))
  expect((await f.client.sessionHistoryPage(SID)).items[0]!.contentParts).toEqual([{ kind: 'text', text: 'Full original answer' }])
  expect(await readFile(f.path)).toEqual(compactBefore); expect(await readFile(f.storePath)).toEqual(f.before); observed.dispose()
})

it('full append through an already-open writer refreshes recovered fields and disposal cancels both exact sources', async () => {
  const f = await fixture([{ ...assistant(0, 'cut'), truncated_fields: ['content'] }]), events: AgentSessionHistoryObservation[] = []
  await writeFile(f.full, jsonl([assistant(99, 'unrelated full step')]))
  const writer = await open(f.full, 'a'); cleanups.push(() => writer.close())
  const observed = await f.client.observeSessionHistory(SID, event => events.push(event))
  await writer.writeFile(jsonl([assistant(0, 'Full recovered answer')]))
  await vi.waitFor(() => expect(events.some(event => event.kind === 'invalidated')).toBe(true))
  expect((await f.client.sessionHistoryPage(SID)).items[0]!.contentParts).toEqual([{ kind: 'text', text: 'Full recovered answer' }])
  observed.dispose(); const afterDispose = events.length
  await writer.writeFile(jsonl([assistant(2, 'after dispose')]))
  await appendFile(f.path, jsonl([user(1, 'after dispose')]))
  await new Promise(resolve => setTimeout(resolve, 30)); expect(events).toHaveLength(afterDispose)
})

it('physical full replacement reports unavailable while the last public page remains available to its consumer', async () => {
  const f = await fixture([{ ...assistant(0, 'cut'), truncated_fields: ['content'] }]), events: AgentSessionHistoryObservation[] = []
  await writeFile(f.full, jsonl([assistant(0, 'Preserved answer')]))
  const preserved = await f.client.sessionHistoryPage(SID), observed = await f.client.observeSessionHistory(SID, event => events.push(event))
  await rename(f.full, f.full + '.old'); await writeFile(f.full, jsonl([assistant(0, 'Replacement answer')]))
  await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ kind: 'unavailable', code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })))
  expect(preserved.items[0]!.contentParts).toEqual([{ kind: 'text', text: 'Preserved answer' }]); expect(await readFile(f.storePath)).toEqual(f.before)
  observed.dispose()
})

it('aborted observation and foreign canonical locator cannot acquire native source authority', async () => {
  const f = await fixture(), cancelled = new AbortController(); cancelled.abort(new Error('cancel owning observer'))
  await expect(f.client.observeSessionHistory(SID, () => {}, { signal: cancelled.signal })).rejects.toThrow('cancel owning observer')
  const foreign = join(f.root, 'native-app', 'brain', CHILD, '.system_generated', 'logs', 'transcript.jsonl')
  await mkdir(dirname(foreign), { recursive: true }); await writeFile(foreign, jsonl([assistant(0, 'Foreign answer')]))
  const original = (await loadAgentSessions(f.store))[0]!
  await f.store.compareAndSwap(original, { ...original, nativeHandle: { kind: 'provider', providerId: 'antigravity', sessionId: NATIVE, transcriptPath: foreign } })
  await expect(f.client.sessionHistoryPage(SID)).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  await expect(f.client.observeSessionHistory(SID, () => {})).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
})

it('same-inode full truncation reports unavailable without rewriting retained source identity', async () => {
  const f = await fixture(), events: AgentSessionHistoryObservation[] = []
  await writeFile(f.full, jsonl([assistant(0, 'Original full row')]))
  const observed = await f.client.observeSessionHistory(SID, event => events.push(event))
  const writer = await open(f.full, 'r+'); await writer.truncate(0); await writer.close()
  await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ kind: 'unavailable', code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })))
  expect((await loadAgentSessions(f.store))[0]!.nativeHandle).toEqual(f.session.nativeHandle)
  expect(await readFile(f.storePath)).toEqual(f.before); observed.dispose()
})

it('late reader result is rejected when the retained source changed while the real Provider read was pending', async () => {
  const f = await fixture(), ownedProvider = f.client.providers.get('antigravity'), read = ownedProvider.readSessionHistoryPage!
  let release!: () => void, began!: () => void
  const pending = new Promise<void>(resolve => { began = resolve }), hold = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(ownedProvider, 'readSessionHistoryPage').mockImplementationOnce(async context => { const page = await read(context); began(); await hold; return page })
  const response = f.client.sessionHistoryPage(SID), rejected = expect(response).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  await pending
  const original = (await loadAgentSessions(f.store))[0]!
  await f.store.compareAndSwap(original, { ...original, nativeHandle: { kind: 'provider', providerId: 'antigravity', sessionId: CHILD, transcriptPath: f.path } })
  release(); await rejected
})

it('semantic resume uses the retained exact conversation token and preserves old history in a fresh public Client', async () => {
  const f = await fixture()
  const launch = provider().buildResumeLaunch({ nativeHandle: f.session.nativeHandle!, prompt: 'Continue same conversation', args: ['--effort', 'high'], env: {} })
  expect(launch.args).toEqual(['--conversation', NATIVE, '--effort', 'high', '--prompt-interactive', 'Continue same conversation'])
  const fresh = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(f.storePath) }); cleanups.push(() => fresh.dispose())
  const page = await fresh.sessionHistoryPage(SID)
  expect(page.source).toEqual(SOURCE); expect(page.items.map(item => item.id)).toEqual([NATIVE + ':0', NATIVE + ':1'])
  expect(await readFile(f.storePath)).toEqual(f.before)
})

it('maps a presence unlink race to a structured unknown identity without controlling the process', async () => {
  const f = await fixture(), h = await holder(f.root); openRace.path = h.paths[0]!
  await expect(provider().discoverNativeSession!(h.context)).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' })
})

it('an existing full file without the truncated step keeps its exact compact content and honest omission', async () => {
  const f = await fixture([{ ...assistant(0, 'Kept compact body'), truncated_fields: ['content'] }])
  await writeFile(f.full, jsonl([assistant(1, 'Other real step')]))
  const page = await f.client.sessionHistoryPage(SID)
  expect(page.items).toHaveLength(1)
  expect(page.items[0]!.contentParts).toEqual([{ kind: 'text', text: 'Kept compact body' }, { kind: 'text', text: '[Antigravity truncated fields: omitted fields content]' }])
})
