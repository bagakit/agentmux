import { fixturePath } from './helpers/fixture-values.js'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import { AgentMuxFileAgentSessionStore, AgentMuxSessionDurabilityError, agentSessionMetadata, normalizeStoredAgentSession } from '../src/agent-session-store.js'
import type { AgentMuxStoredAgentSession, AgentFuturePromptIntent } from '../src/types.js'
import { messageJournalIo } from './helpers/message-journal-io.js'

const ctl = vi.hoisted(() => ({ path: '', directoryFailure: false }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, async open(...args: Parameters<typeof fs.open>) {
    const handle = await fs.open(...args)
    return new Proxy(handle, { get(target, key) {
      if (key === 'sync') return async () => {
        if (String(args[0]) === dirname(ctl.path) && ctl.directoryFailure) {
          ctl.directoryFailure = false
          throw Object.assign(new Error('Private Session directory sync failed'), { code: 'EIO' })
        }
        return target.sync()
      }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  } }
})
let probe: Awaited<ReturnType<typeof messageJournalIo>>
const roots: string[] = []
const exec = promisify(execFile)
beforeAll(async () => { probe = await messageJournalIo() })
afterAll(async () => { await probe.close() })
afterEach(async () => {
  probe.reset(); ctl.path = ''; ctl.directoryFailure = false
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amux-session-local-')); roots.push(root)
  const path = join(await realpath(root), 'sessions.json')
  ctl.path = path; probe.target(path); probe.reset()
  return { root, path, store: new AgentMuxFileAgentSessionStore(path) }
}
function session(id = 'target', count = 1, bytes = 16): AgentMuxStoredAgentSession {
  return { kind: 'agent', agentSessionId: id, providerId: 'generic', executorId: 'generic', hostId: 'local', workspacePath: fixturePath("repo"),
    run: { runId: 'run-' + id }, retiredRuns: [], hookBindingId: 'hook-' + id, hookToken: 'token-' + id, createdAt: 1, updatedAt: 1,
    futurePromptIntents: Object.fromEntries(Array.from({ length: count }, (_, n) => ['intent-' + n, intent(n, bytes)])) }
}
function intent(n = 0, bytes = 16): AgentFuturePromptIntent {
  const text = `Exact original ${n} 😀\n` + 'x'.repeat(bytes)
  return { operationId: 'operation-' + n, prompt: text, active: n % 2 === 0, message: { userContent: text, sourceDevice: { hostId: 'local', deviceId: 'original', name: 'Original device' } },
    ...(n ? { lastOccurrenceAt: n, lastOperationId: 'claimed-' + n } : {}) }
}
function originalDocument(sessions: AgentMuxStoredAgentSession[]) {
  return { version: 5, sessions: sessions.map(normalizeStoredAgentSession), reservations: [], retiredRuns: [], retiredAgentSessions: [] }
}
async function client(store: AgentMuxFileAgentSessionStore) {
  const value = new AgentMuxClient({ store })
  const inner = value as unknown as { connected: boolean; registry: { load(host: string): Promise<void> }; kernel: { isConnected(): boolean } }
  await inner.registry.load('local'); inner.connected = true; inner.kernel.isConnected = () => true
  return value
}

describe('target-local durable Session ownership', () => {
  it('cuts over all original Session, reservation, retirement, unknown admission and future facts then reopens in fresh processes', async () => {
    const { path } = await fixture()
    const active = { ...session('target', 3), nativeHandle: { kind: 'provider' as const, providerId: 'generic', sessionId: 'native-original' },
      capabilityHash: 'original-capability', launchOptions: { sandbox: 'original-selection' },
      promptCompletionAdmission: { operationId: 'unknown-input', startByte: 0, endByte: 5, acknowledged: false } }
    const original = { ...originalDocument([active]),
      reservations: [{ kind: 'create', reservationId: 'original-reservation', ownerId: 'original-owner', ownerPid: process.pid,
        agentSessionId: 'pending', operationId: 'original-create', expiresAt: 123 }],
      retiredRuns: [{ runId: 'retired-run' }],
      retiredAgentSessions: [{ agentSessionId: 'retired', hostId: 'local', run: { runId: 'retired-run' }, source: 'user', observedAt: 9 }] }
    const raw = Buffer.from(JSON.stringify(original, null, 2) + '\n'); await writeFile(path, raw)
    const module = fileURLToPath(new URL('../dist/agent-session-store.js', import.meta.url))
    const script = `import { AgentMuxFileAgentSessionStore } from ${JSON.stringify(module)};
      const s=new AgentMuxFileAgentSessionStore(process.env.STORE_PATH);
      console.log(JSON.stringify({sessions:await s.load(),metadata:await s.loadMetadata(),retiredRuns:await s.loadRetiredRuns(),
        retiredSessions:await s.loadRetiredAgentSessions(),correlation:await s.loadCreationCorrelation('pending'),
        exact:await s.readFuturePromptIntent('target','intent-2'),page:await s.listFuturePromptIntents('target',{limit:2})}));`
    const env = { ...process.env, STORE_PATH: path }
    const first = JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', script], { env })).stdout)
    const second = JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', script], { env })).stdout)
    expect(first).toEqual(second)
    expect(first.sessions).toEqual(original.sessions); expect(first.metadata).toEqual(original.sessions.map(agentSessionMetadata))
    expect(first.retiredRuns).toEqual(original.retiredRuns); expect(first.retiredSessions).toEqual(original.retiredAgentSessions)
    expect(first.correlation).toEqual(original.reservations[0]); expect(first.exact).toEqual(original.sessions[0]!.futurePromptIntents!['intent-2'])
    expect(first.page.intents.map((entry: { intentId: string }) => entry.intentId)).toEqual(['intent-0', 'intent-1'])
    expect(first.page.nextIntentId).toBe('intent-1')
    expect(await readFile(path + '.original-' + createHash('sha256').update(raw).digest('hex'))).toEqual(raw)
  })

  it('keeps actual SDK catalog, exact reads and saves independent of retained bodies in other Sessions and the same Session', async () => {
    const samples = []
    for (const [otherCount, ownCount] of [[1, 1], [128, 1], [128, 500]]) {
      const { path, store } = await fixture()
      const target = session('target', ownCount, 4096)
      await writeFile(path, JSON.stringify(originalDocument([target, ...Array.from({ length: otherCount }, (_, n) => session('other-' + n, 8, 4096))])))
      const sdk = await client(store)
      try {
        const costs = []
        for (const operation of ['catalog', 'exact', 'save', 'metadata-cas'] as const) {
          probe.reset()
          if (operation === 'catalog') {
            const values = await sdk.readAgentSessions(); expect(values).toHaveLength(otherCount + 1)
            expect(values.every(value => value.futurePromptIntents === undefined)).toBe(true)
          } else if (operation === 'exact') expect(await sdk.readAgentFuturePromptIntent('target', 'intent-0')).toEqual(target.futurePromptIntents!['intent-0'])
          else if (operation === 'save') await sdk.saveAgentFuturePromptIntent({ agentSessionId: 'target', intentId: 'small', operationId: 'small-operation', prompt: 'x', active: true })
          else {
            const current = (await store.readMetadata('target'))!
            await store.compareAndSwapMetadata(current, { ...current, updatedAt: current.updatedAt + 1 })
          }
          const io = probe.stats(); expect(io.failures).toBe(0); expect(io.readBytes).toBeGreaterThan(0)
          expect(io.readBytes).toBeLessThan(operation === 'catalog' ? 256 * 1024 : 128 * 1024)
          expect(io.writeBytes).toBeLessThan(128 * 1024)
          if (operation === 'save' || operation === 'metadata-cas') { expect(io.writes).toBeGreaterThan(0); expect(io.syncs).toBeGreaterThan(0); expect(io.dirSyncs).toBeGreaterThan(0) }
          costs.push({ operation, ...io })
        }
        const reopened = (await new AgentMuxFileAgentSessionStore(path).load()).find(value => (value as AgentMuxStoredAgentSession).agentSessionId === 'target') as AgentMuxStoredAgentSession
        expect(Object.keys(reopened.futurePromptIntents!)).toHaveLength(ownCount + 1)
        expect(reopened.futurePromptIntents!['intent-0']).toEqual(target.futurePromptIntents!['intent-0'])
        samples.push({ otherCount, ownCount, costs })
      } finally { await sdk.dispose() }
    }
    console.log('__SESSION_LOCAL_IO__', JSON.stringify(samples))
  })

  it('retains every other intent on metadata CAS and rejects a concurrent exact intent change before any claim can commit', async () => {
    const { path, store } = await fixture(), original = session('target', 4)
    await store.compareAndSwap(null, original)
    const previous = (await store.readMetadata('target'))!, saved = (await store.readFuturePromptIntent('target', 'intent-0'))!
    const other = new AgentMuxFileAgentSessionStore(path)
    await other.compareAndSwapMetadata(previous, previous, undefined, { intentId: 'intent-0', expected: saved, next: { ...saved, active: false } })
    await expect(store.compareAndSwapMetadata(previous, { ...previous, updatedAt: 3 }, undefined,
      { intentId: 'intent-0', expected: saved, next: { ...saved, lastOccurrenceAt: 100, lastOperationId: 'new-claim' } }))
      .rejects.toMatchObject({ code: 'AGENT_FUTURE_INTENT_CHANGED' })
    expect(await store.readMetadata('target')).toEqual(previous)
    expect(await store.readFuturePromptIntent('target', 'intent-0')).toEqual({ ...saved, active: false })
    await store.compareAndSwapMetadata(previous, { ...previous, updatedAt: 2 })
    const [reopened] = await other.load() as AgentMuxStoredAgentSession[]
    expect(Object.keys(reopened!.futurePromptIntents!)).toHaveLength(4)
    expect(reopened!.futurePromptIntents!['intent-3']).toEqual(original.futurePromptIntents!['intent-3'])
  })

  it('uses the compiled SDK for a precise save and fresh-process read without reloading future bodies into the catalog', async () => {
    const { path, store } = await fixture(), original = session('target', 500, 4096)
    await store.compareAndSwap(null, original)
    const core = fileURLToPath(new URL('../dist/client.js', import.meta.url))
    const storage = fileURLToPath(new URL('../dist/agent-session-store.js', import.meta.url))
    const script = `import {AgentMuxClient} from ${JSON.stringify(core)};import {AgentMuxFileAgentSessionStore} from ${JSON.stringify(storage)};
      const client=new AgentMuxClient({store:new AgentMuxFileAgentSessionStore(process.env.STORE_PATH)});
      await client.registry.load('local');client.connected=true;client.kernel.isConnected=()=>true;
      try {if(process.env.SAVE==='1')await client.saveAgentFuturePromptIntent({agentSessionId:'target',intentId:'compiled',operationId:'compiled-save',prompt:'precise 😀',active:true});
      console.log(JSON.stringify({catalog:await client.readAgentSessions(),exact:await client.readAgentFuturePromptIntent('target','compiled'),page:await client.listAgentFuturePromptIntents('target',{limit:2})}))}
      finally{await client.dispose()}`
    const env = { ...process.env, STORE_PATH: path }
    const first = JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', script], { env: { ...env, SAVE: '1' } })).stdout)
    const second = JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', script], { env })).stdout)
    expect(first).toEqual(second); expect(first.catalog).toHaveLength(1)
    expect(first.catalog[0]).not.toHaveProperty('futurePromptIntents')
    expect(first.exact).toMatchObject({ operationId: 'compiled-save', prompt: 'precise 😀', active: true })
    expect(first.page.intents.map((entry: { intentId: string }) => entry.intentId)).toEqual(['intent-0', 'intent-1'])
    expect(await store.readFuturePromptIntent('target', 'intent-499')).toEqual(original.futurePromptIntents!['intent-499'])
  })

  it('imports the final old-writer commit under the same real process lock before its atomic physical cutover', async () => {
    const { path, store } = await fixture(), original = session('target', 2), last = session('last-old-writer', 2)
    await writeFile(path, JSON.stringify(originalDocument([original])))
    const storage = fileURLToPath(new URL('../dist/agent-session-store.js', import.meta.url))
    const durable = fileURLToPath(new URL('../dist/durable-write.js', import.meta.url))
    const script = `import fs from 'node:fs/promises';import{createRequire}from'node:module';import{durableWriteFile}from ${JSON.stringify(durable)};
      const native=createRequire(${JSON.stringify(storage)})('fs-native-extensions'),handle=await fs.open(process.env.STORE_PATH+'.lock','a+',0o600);
      if(!native.tryLock(handle.fd))throw Error('legacy owner lock missing');process.send('locked');
      await new Promise(resolve=>process.once('message',resolve));
      await durableWriteFile(process.env.STORE_PATH,process.env.ORIGINAL,{mode:0o600,requireDirectorySync:true});await handle.close();`
    const raw = Buffer.from(JSON.stringify(originalDocument([original, last])))
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, STORE_PATH: path, ORIGINAL: raw.toString() }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    let stderr = ''; child.stderr!.on('data', value => { stderr += String(value) })
    const exit = new Promise<void>((resolve, reject) => child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr))))
    exit.catch(() => {})
    try {
      await new Promise((resolve, reject) => { child.once('message', resolve); child.once('exit', () => reject(new Error(stderr))) })
      let completed = false
      const pending = store.compareAndSwapMetadata(agentSessionMetadata(original), { ...agentSessionMetadata(original), updatedAt: 2 }).then(() => { completed = true })
      await new Promise(resolve => setTimeout(resolve, 80)); expect(completed).toBe(false)
      child.send('commit'); await exit; await pending
      expect(await new AgentMuxFileAgentSessionStore(path).load()).toEqual([{ ...original, updatedAt: 2 }, last])
      expect(await readFile(path + '.original-' + createHash('sha256').update(raw).digest('hex'))).toEqual(raw)
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit.catch(() => {}) } }
  })

  it('refuses replacement of an acknowledged database and resumes the exact original facts when its bytes are restored', async () => {
    const { path, store } = await fixture(), original = session('target', 3)
    await store.compareAndSwap(null, original)
    const current = await readFile(path), replacement = Buffer.from(JSON.stringify(originalDocument([session('wrong-original')])) )
    await writeFile(path, replacement)
    await expect(store.loadMetadata()).rejects.toMatchObject({ code: 'AGENT_SESSION_STORE_UNAVAILABLE' })
    await expect(store.compareAndSwapMetadata(agentSessionMetadata(original), { ...agentSessionMetadata(original), updatedAt: 2 }))
      .rejects.toMatchObject({ code: 'AGENT_SESSION_STORE_UNAVAILABLE' })
    expect(await readFile(path)).toEqual(replacement)
    await writeFile(path, current)
    expect(await new AgentMuxFileAgentSessionStore(path).load()).toEqual([original])
  })

  it('keeps damaged original rescue read-only and preserves the metadata contract without publishing partial facts', async () => {
    const { path, store } = await fixture(), original = session('target', 2)
    const raw = Buffer.from(JSON.stringify({ ...originalDocument([original]), sessions: [original, { ...session('damaged'), kind: 'invalid' }] }))
    await writeFile(path, raw)
    expect(await store.loadMetadata()).toEqual([agentSessionMetadata(original)])
    expect(await store.readMetadata('target')).toEqual(agentSessionMetadata(original))
    expect(await store.readFuturePromptIntent('target', 'intent-1')).toEqual(original.futurePromptIntents!['intent-1'])
    await expect(store.compareAndSwapMetadata(agentSessionMetadata(original), { ...agentSessionMetadata(original), updatedAt: 2 }))
      .rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_STORE' })
    expect(await readFile(path)).toEqual(raw)
    await expect(readFile(path + '.sqlite-identity')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['read', 'write', 'sync'] as const)('preserves original facts across a real SQLite %s fault and in-band retry', async kind => {
    const { path, store } = await fixture(), original = session('target', 4)
    await store.compareAndSwap(null, original)
    const metadata = (await store.readMetadata('target'))!
    probe.reset(); probe.fault(kind)
    const error = await store.compareAndSwapMetadata(metadata, { ...metadata, updatedAt: 2 }).catch(error => error)
    expect(error).toBeInstanceOf(Error); expect(probe.stats().failures).toBe(1)
    expect(error.controlFailure).toBeUndefined(); probe.reset()
    const reopened = new AgentMuxFileAgentSessionStore(path), current = (await reopened.readMetadata('target'))!
    expect(current.run).toEqual(original.run); expect(await reopened.readFuturePromptIntent('target', 'intent-3')).toEqual(original.futurePromptIntents!['intent-3'])
    await reopened.compareAndSwapMetadata(current, { ...current, updatedAt: 2 })
    expect(await reopened.load()).toEqual([{ ...original, updatedAt: 2 }])
  })

  it('keeps the committed original Session usable after a lost directory ACK and confirms the exact binding in-band', async () => {
    const { store } = await fixture(), original = session('target', 2)
    await store.compareAndSwap(null, original)
    const metadata = (await store.readMetadata('target'))!, next = { ...metadata, updatedAt: 2 }
    ctl.directoryFailure = true
    const error = await store.compareAndSwapMetadata(metadata, next).catch(error => error)
    expect(error).toBeInstanceOf(AgentMuxSessionDurabilityError); expect(error).toMatchObject({ replacementApplied: true, commitOutcome: 'applied' })
    expect(await store.readMetadata('target')).toEqual(next)
    expect(await store.readFuturePromptIntent('target', 'intent-1')).toEqual(original.futurePromptIntents!['intent-1'])
    await store.confirmDurability('target', original.run, next)
    expect(await store.readMetadata('target')).toEqual(next)
  })

  it('retains an unknown COMMIT acknowledgement through the real Registry and confirms its original binding without replay', async () => {
    const { store } = await fixture(), original = session('target', 2)
    await store.compareAndSwap(null, original)
    const registry = new AgentMuxAgentSessionRegistry(store); await registry.load('local')
    const nativeExec = DatabaseSync.prototype.exec
    let lost = false
    const receipt = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (sql) {
      const result = nativeExec.call(this, sql)
      if (sql === 'COMMIT' && !lost) { lost = true; throw Object.assign(new Error('Private COMMIT acknowledgement lost after native return'), { code: 'EIO' }) }
      return result
    })
    let error
    try { error = await registry.update('target', original.run, current => ({ ...current, updatedAt: 2 })).catch(error => error) }
    finally { receipt.mockRestore() }
    expect(error).toBeInstanceOf(AgentMuxSessionDurabilityError)
    expect(error).toMatchObject({ replacementApplied: false, commitOutcome: 'unknown' })
    expect(error.controlFailure).toBeUndefined()
    expect(registry.get('target')).toEqual({ ...agentSessionMetadata(original), updatedAt: 2 })
    expect(registry.isDurabilityUnconfirmed('target')).toBe(true)
    expect(await store.readFuturePromptIntent('target', 'intent-1')).toEqual(original.futurePromptIntents!['intent-1'])
    await registry.confirmDurability('target', original.run)
    expect(registry.isDurabilityUnconfirmed('target')).toBe(false)
    expect(await store.load()).toEqual([{ ...original, updatedAt: 2 }])
  })

  it.each(['before-commit', 'after-commit', 'cutover-commit', 'cutover-rename'] as const)('reopens the original identity after an actual process crash at %s', async phase => {
    const { path, store } = await fixture(), original = session('target', 2)
    if (phase.startsWith('cutover')) await writeFile(path, JSON.stringify(originalDocument([original])))
    else await store.compareAndSwap(null, original)
    const module = fileURLToPath(new URL('../dist/agent-session-store.js', import.meta.url))
    const script = `import {DatabaseSync,StatementSync} from 'node:sqlite';import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
      const phase=process.env.PHASE,pause=()=>{process.send('boundary');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)};
      if(phase==='before-commit'){const run=StatementSync.prototype.run;StatementSync.prototype.run=function(...args){const value=run.apply(this,args);if(this.sourceSQL.startsWith('INSERT INTO sessions'))pause();return value}}
      if(phase==='after-commit'||phase==='cutover-commit'){const exec=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql){const value=exec.call(this,sql);if(sql==='COMMIT')pause();return value}}
      if(phase==='cutover-rename'){const rename=fs.rename;fs.rename=async(from,to)=>{await rename(from,to);if(to===process.env.STORE_PATH)pause()};syncBuiltinESMExports()}
      const {AgentMuxFileAgentSessionStore}=await import(${JSON.stringify(module)});const s=new AgentMuxFileAgentSessionStore(process.env.STORE_PATH);
      await s.compareAndSwapMetadata(JSON.parse(process.env.EXPECTED),{...JSON.parse(process.env.EXPECTED),updatedAt:2});`
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, PHASE: phase, STORE_PATH: path, EXPECTED: JSON.stringify(agentSessionMetadata(original)) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    let stderr = ''; child.stderr!.on('data', value => { stderr += String(value) })
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Private Session crash boundary missing: ' + stderr)), 5000)
        child.once('message', value => { clearTimeout(timer); resolve(value) })
        child.once('exit', () => { clearTimeout(timer); reject(new Error('Private Session child exited: ' + stderr)) })
      })
      child.kill('SIGKILL'); await exited
      const reopened = new AgentMuxFileAgentSessionStore(path)
      const current = (await reopened.readMetadata('target'))!
      expect(current).toEqual({ ...agentSessionMetadata(original), updatedAt: phase === 'after-commit' ? 2 : 1 })
      expect(await reopened.readFuturePromptIntent('target', 'intent-1')).toEqual(original.futurePromptIntents!['intent-1'])
      await reopened.compareAndSwapMetadata(current, { ...current, updatedAt: 2 })
      expect(await reopened.load()).toEqual([{ ...original, updatedAt: 2 }])
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited } }
  })
})
