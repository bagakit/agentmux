import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'

const ctl = vi.hoisted(() => ({ directory: '', directoryFailure: false, renameFailure: false, flushes: 0 }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual,
    open: async (path: string, flags: string, mode?: number) => {
      const handle = await actual.open(path, flags, mode)
      if (path === ctl.directory && flags === 'r') {
        const sync = handle.sync.bind(handle)
        handle.sync = async () => {
          ctl.flushes += 1
          if (ctl.directoryFailure) throw Object.assign(new Error('Injected directory I/O failure'), { code: 'EIO' })
          return await sync()
        }
      }
      return handle
    },
    rename: async (from: string, to: string) => {
      if (ctl.renameFailure) throw Object.assign(new Error('Injected rename I/O failure'), { code: 'EIO' })
      return await actual.rename(from, to)
    }
  }
})
import { AgentMuxFileAgentSessionStore, AgentMuxSessionDurabilityError } from '../src/agent-session-store.js'
import { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

const roots: string[] = []
const children = new Set<ChildProcess>()
afterEach(async () => {
  ctl.directoryFailure = false; ctl.renameFailure = false; ctl.directory = ''; ctl.flushes = 0
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
    }
  }
  children.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-session-durability-')); roots.push(root)
  const path = join(root, 'sessions.json'); ctl.directory = root
  return { path, store: new AgentMuxFileAgentSessionStore(path) }
}
function session(id = 'original'): AgentMuxStoredAgentSession {
  return { kind: 'agent', agentSessionId: id, providerId: 'fixture', executorId: 'fixture', hostId: 'local',
    workspacePath: process.cwd(), run: { runId: 'run-' + id }, retiredRuns: [], hookBindingId: 'hook-' + id,
    hookToken: 'token-' + id, createdAt: 100, updatedAt: 100 }
}
async function worker(mode: string, path: string, id = '') {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/session-durability/writer.mjs', import.meta.url)), mode, path, id],
    { stdio: ['pipe', 'pipe', 'pipe'] })
  children.add(child)
  let output = '', errors = ''
  child.stderr!.on('data', data => { errors += String(data) })
  child.stdout!.on('data', data => { output += String(data) })
  const completed = new Promise<void>((resolve, reject) => child.once('exit', (code, signal) =>
    code === 0 ? resolve() : reject(new Error(`Writer exit ${code}/${signal}: ${errors}`))))
  // SIGKILL is deliberately tested below; always observe the completion rejection.
  completed.catch(() => {})
  const deadline = Date.now() + 5000
  while (!output.includes('ready')) {
    if (child.exitCode !== null || Date.now() >= deadline) throw new Error('Writer readiness failed: ' + errors)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return { child, completed, release: () => child.stdin!.end('go\n') }
}

describe('Session durable acknowledgement and kernel writer ownership', () => {
  it('retains the same lock inode across independent writers and SIGKILL', async () => {
    const { path, store } = await setup()
    await store.compareAndSwap(null, session())
    const before = await stat(path + '.lock')
    const owner = await worker('hold', path)
    const exit = once(owner.child, 'exit'); owner.child.kill('SIGKILL'); await exit
    await store.compareAndSwap(null, session('after-kill'))
    const after = await stat(path + '.lock')
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino])
    expect((await store.load()).map(x => (x as AgentMuxStoredAgentSession).agentSessionId)).toEqual(['original', 'after-kill'])
  })

  it('cannot write through another real process lock, even if the pathname contains old bytes', async () => {
    const { path, store } = await setup()
    await store.compareAndSwap(null, session())
    const owner = await worker('hold', path)
    let completed = false
    const pending = store.compareAndSwap(null, session('contender')).then(() => { completed = true })
    await new Promise(resolve => setTimeout(resolve, 120))
    const completedWhileOwned = completed
    const bytesWhileOwned = await readFile(path, 'utf8')
    owner.release(); await owner.completed; await pending
    expect(completedWhileOwned).toBe(false)
    expect(bytesWhileOwned).not.toContain('contender')
    expect((await store.load()).length).toBe(2)
  })

  it('retains both distinct Session updates from simultaneously released real writers', async () => {
    const { path, store } = await setup()
    await store.compareAndSwap(null, session())
    const a = await worker('insert', path, 'writer-a'), b = await worker('insert', path, 'writer-b')
    a.release(); b.release(); await Promise.all([a.completed, b.completed])
    expect((await store.load()).map(x => (x as AgentMuxStoredAgentSession).agentSessionId).sort())
      .toEqual(['original', 'writer-a', 'writer-b'])
  })

  it('rejects a stale same-Session CAS without losing the acknowledged update', async () => {
    const { path, store } = await setup(); const original = session()
    await store.compareAndSwap(null, original)
    const current = { ...original, updatedAt: 101 }
    await new AgentMuxFileAgentSessionStore(path).compareAndSwap(original, current)
    await expect(store.compareAndSwap(original, { ...original, updatedAt: 102 })).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
    expect((await store.load())[0]).toMatchObject({ updatedAt: 101 })
  })

  it('retains the readable original binding and reports uncertainty until a real flush succeeds', async () => {
    const { store } = await setup(); const original = session(); await store.compareAndSwap(null, original)
    const changed = vi.fn(); const registry = new AgentMuxAgentSessionRegistry(store, changed); await registry.load('local')
    ctl.directoryFailure = true
    await expect(registry.update(original.agentSessionId, original.run, current => ({ ...current,
      nativeHandle: { kind: 'provider', providerId: 'fixture', sessionId: 'exact-native-id' }, updatedAt: 101 })))
      .rejects.toBeInstanceOf(AgentMuxSessionDurabilityError)
    expect(registry.get(original.agentSessionId)).toMatchObject({ run: original.run, nativeHandle: { sessionId: 'exact-native-id' } })
    expect(registry.isDurabilityUnconfirmed(original.agentSessionId)).toBe(true)
    // Readback is not a durability acknowledgement.
    expect((await store.load())[0]).toMatchObject({ nativeHandle: { sessionId: 'exact-native-id' } })
    expect(registry.isDurabilityUnconfirmed(original.agentSessionId)).toBe(true)
    await expect(registry.confirmDurability(original.agentSessionId, original.run)).rejects.toMatchObject({ code: 'AGENT_SESSION_STORE_DURABILITY_UNCONFIRMED' })
    expect(changed.mock.calls.at(-1)?.[1]).toMatchObject({ replacementApplied: true })
    ctl.directoryFailure = false; const before = ctl.flushes
    await registry.confirmDurability(original.agentSessionId, original.run)
    expect(ctl.flushes).toBeGreaterThan(before)
    expect(registry.isDurabilityUnconfirmed(original.agentSessionId)).toBe(false)
    expect(changed.mock.calls.at(-1)?.[1]).toBeNull()
    const nextInstance = new AgentMuxAgentSessionRegistry(new AgentMuxFileAgentSessionStore(store.path)); await nextInstance.load('local')
    expect(nextInstance.get(original.agentSessionId).nativeHandle).toEqual(registry.get(original.agentSessionId).nativeHandle)
  })

  it('retains the same newly committed readable Session when rename succeeded but confirmation failed', async () => {
    const { store } = await setup(); const registry = new AgentMuxAgentSessionRegistry(store)
    const original = session(); const reservation = await registry.reserveNew(original.agentSessionId, 'original-create')
    ctl.directoryFailure = true
    await expect(registry.commitLifecycle(reservation, original)).rejects.toMatchObject({ code: 'AGENT_SESSION_STORE_DURABILITY_UNCONFIRMED' })
    expect(registry.get(original.agentSessionId).run).toEqual(original.run)
    expect(registry.isDurabilityUnconfirmed(original.agentSessionId)).toBe(true)
    ctl.directoryFailure = false
    await registry.confirmDurability(original.agentSessionId, original.run)
    expect(registry.get(original.agentSessionId)).toEqual(original)
  })

  it('never acknowledges a stale snapshot after another writer changes the same Run', async () => {
    const { path, store } = await setup(); const original = session(); await store.compareAndSwap(null, original)
    const changed = vi.fn(); const registry = new AgentMuxAgentSessionRegistry(store, changed); await registry.load('local')
    ctl.directoryFailure = true
    await expect(registry.update(original.agentSessionId, original.run, current => ({ ...current, updatedAt: 101,
      nativeHandle: { kind: 'provider', providerId: 'fixture', sessionId: 'native-a' } })))
      .rejects.toBeInstanceOf(AgentMuxSessionDurabilityError)
    ctl.directoryFailure = false
    const a = registry.get(original.agentSessionId)
    const b = { ...a, updatedAt: 102, nativeHandle: { kind: 'provider' as const, providerId: 'fixture', sessionId: 'native-b' } }
    await new AgentMuxFileAgentSessionStore(path).compareAndSwap(a, b)
    await expect(registry.confirmDurability(original.agentSessionId, original.run)).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
    expect(registry.isDurabilityUnconfirmed(original.agentSessionId)).toBe(true)
    expect(changed.mock.calls.at(-1)?.[1]).toBeInstanceOf(AgentMuxSessionDurabilityError)
    expect((await store.load())[0]).toMatchObject({ nativeHandle: { sessionId: 'native-b' }, updatedAt: 102 })
    await registry.refresh(original.agentSessionId, original.run)
    await registry.confirmDurability(original.agentSessionId, original.run)
    expect(registry.get(original.agentSessionId)).toMatchObject({ nativeHandle: { sessionId: 'native-b' }, updatedAt: 102 })
    expect(registry.isDurabilityUnconfirmed(original.agentSessionId)).toBe(false)
    expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ nativeHandle: { sessionId: 'native-b' } })
  })

  it('keeps original bytes on pre-replacement failure and refuses a changed confirmation target', async () => {
    const { path, store } = await setup(); const original = session(); await store.compareAndSwap(null, original)
    const registry = new AgentMuxAgentSessionRegistry(store); await registry.load('local'); const before = await readFile(path, 'utf8')
    ctl.renameFailure = true
    await expect(registry.update(original.agentSessionId, original.run, current => ({ ...current, updatedAt: 101 })))
      .rejects.toMatchObject({ code: 'EIO' })
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(registry.isDurabilityUnconfirmed(original.agentSessionId)).toBe(false)
    ctl.renameFailure = false
    await expect(registry.confirmDurability(original.agentSessionId, { runId: 'different-run' })).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  })
})
