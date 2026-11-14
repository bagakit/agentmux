import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { durableWriteFile } from './durable-write.js'
import { AgentMuxError } from './errors.js'
import type { AgentMuxAgentWorkspaceLocator } from './host-environment.js'

export type AgentWorkspaceDirectoryLocation = {
  agentWorkspace: AgentMuxAgentWorkspaceLocator
  markerPath: string
}

type Identity = { dev: string; ino: string }
type Marker = {
  schema: 1
  phase: 'pending' | 'provisioned'
  runtimeId: string
  agentSessionId: string
  workspacePath: string
  root: Identity
  leaf: Identity | null
}
type DirectoryProof = { identity: Identity; realpath: string }

const ownershipCode = 'AGENT_WORKSPACE_OWNERSHIP_UNCONFIRMED'
const decimal = /^(?:0|[1-9][0-9]*)$/u

function refuse(message: string, cause?: unknown): AgentMuxError {
  if (cause instanceof AgentMuxError && cause.code === ownershipCode) return cause
  const error = new AgentMuxError(`The Core-owned Agent workspace cannot be proven. No directory was replaced or rebuilt. ${message}`, ownershipCode)
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause })
  return error
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== keys.length) throw refuse('The workspace identity marker has an invalid schema.')
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || !keys.includes(key) || !descriptor?.enumerable || !('value' in descriptor)) {
      throw refuse('The workspace identity marker has an invalid schema.')
    }
  }
  return value as Record<string, unknown>
}

function identityValue(value: unknown): Identity {
  const record = exactRecord(value, ['dev', 'ino'])
  if (typeof record.dev !== 'string' || !decimal.test(record.dev) ||
      typeof record.ino !== 'string' || !decimal.test(record.ino)) throw refuse('The workspace identity marker has an invalid inode witness.')
  return { dev: record.dev, ino: record.ino }
}

function parseMarker(raw: string, location: AgentWorkspaceDirectoryLocation): Marker {
  const value = exactRecord(JSON.parse(raw), ['schema', 'phase', 'runtimeId', 'agentSessionId', 'workspacePath', 'root', 'leaf'])
  if (value.schema !== 1 || !['pending', 'provisioned'].includes(value.phase as string) ||
      value.runtimeId !== location.agentWorkspace.runtimeId ||
      value.agentSessionId !== location.agentWorkspace.agentSessionId ||
      value.workspacePath !== location.agentWorkspace.workspacePath) {
    throw refuse('The workspace identity marker does not belong to this exact Runtime, Session and locator.')
  }
  const phase = value.phase as Marker['phase']
  const leaf = value.leaf === null ? null : identityValue(value.leaf)
  if (phase === 'pending' ? leaf !== null : leaf === null) throw refuse('The workspace identity marker has an inconsistent phase and leaf witness.')
  return {
    schema: 1,
    phase,
    runtimeId: location.agentWorkspace.runtimeId,
    agentSessionId: location.agentWorkspace.agentSessionId,
    workspacePath: location.agentWorkspace.workspacePath,
    root: identityValue(value.root),
    leaf
  }
}

function statsIdentity(stats: BigIntStats): Identity {
  return { dev: stats.dev.toString(10), ino: stats.ino.toString(10) }
}

function sameIdentity(one: Identity, two: Identity): boolean {
  return one.dev === two.dev && one.ino === two.ino
}

/** Pure execution-Core projection. Locating never proves existence or performs filesystem IO. */
export function locateAgentWorkspaceDirectory(input: {
  storePath: string
  runtimeId: string
  agentSessionId: string
}): AgentWorkspaceDirectoryLocation {
  const stateDirectory = dirname(input.storePath)
  const leaf = createHash('sha256').update(input.agentSessionId, 'utf8').digest('hex')
  return {
    agentWorkspace: {
      runtimeId: input.runtimeId,
      agentSessionId: input.agentSessionId,
      workspacePath: join(stateDirectory, 'agent-workspaces', leaf)
    },
    markerPath: join(stateDirectory, 'agent-workspace-identities', leaf + '.json')
  }
}

/** The only Core owner of the per-Session physical workspace reservation and identity marker. */
export class AgentWorkspaceDirectory {
  private readonly stateDirectory: string
  constructor(private readonly storePath: string, private readonly runtimeId: string) {
    if (!isAbsolute(storePath)) throw refuse('The file-backed Session Store path must be absolute.')
    this.stateDirectory = dirname(storePath)
  }

  locate(agentSessionId: string): AgentWorkspaceDirectoryLocation {
    return locateAgentWorkspaceDirectory({ storePath: this.storePath, runtimeId: this.runtimeId, agentSessionId })
  }

  async admit(agentSessionId: string, workspacePath: string, phase: 'first' | 'retained'): Promise<string> {
    const location = this.locate(agentSessionId)
    if (location.agentWorkspace.workspacePath !== workspacePath) {
      throw refuse('The requested cwd differs from this exact Session locator.')
    }
    try {
      await this.requirePlatformSupport()
      if (phase === 'retained') return await this.validateLocation(location)
      const existing = await this.readMarker(location)
      if (existing?.value.phase === 'provisioned') return await this.validateLocation(location)
      if (existing) return await this.completePending(location)
      return await this.reserve(location)
    } catch (error) {
      throw refuse(error instanceof Error ? error.message : String(error), error)
    }
  }

  async validate(agentSessionId: string, workspacePath: string): Promise<string> {
    const location = this.locate(agentSessionId)
    if (location.agentWorkspace.workspacePath !== workspacePath) {
      throw refuse('The requested cwd differs from this exact Session locator.')
    }
    try {
      await this.requirePlatformSupport()
      return await this.validateLocation(location)
    } catch (error) {
      throw refuse(error instanceof Error ? error.message : String(error), error)
    }
  }

  private async requirePlatformSupport(): Promise<void> {
    if (process.platform === 'win32' || typeof process.getuid !== 'function' || typeof constants.O_NOFOLLOW !== 'number') {
      throw refuse('This platform cannot prove same-UID no-follow directory ownership.')
    }
    // Prove both bigint identity and directory-fsync support before the first namespace mkdir.
    await lstat(this.stateDirectory, { bigint: true })
    await this.syncDirectory(this.stateDirectory)
  }

  private async syncDirectory(path: string): Promise<void> {
    const handle = await open(path, 'r')
    try { await handle.sync() } finally { await handle.close() }
  }

  private uid(): bigint {
    return BigInt(process.getuid!())
  }

  private async proveDirectory(path: string, expectedRealpath: string, expected?: Identity): Promise<DirectoryProof> {
    const before = await lstat(path, { bigint: true })
    if (!before.isDirectory() || before.uid !== this.uid()) throw refuse('The namespace or leaf is not a same-UID ordinary directory.')
    const actualRealpath = await realpath(path)
    if (actualRealpath !== expectedRealpath) throw refuse('The namespace or leaf escapes its exact realpath location.')
    const after = await lstat(path, { bigint: true })
    const identity = statsIdentity(after)
    if (!sameIdentity(statsIdentity(before), identity) || expected && !sameIdentity(expected, identity)) {
      throw refuse('The namespace or leaf inode differs from its retained physical identity.')
    }
    return { identity, realpath: actualRealpath }
  }

  private async proveRoot(expected?: Identity): Promise<DirectoryProof> {
    const stateRealpath = await realpath(this.stateDirectory)
    return await this.proveDirectory(join(this.stateDirectory, 'agent-workspaces'), join(stateRealpath, 'agent-workspaces'), expected)
  }

  private async proveLeaf(location: AgentWorkspaceDirectoryLocation, expected?: Identity, expectedRoot?: Identity): Promise<DirectoryProof> {
    const root = await this.proveRoot(expectedRoot)
    return await this.proveDirectory(location.agentWorkspace.workspacePath,
      join(root.realpath, basename(location.agentWorkspace.workspacePath)), expected)
  }

  private async proveMarkerNamespace(location: AgentWorkspaceDirectoryLocation): Promise<DirectoryProof> {
    const stateRealpath = await realpath(this.stateDirectory)
    return await this.proveDirectory(dirname(location.markerPath), join(stateRealpath, 'agent-workspace-identities'))
  }

  private async ensureNamespace(path: string, expectedRealpath: string): Promise<DirectoryProof> {
    let created = false
    try {
      await mkdir(path, { mode: 0o700 })
      created = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const proof = await this.proveDirectory(path, expectedRealpath)
    if (created) {
      await this.syncDirectory(this.stateDirectory)
      await this.syncDirectory(path)
    }
    return proof
  }

  private async readMarker(location: AgentWorkspaceDirectoryLocation): Promise<{ raw: string; value: Marker } | null> {
    try { await lstat(dirname(location.markerPath)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    await this.proveMarkerNamespace(location)
    let handle
    try {
      handle = await open(location.markerPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    try {
      const before = await handle.stat({ bigint: true })
      if (!before.isFile() || before.uid !== this.uid()) throw refuse('The workspace identity marker is not a same-UID ordinary file.')
      const raw = await handle.readFile('utf8')
      const after = await handle.stat({ bigint: true })
      if (!sameIdentity(statsIdentity(before), statsIdentity(after))) throw refuse('The workspace identity marker changed while it was read.')
      return { raw, value: parseMarker(raw, location) }
    } finally {
      await handle.close()
    }
  }

  private async reserve(location: AgentWorkspaceDirectoryLocation): Promise<string> {
    const stateRealpath = await realpath(this.stateDirectory)
    const rootPath = dirname(location.agentWorkspace.workspacePath)
    const root = await this.ensureNamespace(rootPath, join(stateRealpath, 'agent-workspaces'))
    await this.ensureNamespace(dirname(location.markerPath), join(stateRealpath, 'agent-workspace-identities'))
    try {
      await lstat(location.agentWorkspace.workspacePath)
      throw refuse('An occupied leaf has no reservation marker; the unknown occupant was retained.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const pending: Marker = {
      schema: 1,
      phase: 'pending',
      runtimeId: location.agentWorkspace.runtimeId,
      agentSessionId: location.agentWorkspace.agentSessionId,
      workspacePath: location.agentWorkspace.workspacePath,
      root: root.identity,
      leaf: null
    }
    let handle
    try {
      handle = await open(location.markerPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      return await this.admitExisting(location)
    }
    try {
      await handle.writeFile(JSON.stringify(pending) + '\n')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await this.syncDirectory(dirname(location.markerPath))
    return await this.completePending(location)
  }

  private async admitExisting(location: AgentWorkspaceDirectoryLocation): Promise<string> {
    const existing = await this.readMarker(location)
    if (!existing) return await this.reserve(location)
    if (existing.value.phase === 'provisioned') return await this.validateLocation(location)
    return await this.completePending(location)
  }

  private async completePending(location: AgentWorkspaceDirectoryLocation): Promise<string> {
    const pending = await this.readMarker(location)
    if (!pending || pending.value.phase !== 'pending') throw refuse('The retained helper record has no pending first-preparation reservation.')
    const root = await this.proveRoot(pending.value.root)
    try {
      await mkdir(location.agentWorkspace.workspacePath, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const leaf = await this.proveLeaf(location)
    if ((await readdir(location.agentWorkspace.workspacePath)).length !== 0) {
      throw refuse('A pending reservation names a nonempty unknown occupant; it was retained unchanged.')
    }
    await this.syncDirectory(location.agentWorkspace.workspacePath)
    await this.syncDirectory(root.realpath)
    const witnessedLeaf = await this.proveLeaf(location)
    const provisioned: Marker = { ...pending.value, phase: 'provisioned', leaf: witnessedLeaf.identity }
    await this.proveMarkerNamespace(location)
    await durableWriteFile(location.markerPath, JSON.stringify(provisioned) + '\n', { mode: 0o600, requireDirectorySync: true })
    return await this.validateLocation(location)
  }

  private async validateLocation(location: AgentWorkspaceDirectoryLocation): Promise<string> {
    const before = await this.readMarker(location)
    if (!before || before.value.phase !== 'provisioned') {
      throw refuse('The retained provisioned marker is absent or still pending; no leaf was created.')
    }
    await this.proveRoot(before.value.root)
    const leaf = await this.proveLeaf(location, before.value.leaf!, before.value.root)
    const after = await this.readMarker(location)
    if (!after || after.raw !== before.raw) throw refuse('The workspace identity marker changed during validation.')
    return leaf.realpath
  }
}
