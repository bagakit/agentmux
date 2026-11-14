import { afterEach, expect, it, vi } from 'vitest'
import { copyFile, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const control = vi.hoisted(() => ({ directoryFailure: false, clientConstructions: 0, readFailurePath: '' }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, readFile: async (path: any, ...args: any[]) => {
    if (String(path) === control.readFailurePath) throw Object.assign(new Error('controlled auxiliary EIO'), { code: 'EIO' })
    return (fs.readFile as any)(path, ...args)
  }, open: async (path: any, flags: any, mode: any) => {
    const handle = await fs.open(path, flags, mode)
    if ((await handle.stat()).isDirectory()) {
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        if (control.directoryFailure) throw Object.assign(new Error('controlled directory EIO'), { code: 'EIO' })
        return sync()
      }
    }
    return handle
  } }
})
vi.mock('../src/client.js', () => ({ AgentMuxClient: class {
  constructor() { control.clientConstructions++; throw new Error('TEST_STOP_BEFORE_RUNTIME') }
} }))

import { immutableIdentityFile } from '../src/immutable-identity-file.js'
import { AgentMuxCreationAuthority } from '../src/agent-creation-authority.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { startHeadlessAgentMux } from '../src/headless-runtime.js'

const roots: string[] = []
async function temporary() { const path = await mkdtemp(join(tmpdir(), 'amx-namespace-')); roots.push(path); return path }
afterEach(async () => {
  control.directoryFailure = false
  control.readFailurePath = ''
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true })
})
const identityOptions = {
  parse: (bytes: string) => { const value = JSON.parse(bytes); if (typeof value?.id !== 'string') throw Error('invalid'); return { id: value.id } },
  create: () => ({ id: 'original' }), encode: (value: { id: string }) => JSON.stringify(value) + '\n'
}

it('publishes custody before identity and repairs only an absent original without minting another', async () => {
  const directory = await temporary(), path = join(directory, 'identity.json')
  expect(await immutableIdentityFile(path, identityOptions)).toEqual({ id: 'original' })
  const bytes = await readFile(path, 'utf8')
  expect(await readFile(path + '.original', 'utf8')).toBe(bytes)
  await unlink(path)
  expect(await immutableIdentityFile(path, { ...identityOptions, create: () => { throw Error('must not mint') } })).toEqual({ id: 'original' })
  expect(await readFile(path, 'utf8')).toBe(bytes)
})

it('keeps malformed current bytes and refuses two conflicting complete identities', async () => {
  const directory = await temporary(), path = join(directory, 'identity.json')
  await immutableIdentityFile(path, identityOptions)
  await writeFile(path, 'malformed')
  await expect(immutableIdentityFile(path, identityOptions)).rejects.toThrow()
  expect(await readFile(path, 'utf8')).toBe('malformed')
  await writeFile(path, JSON.stringify({ id: 'different' }))
  await expect(immutableIdentityFile(path, identityOptions)).rejects.toMatchObject({ code: 'IDENTITY_SOURCE_CONFLICT' })
  expect(await readFile(path + '.original', 'utf8')).toContain('original')
})

it('an auxiliary copy failure preserves a readable canonical identity and reports its recovery gap', async () => {
  const directory = await temporary(), path = join(directory, 'identity.json'), issues: unknown[] = []
  await writeFile(path, JSON.stringify({ id: 'original' }), { mode: 0o600 })
  control.directoryFailure = true
  expect(await immutableIdentityFile(path, { ...identityOptions, onRecoveryIssue: issue => issues.push(issue) })).toEqual({ id: 'original' })
  expect(issues).toEqual([{ status: 'unavailable', code: 'EIO' }])
})

it('a new namespace never reaches a Runtime client after directory confirmation failed', async () => {
  const directory = await temporary(), before = control.clientConstructions
  control.directoryFailure = true
  await expect(startHeadlessAgentMux({ store: new AgentMuxFileAgentSessionStore(join(directory, 'sessions.sqlite')), stateDirectory: directory,
    socketPath: join(directory, 'control.sock') })).rejects.toMatchObject({ code: 'EIO' })
  expect(control.clientConstructions).toBe(before)
})

it('a directly created SQLite namespace retains its original incarnation after both primary files disappear', async () => {
  const directory = await temporary(), path = join(directory, 'direct.sqlite')
  const store = new AgentMuxFileAgentSessionStore(path)
  await store.loadMetadata()
  const identity = await readFile(path + '.sqlite-identity', 'utf8')
  expect(await readFile(path + '.sqlite-identity.original', 'utf8')).toBe(identity)
  await unlink(path); await unlink(path + '.sqlite-identity')
  await expect(new AgentMuxFileAgentSessionStore(path).load()).rejects.toThrow()
  expect((await readdir(directory)).includes('direct.sqlite')).toBe(false)
})

it('an auxiliary incarnation read or syntax failure preserves a healthy primary, while a valid conflict refuses it', async () => {
  const directory = await temporary(), path = join(directory, 'healthy.sqlite'), store = new AgentMuxFileAgentSessionStore(path)
  await store.loadMetadata()
  control.readFailurePath = path + '.sqlite-identity.original'
  expect(await store.loadMetadata()).toEqual([])
  control.readFailurePath = ''
  await writeFile(path + '.sqlite-identity.original', 'malformed{}')
  expect(await store.loadMetadata()).toEqual([])
  await writeFile(path + '.sqlite-identity.original', 'valid-but-different')
  await expect(store.loadMetadata()).rejects.toMatchObject({ code: 'AGENT_SESSION_STORE_UNAVAILABLE' })
})

it('the retained incarnation also constrains read-only inspection after primary marker loss', async () => {
  const directory = await temporary(), path = join(directory, 'original.sqlite'), other = join(directory, 'other.sqlite')
  await new AgentMuxFileAgentSessionStore(path).loadMetadata(); await new AgentMuxFileAgentSessionStore(other).loadMetadata()
  await unlink(path + '.sqlite-identity'); await copyFile(other, path)
  await expect(new AgentMuxFileAgentSessionStore(path).loadMetadata()).rejects.toMatchObject({ code: 'AGENT_SESSION_STORE_UNAVAILABLE' })
})

it('restarts the same semantic identity and original lazy signing preparation after losing either primary', async () => {
  const directory = await temporary(), options = { store: new AgentMuxFileAgentSessionStore(join(directory, 'sessions.sqlite')),
    stateDirectory: directory, socketPath: join(directory, 'control.sock') }
  await expect(startHeadlessAgentMux(options)).rejects.toThrow('TEST_STOP_BEFORE_RUNTIME')
  const original = JSON.parse(await readFile(join(directory, 'semantic-runtime.json'), 'utf8'))
  expect(original.creationIdentity.runtimeId).toBe(original.runtimeId)
  const signer = () => new AgentMuxCreationAuthority({ stateDirectory: directory, runtimeId: original.runtimeId,
    requireOriginalIdentity: true, recoveryIdentity: async () => original.creationIdentity })
  const first = await signer().identity()
  await unlink(join(directory, 'agent-creation-identity.json'))
  await unlink(join(directory, 'semantic-runtime.json'))
  await expect(startHeadlessAgentMux(options)).rejects.toThrow('TEST_STOP_BEFORE_RUNTIME')
  expect(JSON.parse(await readFile(join(directory, 'semantic-runtime.json'), 'utf8'))).toEqual(original)
  expect(await signer().identity()).toEqual(first)
})

it('retains a known signer when both semantic copies are absent instead of changing its runtime address', async () => {
  const directory = await temporary(), options = { store: new AgentMuxFileAgentSessionStore(join(directory, 'sessions.sqlite')),
    stateDirectory: directory, socketPath: join(directory, 'control.sock') }
  await expect(startHeadlessAgentMux(options)).rejects.toThrow('TEST_STOP_BEFORE_RUNTIME')
  const first = JSON.parse(await readFile(join(directory, 'semantic-runtime.json'), 'utf8'))
  const authority = new AgentMuxCreationAuthority({ stateDirectory: directory, runtimeId: first.runtimeId, recoveryIdentity: async () => first.creationIdentity })
  const original = await authority.identity()
  await unlink(join(directory, 'semantic-runtime.json'))
  await unlink(join(directory, 'semantic-runtime.json.original'))
  await expect(startHeadlessAgentMux(options)).rejects.toMatchObject({ code: 'IDENTITY_SOURCE_MISSING' })
  expect(await authority.identity()).toEqual(original)
  expect(await readdir(directory)).not.toContain('semantic-runtime.json')
})

it('does not recreate a lost signer when the namespace requires the original and no exact source remains', async () => {
  const directory = await temporary(), authority = new AgentMuxCreationAuthority({ stateDirectory: directory, runtimeId: 'original' })
  await authority.identity()
  await unlink(join(directory, 'agent-creation-identity.json'))
  await unlink(join(directory, 'agent-creation-identity.json.original'))
  await expect(new AgentMuxCreationAuthority({ stateDirectory: directory, runtimeId: 'original', requireOriginalIdentity: true }).identity())
    .rejects.toMatchObject({ code: 'AGENT_CREATION_AUTHORITY_INVALID' })
  expect(await readdir(directory)).not.toContain('agent-creation-identity.json')
})

it('preserves a previously used Session namespace after DB and marker loss, while a genuinely new store still initializes', async () => {
  const directory = await temporary(), path = join(directory, 'sessions.json')
  await writeFile(path, JSON.stringify({ version: 5, sessions: [], reservations: [], retiredRuns: [], retiredAgentSessions: [] }), { mode: 0o600 })
  const store = new AgentMuxFileAgentSessionStore(path)
  expect(await store.loadMetadata()).toEqual([])
  expect((await readdir(directory)).some(name => name.startsWith('sessions.json.original-'))).toBe(true)
  await unlink(path); await unlink(path + '.sqlite-identity')
  await expect(new AgentMuxFileAgentSessionStore(path).loadMetadata()).rejects.toMatchObject({ code: 'AGENT_SESSION_STORE_UNAVAILABLE' })
  expect(await readdir(directory)).not.toContain('sessions.json')
  expect(await new AgentMuxFileAgentSessionStore(join(directory, 'new.sqlite')).loadMetadata()).toEqual([])
})
