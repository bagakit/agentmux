import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { durableWriteFile, DurableWriteError } from '@agentmux/core'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'

const roots: string[] = []
const value = (text: string) => JSON.stringify({ version: 1, state: {
  agentComposerDrafts: { 'original-region': text },
  agentSteerQueues: { 'original-session': [{ operationId: 'original-input', text, expectedRunId: 'original-run' }] },
  documents: { 'original-workspace\0notes.md': { text, baseRevision: 'original-file-revision' } },
  arbitraryRetainedField: { original: true }
} })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-user-state-')); roots.push(root)
  return { root, path: join(root, 'workbench-user-state.json') }
}

afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 }))) })

let worker: string
beforeAll(async () => {
  const directory = resolve('.tmp/workbench-user-state-process')
  const { mkdir } = await import('node:fs/promises'); await mkdir(directory, { recursive: true })
  worker = join(directory, 'worker.mjs')
  const { build } = createRequire(resolve('packages/core/package.json'))('esbuild') as typeof import('esbuild')
  await build({ stdin: { resolveDir: process.cwd(), contents: `
    import { WorkbenchUserStateStore } from './apps/desktop/src/main/workbench-user-state.ts';
    const owner = new WorkbenchUserStateStore(process.argv[2]);
    const result = process.argv[3] === 'write' ? await owner.write(process.argv[4]) : await owner.read();
    await owner.flushDiagnostics();
    process.stdout.write(JSON.stringify({ result, observation: owner.observe() }));` }, outfile: worker,
    platform: 'node', format: 'esm', bundle: true,
    alias: { '@agentmux/core': resolve('packages/core/src/durable-write.ts'),
      '@agentmux/identity': resolve('packages/identity/src/index.ts') },
    banner: { js: "import { createRequire as diagnosticCreateRequire } from 'node:module'; const require = diagnosticCreateRequire(import.meta.url);" },
    logLevel: 'silent' })
})

function child(args: string[]): Promise<any> {
  return new Promise((yes, no) => {
    const process = spawn(globalThis.process.execPath, [worker, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = ''
    process.stdout.on('data', data => { output += data }); process.stderr.on('data', data => { errors += data })
    process.on('error', no); process.on('close', code => {
      if (code !== 0) no(new Error('User-state process failed: ' + errors))
      else { try { yes(JSON.parse(output)) } catch (error) { no(error) } }
    })
  })
}

describe('Main-owned Desktop user state', () => {
  it('distinguishes absence, stores the original envelope bytes and returns a producer receipt', async () => {
    const { path } = await fixture(), owner = new WorkbenchUserStateStore(path)
    expect(await owner.read()).toBeNull()
    expect(owner.observe()).toMatchObject({ availability: 'missing', diskDurability: 'unconfirmed' })
    const original = '\n' + value('Unsent original input') + '\n'
    const receipt = await owner.write(original)
    expect(receipt).toMatchObject({ path, diskDurability: 'confirmed', sizeBytes: Buffer.byteLength(original) })
    expect(receipt.contentDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(await readFile(path, 'utf8')).toBe(original)
    expect(await owner.read()).toBe(original)
    expect(owner.observe()).toMatchObject({ availability: 'present', contentDigest: receipt.contentDigest,
      diskDurability: 'unconfirmed', confirmedAt: null, lastConfirmedWrite: receipt, lastFailure: null })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('queues reads and later writes behind the originally admitted write', async () => {
    const { path } = await fixture()
    let release!: () => void, started!: () => void
    const gate = new Promise<void>(resolve => { release = resolve }), ready = new Promise<void>(resolve => { started = resolve })
    const writes: string[] = []
    const owner = new WorkbenchUserStateStore(path, { write: async (target, body, options) => {
      if (target === path) {
        writes.push(String(body))
        if (writes.length === 1) { started(); await gate }
      }
      await durableWriteFile(target, body, options)
    } })
    const first = owner.write(value('First'))
    await ready
    const reading = owner.read(), second = owner.write(value('Second'))
    expect(writes).toEqual([value('First')])
    release()
    await first
    expect(await reading).toBe(value('First'))
    await second
    expect(writes).toEqual([value('First'), value('Second')])
    expect(await owner.read()).toBe(value('Second'))
  })

  it('retains the original file after failed replacement and records safe cross-restart failure metadata', async () => {
    const { path } = await fixture(), original = value('Private original draft')
    await new WorkbenchUserStateStore(path).write(original)
    let fail = true
    const owner = new WorkbenchUserStateStore(path, { write: async (target, body, options) => {
      if (target === path && fail) { fail = false; throw new DurableWriteError(target, 'before-replace', Object.assign(new Error('Private text must not enter diagnostics'), { code: 'ENOSPC' })) }
      await durableWriteFile(target, body, options)
    } })
    await expect(owner.write(value('Newest unsaved input'))).rejects.toMatchObject({ phase: 'before-replace', code: 'ENOSPC' })
    expect(await readFile(path, 'utf8')).toBe(original)
    await owner.flushDiagnostics()
    const diagnostic = await readFile(path + '.failure.json', 'utf8')
    expect(diagnostic).not.toContain('Private')
    expect(diagnostic).not.toContain('Newest')
    const restarted = await child([path, 'read'])
    expect(restarted.result).toBe(original)
    expect(restarted.observation).toMatchObject({ diskDurability: 'unconfirmed', lastFailure: { operation: 'write', phase: 'before-replace', code: 'ENOSPC' } })
    await expect(owner.write(value('Newest unsaved input'))).resolves.toMatchObject({ diskDurability: 'confirmed' })
    expect(await owner.read()).toBe(value('Newest unsaved input'))
  })

  it('reconfirms identical bytes after an after-replace directory-sync failure', async () => {
    const { path } = await fixture(), input = value('Original input remains pending')
    let writes = 0
    const owner = new WorkbenchUserStateStore(path, { write: async (target, body, options) => {
      await durableWriteFile(target, body, options)
      if (target === path && ++writes === 1) throw new DurableWriteError(target, 'after-replace', Object.assign(new Error('Directory sync failed'), { code: 'EIO' }))
    } })
    await expect(owner.write(input)).rejects.toMatchObject({ phase: 'after-replace' })
    expect(await readFile(path, 'utf8')).toBe(input)
    expect(await owner.read()).toBe(input)
    expect(owner.observe()).toMatchObject({ diskDurability: 'unconfirmed', confirmedAt: null })
    await expect(owner.write(input)).resolves.toMatchObject({ diskDurability: 'confirmed' })
    expect(writes).toBe(2)
    expect(owner.observe().lastFailure).toMatchObject({ phase: 'after-replace', code: 'EIO' })
  })

  it('does not replace corrupt original data with a valid new or empty document', async () => {
    const { path } = await fixture(), corrupt = '{ "private original draft": '
    await writeFile(path, corrupt)
    const owner = new WorkbenchUserStateStore(path)
    await expect(owner.read()).rejects.toMatchObject({ code: 'WORKBENCH_USER_STATE_INVALID' })
    await expect(owner.write(value('New default'))).rejects.toMatchObject({ code: 'WORKBENCH_USER_STATE_INVALID' })
    expect(await readFile(path, 'utf8')).toBe(corrupt)
    await owner.flushDiagnostics()
    expect(await readFile(path + '.failure.json', 'utf8')).not.toContain('private original draft')
    expect(owner.observe()).toMatchObject({ availability: 'unconfirmed', diskDurability: 'unconfirmed' })
  })

  it('rejects only malformed incoming writes and keeps the healthy saved state available', async () => {
    const { path } = await fixture(), owner = new WorkbenchUserStateStore(path)
    const receipt = await owner.write(value('Saved'))
    for (const invalid of ['', '{}', '{"state":[],"version":1}', '{"state":{},"version":"1"}', 'null']) {
      await expect(owner.write(invalid)).rejects.toMatchObject({ code: 'WORKBENCH_USER_STATE_INVALID' })
      expect(await owner.read()).toBe(value('Saved'))
      expect(owner.observe()).toMatchObject({ diskDurability: 'unconfirmed', contentDigest: receipt.contentDigest,
        lastConfirmedWrite: receipt, lastFailure: { phase: 'request' } })
    }
  })

  it('does not turn a read failure into absence or poison the later explicit retry', async () => {
    const { path } = await fixture(), original = value('Preserved')
    await new WorkbenchUserStateStore(path).write(original)
    let unavailable = true
    const owner = new WorkbenchUserStateStore(path, { read: async (target, encoding) => {
      if (target === path && unavailable) throw Object.assign(new Error('Private denied source'), { code: 'EACCES' })
      return readFile(target, encoding)
    } })
    await expect(owner.read()).rejects.toMatchObject({ code: 'EACCES' })
    await expect(owner.write(value('New'))).rejects.toMatchObject({ code: 'EACCES' })
    expect(await readFile(path, 'utf8')).toBe(original)
    unavailable = false
    expect(await owner.read()).toBe(original)
    await expect(owner.write(value('New'))).resolves.toMatchObject({ diskDurability: 'confirmed' })
  })

  it('obtains a writer ACK for identical explicit saves; a process read cannot manufacture that receipt', async () => {
    const { path } = await fixture(), writes = vi.fn(durableWriteFile)
    const owner = new WorkbenchUserStateStore(path, { write: writes })
    const receipt = await owner.write(value('Same'))
    expect(await owner.write(value('Same'))).toMatchObject({ ...receipt, confirmedAt: expect.any(Number) })
    expect(writes).toHaveBeenCalledTimes(2)
    const restarted = new WorkbenchUserStateStore(path, { write: writes })
    expect(await restarted.read()).toBe(value('Same'))
    expect(restarted.observe().diskDurability).toBe('unconfirmed')
    await restarted.write(value('Same'))
    expect(writes).toHaveBeenCalledTimes(3)
    expect(writes.mock.calls[2]![2]).toEqual({ requireDirectorySync: true })
  })

  it('reads exact original drafts, queue identities and unsaved content from a second real process', async () => {
    const { path } = await fixture(), original = value('Original bytes survive process exit')
    const written = await child([path, 'write', original])
    expect(written.result.diskDurability).toBe('confirmed')
    const recovered = await child([path, 'read'])
    expect(recovered.result).toBe(original)
    expect(JSON.parse(recovered.result)).toMatchObject({ version: 1, state: {
      agentComposerDrafts: { 'original-region': 'Original bytes survive process exit' },
      agentSteerQueues: { 'original-session': [{ operationId: 'original-input', expectedRunId: 'original-run' }] },
      arbitraryRetainedField: { original: true }
    } })
    expect(recovered.observation.diskDurability).toBe('unconfirmed')
    expect(recovered.observation.lastConfirmedWrite).toBeNull()
  })

  it('does not extend an original writer ACK to an externally replaced equal-byte file', async () => {
    const { path } = await fixture(), original = value('Same bytes, another file')
    const owner = new WorkbenchUserStateStore(path), receipt = await owner.write(original)
    expect(owner.observe()).toMatchObject({ diskDurability: 'confirmed', lastConfirmedWrite: receipt })
    await durableWriteFile(path, original, { requireDirectorySync: true })
    expect(await owner.read()).toBe(original)
    expect(owner.observe()).toMatchObject({ availability: 'present', contentDigest: receipt.contentDigest,
      diskDurability: 'unconfirmed', confirmedAt: null, lastConfirmedWrite: receipt })
  })

  it('keeps original user data available when its diagnostic sidecar is malformed', async () => {
    const { path } = await fixture(), original = value('Healthy original')
    await new WorkbenchUserStateStore(path).write(original)
    await writeFile(path + '.failure.json', 'invalid diagnostic')
    expect(await new WorkbenchUserStateStore(path).read()).toBe(original)
  })

  it('imports only within the original native queue and returns a concurrent normal write as the winner', async () => {
    const { path } = await fixture(), owner = new WorkbenchUserStateStore(path)
    expect(await owner.read()).toBeNull()
    const latest = value('Newest legitimate user write'), old = value('Stale imported browser data')
    const written = owner.write(latest), imported = owner.importIfAbsent(old)
    await written
    expect(await imported).toBe(latest)
    expect(await owner.read()).toBe(latest)
    expect(await readFile(path, 'utf8')).toBe(latest)
  })

  it('imports exact existing user bytes once and never overwrites the native winner', async () => {
    const { path } = await fixture(), owner = new WorkbenchUserStateStore(path), original = value('Original imported bytes')
    expect(await owner.importIfAbsent(original)).toBe(original)
    expect(owner.observe()).toMatchObject({ diskDurability: 'confirmed', lastConfirmedWrite: { diskDurability: 'confirmed' } })
    expect(await owner.importIfAbsent('malformed stale source')).toBe(original)
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  it('does not let a stalled auxiliary diagnostic block the original failure or the next user save', async () => {
    const { path } = await fixture()
    let release!: () => void, started!: () => void, fail = true
    const held = new Promise<void>(yes => { release = yes }), ready = new Promise<void>(yes => { started = yes })
    const owner = new WorkbenchUserStateStore(path, { write: async (target, body, options) => {
      if (target === path && fail) { fail = false; throw Object.assign(new Error('Original failure'), { code: 'ENOSPC' }) }
      if (target.endsWith('.failure.json')) { started(); await held }
      return durableWriteFile(target, body, options)
    } })
    try {
      await expect(owner.write(value('Original failed input'))).rejects.toMatchObject({ code: 'ENOSPC' })
      await ready
      await expect(owner.write(value('New explicit retry'))).resolves.toMatchObject({ diskDurability: 'confirmed' })
      expect(await owner.read()).toBe(value('New explicit retry'))
    } finally { release(); await owner.flushDiagnostics() }
  })
  it('acknowledges an equal concurrent native winner before legacy import may release its bytes', async () => {
    const { path } = await fixture(), original = value('Equal retained original')
    await writeFile(path, original)
    const write = vi.fn(async () => { throw Error('Winner directory sync unconfirmed') })
    const owner = new WorkbenchUserStateStore(path, { write })
    await expect(owner.importIfAbsent(original)).rejects.toThrow('Winner directory sync unconfirmed')
    expect(write).toHaveBeenCalledWith(path, original, { requireDirectorySync: true })
    expect(await readFile(path, 'utf8')).toBe(original)
    expect(owner.observe().lastConfirmedWrite).toBeNull()
  })

  it('a stalled historical diagnostic read does not delay user data or overwrite a newer failure', async () => {
    const { path } = await fixture(), original = value('Healthy original')
    await writeFile(path, original)
    let release!: (value: string) => void
    const historical = new Promise<string>(resolve => { release = resolve })
    const owner = new WorkbenchUserStateStore(path, { read: (file, encoding) => file.endsWith('.failure.json') ? historical : readFile(file, encoding) })
    try {
      await expect(owner.read()).resolves.toBe(original)
      await expect(owner.write(value('Still usable'))).resolves.toMatchObject({ diskDurability: 'confirmed' })
      await expect(owner.write('malformed')).rejects.toThrow()
      const current = owner.observe().lastFailure
      release(JSON.stringify({ schema: 'agentmux.workbench-user-state-failure.v1', failure: {
        operation: 'read', phase: null, code: 'OLDER_DIAGNOSTIC', observedAt: 1 } }))
      await Promise.resolve()
      expect(owner.observe().lastFailure).toEqual(current)
      expect(owner.observe().lastFailure?.code).toBe('WORKBENCH_USER_STATE_INVALID')
    } finally { release('{}'); await owner.flushDiagnostics() }
  })

})
