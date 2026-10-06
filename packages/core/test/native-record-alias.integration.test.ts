import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry, type AgentProvider } from '../src/agent-provider.js'
import { AgentMuxFileAgentSessionStore, loadAgentSessions } from '../src/agent-session-store.js'
import type { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxStoredAgentSession, AgentSessionHistoryPage } from '../src/types.js'

const NATIVE = 'bc4b7ee4-6233-4d65-a147-a4a704011bad'
const BODY = 'Original recorded text 原文'
const providers = process.platform === 'darwin' ? ['codex', 'claude', 'antigravity'] as const : ['codex', 'claude'] as const
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { failures.push(error) }
  }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (failures.length) throw new AggregateError(failures, 'Private record carrier cleanup failed')
})

/** Real OS file descriptors, not a vendor backend or a simulated lsof response. */
async function carrier(path: string) {
  const child = spawn(process.execPath, ['-e', `
    const fs=require('node:fs');const path=process.argv[1];
    let fds=[fs.openSync(path,'r+'),fs.openSync(path,'r+')];
    process.on('message',command=>{
      if(command==='rotate'){
        const next=fs.openSync(path,'r+'),before=fds;
        for(const fd of before)fs.closeSync(fd);fds=[next];
        const s=fs.fstatSync(next);process.send({phase:'rotated',before,after:fds,dev:s.dev,ino:s.ino});
      }else if(command==='quit'){
        for(const fd of fds)fs.closeSync(fd);process.exit(0);
      }else if(command==='close'){
        for(const fd of fds)fs.closeSync(fd);fds=[];process.send({phase:'closed'});
      }
    });
    process.on('disconnect',()=>{for(const fd of fds)fs.closeSync(fd);process.exit(0)});
    const s=fs.fstatSync(fds[0]);process.send({phase:'ready',fds,pid:process.pid,dev:s.dev,ino:s.ino});
  `, path], { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let error = ''
  child.stderr!.on('data', bytes => { error += String(bytes) })
  const receive = async (phase: string): Promise<Record<string, unknown>> => {
    const controller = new AbortController()
    try {
      const message = await Promise.race([
        once(child, 'message', { signal: controller.signal }).then(([value]) => value as Record<string, unknown>),
        once(child, 'exit', { signal: controller.signal }).then(() => { throw new Error('Private descriptor holder exited before ' + phase + ': ' + error) })
      ])
      expect(message.phase).toBe(phase)
      return message
    } finally { controller.abort() }
  }
  cleanups.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      expect(child.exitCode, error).toBe(0); expect(child.signalCode).toBeNull()
      return
    }
    const closed = once(child, 'close')
    if (child.connected) child.send('quit')
    const [code, signal] = await closed
    expect(code, error).toBe(0); expect(signal).toBeNull()
  })
  const ready = await receive('ready')
  expect(ready.pid).toBe(child.pid); expect(ready.fds).toHaveLength(2)
  return { child, ready, async command(value: 'rotate' | 'close') {
    const message = receive(value === 'rotate' ? 'rotated' : 'closed')
    child.send(value)
    return await message
  } }
}

type ProviderId = typeof providers[number]
async function fixture(providerId: ProviderId, change: 'alias' | 'replacement' | 'foreign') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'am-record-alias-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const path = providerId === 'codex' ? join(root, 'rollout-original.jsonl')
    : providerId === 'claude' ? join(root, NATIVE + '.jsonl') : join(root, 'native-app', 'presence', NATIVE + '.lock')
  const transcript = providerId === 'antigravity'
    ? join(root, 'native-app', 'brain', NATIVE, '.system_generated', 'logs', 'transcript.jsonl') : path
  const rows = providerId === 'codex' ? [
    { type: 'session_meta', payload: { id: NATIVE, source: 'cli', thread_source: 'user', cwd: root } },
    { type: 'response_item', payload: { type: 'message', id: 'original-answer', role: 'assistant', content: [{ type: 'output_text', text: BODY }] } }
  ] : providerId === 'claude' ? [
    { type: 'assistant', uuid: 'original-answer', sessionId: NATIVE, isSidechain: false,
      message: { role: 'assistant', content: [{ type: 'text', text: BODY }] } }
  ] : [{ step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: BODY }]
  await mkdir(dirname(path), { recursive: true }); await mkdir(dirname(transcript), { recursive: true })
  await writeFile(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  if (path !== transcript) await writeFile(path, '')
  const originalBytes = await readFile(path), held = await carrier(path)
  let rotated: Record<string, unknown> | undefined, changed = false
  let foreign: ChildProcess | undefined
  const builtin = new AgentProviderRegistry().get(providerId)
  // Pause the actual Provider witness before Core consumes assertCurrent. The
  // metadata, file object and owner stay real; only the controlled carrier changes.
  const provider: AgentProvider = { ...builtin, async discoverNativeSession(context) {
    const witness = await builtin.discoverNativeSession!(context)
    expect(witness?.handle).toEqual({ kind: 'provider', providerId, sessionId: NATIVE, transcriptPath: transcript })
    if (!changed) {
      changed = true
      if (change === 'alias') rotated = await held.command('rotate')
      else if (change === 'replacement') {
        await rename(path, path + '.old'); await writeFile(path, originalBytes)
      } else {
        // Same file/record under another process is not the original Run owner.
        foreign = (await carrier(path)).child
        await held.command('close')
      }
    }
    return witness
  } }
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-session', providerId,
    executorId: providerId, hostId: 'local', workspacePath: root, run: { runId: 'original-run' }, retiredRuns: [],
    hookBindingId: 'private-binding', hookToken: 'private-token', createdAt: 1, updatedAt: 1 }
  await store.compareAndSwap(null, session)
  const client = new AgentMuxClient({ store, providers: [provider] })
  const kernel = Reflect.get(client, 'kernel') as CtxmuxRunAdapter
  await Reflect.get(client, 'registry').load('local'); Reflect.set(client, 'connected', true)
  vi.spyOn(kernel, 'isConnected').mockReturnValue(true)
  vi.spyOn(kernel, 'status').mockResolvedValue({ runId: session.run.runId, pid: held.child.pid!,
    workspacePath: root, state: { type: 'running' }, acceptedInputBytes: 0 } as Awaited<ReturnType<CtxmuxRunAdapter['status']>>)
  const controls = (['connect', 'start', 'input', 'stop', 'prepareStop', 'resize', 'attach'] as const)
    .map(name => vi.spyOn(kernel, name).mockImplementation(() => { throw new Error('Forbidden fixture Runtime control: ' + name) }))
  cleanups.push(async () => { await client.dispose(); for (const control of controls) expect(control).not.toHaveBeenCalled() })
  return { client, store, held, transcript, originalBytes, path, session,
    rotated: () => rotated, foreign: () => foreign,
    read: () => client.sessionHistoryPage(session.agentSessionId, { refreshNativeSource: true, requireCurrentSource: true }),
    saved: async () => (await loadAgentSessions(store)).find(value => value.agentSessionId === session.agentSessionId)! }
}

it.each(providers)('%s public history keeps the same native source when all representative FDs change', async providerId => {
  const f = await fixture(providerId, 'alias')
  const result: { page?: AgentSessionHistoryPage; error?: unknown } = await f.read().then(page => ({ page }), error => ({ error }))
  expect(result).not.toHaveProperty('error')
  const page = result.page!
  const rotated = f.rotated()!
  expect(rotated).toMatchObject({ phase: 'rotated', before: f.held.ready.fds,
    dev: f.held.ready.dev, ino: f.held.ready.ino })
  expect(rotated.after).toHaveLength(1)
  expect(f.held.ready.fds).not.toContain((rotated.after as number[])[0])
  expect(page.source).toEqual({ providerId, nativeSessionId: NATIVE })
  expect(page.items).toHaveLength(1)
  expect(page.items[0]!.contentParts).toEqual([{ kind: 'text', text: BODY }])
  expect((await f.saved()).nativeHandle).toEqual({ kind: 'provider', providerId, sessionId: NATIVE, transcriptPath: f.transcript })
  expect(await readFile(f.path)).toEqual(f.originalBytes)
  expect(f.held.child.exitCode).toBeNull()
})

it.each(providers.flatMap(providerId => (['replacement', 'foreign'] as const).map(change => ({ providerId, change }))))(
  '$providerId public history refuses $change even when the record text is identical', async ({ providerId, change }) => {
    const f = await fixture(providerId, change)
    await expect(f.read()).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' })
    expect((await f.saved()).nativeHandle).toBeUndefined()
    expect(f.client.agentSession(f.session.agentSessionId).run).toEqual(f.session.run)
    expect(f.held.child.exitCode).toBeNull()
    if (change === 'foreign') expect(f.foreign()!.exitCode).toBeNull()
  }
)
