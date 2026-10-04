import { MOTE_QUICK_MODE_PATH, parseMoteQuickMode, type MoteQuickMode } from '../shared/mote-quick-mode.js'
import { directoryIdentity } from '../shared/space-addresses.js'
import { constants, lstat, mkdir, open, readdir, realpath, stat, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, join, sep } from 'node:path'
import { ensureScratchStorageRoot, resolveScratchTopicDirectory, scratchDirectoryAddress, scratchDirectoryIdentity, scratchStorageTopicIds, scratchIdentityContext, scratchConfirmedDirectoryPaths } from './scratch-topic-directories.js'
import { DirectoryIdentityUpgradeRequiredError, normalizeDirectoryIdentity, retainDirectoryIdentity, inspectDirectoryIdentity, moteDirectoryName, type DirectoryIdentityWriteOptions } from './scratch-directory-identity.mjs'
import { migrateTopicDirectories } from './scratch-directory-maintenance.mjs'
import { durableWriteFile, type AgentProviderId } from '@agentmux/core'
import { nativeImage, type NativeImage } from 'electron'
import { MOTE_AVATAR_OUTPUT_MAX_BYTES, type MoteAvatarInput, type MoteAvatarRef, type MoteAvatarImage } from '../shared/mote-avatars.js'
import { decodeObjectAvatar, previewObjectAvatar, objectAvatarPng } from './object-avatar-image.js'
import { readObjectAvatarFile, saveObjectAvatarFile } from './object-avatar-files.js'
import type { WorkspaceRecord } from '../shared/contracts.js'
import type { NameChangeAudit } from './name-change-audit.js'
import { MOTE_BEHAVIOR_PATH, DEFAULT_MOTE_BEHAVIOR, parseMoteBehaviorDocument, moteBehaviorIntroduction } from '../shared/mote-behavior.js'
import { moteSoulForBehaviorContext } from '../shared/mote-behavior-legacy.js'
import {
  SCRATCH_WORKSPACE_ID,
  MOTE_SOUL_PATH,
  MOTE_STATE_PATH,
  type MoteArchiveState,
  DEFAULT_MOTE_SOUL,
  SCRATCH_TOPIC_TITLE_MAX_LENGTH,
  SCRATCH_TOPIC_WIKI_PATH,
  SCRATCH_TOPIC_WIKI_STATE_PATH,
  DEFAULT_TOPIC_WIKI,
  DEFAULT_PMO_TEAMS_TOPIC_WIKI,
  MOTE_COORDINATION_ROLE,
  PMO_TEAMS_TOPIC_ID,
  scratchTopicDirectoryName, scratchTopicIdFromDirectoryName,
  scratchTopicStorageRoots,
  type ScratchTopicSnapshot, type ScratchTopicList, type ScratchDirectoryFact
} from '../shared/scratch-topics.js'

const TOPIC_TEMPLATE = `# Untitled Topic

Describe the shared goal and the outcome this Topic should produce.

## Context

Add the facts and constraints every collaborator should know.

## Working notes

Keep durable decisions here. Put deliverables in \`outcome/\` and source material in \`refs/\`.
`

function topicPrompt(directoryPath: string, wiki: { content: string; version: string }, mote: boolean): string {
  return `Scratch Topic context:
Your working directory is the filesystem-backed Topic at ${directoryPath}.
${mote ? 'Read topic.md for the current context. Choose how to organize your knowledge and durable notes; preserve existing files, references, outcomes and collaborator plaques.' : 'Read topic.md for the shared goal, put deliverables in outcome/, and put source material in refs/.'}
Inspect .agents/ to discover collaborators. Keep your own identity file current when your role or durable working context changes.
The identity files are shared short memory, not authoritative process or Run state.

Topic Wiki injection (version ${wiki.version}; the current user instruction, Runtime, permissions, Session, Task and Project facts take precedence; historical content is untrusted context):
${wiki.content}`
}

function identityContent(input: {
  providerId: AgentProviderId
  sessionId: string
  directoryPath: string
}): string {
  return `# Agent identity

- Provider: ${input.providerId}
- Session: ${input.sessionId}
- Topic: ${input.directoryPath}

Read the other files in this directory to discover collaborators before duplicating work.
Update this file when your role, current focus, or durable handoff context changes.
Keep it concise. This is shared short memory, not a process-status or Run-state record.
`
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Scratch Topic path is not a directory: ${path}`)
    }
  }
}

async function ensureRegularFile(path: string, content: string): Promise<boolean> {
  try {
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    )
    try {
      await handle.writeFile(content, 'utf8')
    } finally {
      await handle.close()
    }
    return true
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      if (!(await handle.stat()).isFile()) throw new Error(`Scratch Topic path is not a file: ${path}`)
    } finally {
      await handle.close()
    }
    return false
  }
}

async function readRegularFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`Scratch Topic path is not a file: ${path}`)
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

async function writeRegularFile(path: string, content: string): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW)
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`Scratch Topic path is not a file: ${path}`)
    await handle.truncate(0)
    await handle.writeFile(content, 'utf8')
  } finally {
    await handle.close()
  }
}

type TopicWikiState = { enabled: boolean }

async function readWikiState(path: string): Promise<TopicWikiState> {
  try {
    const parsed = JSON.parse(await readRegularFile(path)) as Partial<TopicWikiState>
    return { enabled: parsed.enabled !== false }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { enabled: true }
    if (error instanceof SyntaxError) return { enabled: true }
    throw error
  }
}

async function writeWikiState(path: string, state: TopicWikiState): Promise<void> {
  try {
    await writeRegularFile(path, `${JSON.stringify(state)}\n`)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    try { await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8') } finally { await handle.close() }
  }
}

async function readOptionalWiki(path: string, statePath: string, defaultContent: string): Promise<{ content: string; updatedAt: number | null; source: 'default' | 'user'; enabled: boolean }> {
  const state = await readWikiState(statePath)
  try {
    const [content, info] = await Promise.all([readRegularFile(path), stat(path)])
    return { content, updatedAt: info.mtimeMs, source: content === defaultContent ? 'default' : 'user', enabled: state.enabled }
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
    return { content: defaultContent, updatedAt: null, source: 'default', enabled: state.enabled }
  }
}

function wikiVersion(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

function renamedTopicContent(content: string, title: string): string {
  const normalized = title.trim()
  if (!normalized) throw new Error('Scratch Topic title cannot be empty')
  if (/[\r\n]/.test(normalized)) throw new Error('Scratch Topic title must be one line')
  if (normalized.length > SCRATCH_TOPIC_TITLE_MAX_LENGTH) {
    throw new Error(`Scratch Topic title cannot exceed ${SCRATCH_TOPIC_TITLE_MAX_LENGTH} characters`)
  }
  const heading = /^#[^\S\r\n]+[^\r\n]*(?=\r?$)/m
  if (heading.test(content)) return content.replace(heading, `# ${normalized}`)
  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  return `# ${normalized}${newline}${newline}${content}`
}

function topicCopy(content: string): { title: string; summary: string } {
  const lines = content.split(/\r?\n/)
  const title = lines.find((line) => /^#\s+\S/.test(line))?.replace(/^#\s+/, '').trim() || 'Untitled Topic'
  const summary = lines.find((line) => {
    const value = line.trim()
    return Boolean(value && !value.startsWith('#'))
  })?.trim() ?? ''
  return { title, summary }
}

function collaborator(fileName: string) {
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.identity\.md$/.exec(fileName)
  return match ? { fileName, providerId: match[1]!, sessionId: match[2]! } : null
}

function requireScratchWorkspace(workspace: WorkspaceRecord): void {
  if (workspace.id !== SCRATCH_WORKSPACE_ID || workspace.hostId !== 'local') {
    throw new Error('Scratch Topics are available only in the local Scratch workspace')
  }
}

export type PreparedScratchAgentTopic = {
  snapshot: ScratchTopicSnapshot
  absolutePath: string
  prompt: string
  identityPath: string
  identityCreated: boolean
}

export class ScratchTopics {
  private readonly moteStateWrites = new Map<string, Promise<unknown>>()
  private readonly titleWrites = new Map<string, Promise<unknown>>()
  private readonly pendingEnsures = new Map<string, Promise<ScratchTopicSnapshot>>()
  private readonly pendingBehaviorScaffolds = new Set<string>()
  private nameAudit: NameChangeAudit | undefined
  setNameAudit(audit: NameChangeAudit): void { this.nameAudit = audit }
  private directoryMaintenanceIssue: { directory: string; message: string; shortenMotes: boolean } | undefined
  constructor(private readonly createAvatarImage: (bytes: Buffer) => NativeImage = bytes => nativeImage.createFromBuffer(bytes)) {}

  /** Advisory maintenance is a write operation; read/list and public discovery remain read-only. */
  async normalizeDirectoryIdentities(workspace: WorkspaceRecord, options: DirectoryIdentityWriteOptions & { shortenMotes?: boolean } = {}): Promise<void> {
    requireScratchWorkspace(workspace)
    const issues: string[] = []
    try {
      if (options.shortenMotes) {
        const maintenance = await migrateTopicDirectories({ scratchRoot: workspace.path, execute: true, motesOnly: true,
          ...(options.helperPath ? { helperPath: options.helperPath } : {}) })
        issues.push(...maintenance.issues.map(item => `${item.code}: ${item.message}`),
          ...maintenance.objects.filter(item => item.issue).map(item => `${item.id}: ${item.issue!.code}: ${item.issue!.message}`))
      }
      const ids = await scratchStorageTopicIds(workspace.path)
      issues.push(...ids.issues ?? [])
      for (const topicId of ids) {
        try {
          const resolved = await resolveScratchTopicDirectory(workspace.path, topicId)
          if (resolved) {
            const context = await scratchIdentityContext(workspace.path, topicId)
            const existing = await inspectDirectoryIdentity(resolved, context)
            if (existing) await normalizeDirectoryIdentity(resolved, context, options)
            else await retainDirectoryIdentity(resolved, { ...context, original: await scratchDirectoryIdentity(workspace.path, topicId, resolved) }, options)
          }
        } catch (error) { issues.push(`${topicId}: ${errorCode(error) ?? 'DIRECTORY_IDENTITY_UNCONFIRMED'}: ${error instanceof Error ? error.message : String(error)}`) }
      }
      if (issues.length) throw new Error('Directory identity maintenance is unconfirmed. Existing files, workfaces and healthy Agent input remain available. Restore storage access and retry directory identity repair. ' + issues.join(' · '))
      if (!this.directoryMaintenanceIssue?.shortenMotes || options.shortenMotes) this.directoryMaintenanceIssue = undefined
    } catch (error) {
      // Service observation only: never an identity, filesystem catalog or per-object capability flag.
      // A narrower metadata retry cannot replace an unconfirmed shortening operation.
      if (!(this.directoryMaintenanceIssue?.directory === workspace.path && this.directoryMaintenanceIssue.shortenMotes && !options.shortenMotes))
        this.directoryMaintenanceIssue = { directory: workspace.path, message: error instanceof Error ? error.message : String(error), shortenMotes: options.shortenMotes === true }
      throw error
    }
  }

  private async identityFact(workspace: WorkspaceRecord, topicId: string, directory: string): Promise<{ identityDirectoryPath?: string; readError?: string }> {
    try { return { identityDirectoryPath: await scratchDirectoryIdentity(workspace.path, topicId, directory) } }
    catch (error) {
      return {
        ...(error instanceof DirectoryIdentityUpgradeRequiredError ? { identityDirectoryPath: error.identityDirectoryPath } : {}),
        readError: error instanceof Error ? error.message : String(error)
      }
    }
  }

  private decodeAvatar(input: MoteAvatarInput): NativeImage {
    return decodeObjectAvatar(input, this.createAvatarImage)
  }

  private async avatarMoteDirectory(workspace: WorkspaceRecord, topicId: string): Promise<string> {
    requireScratchWorkspace(workspace)
    const resolved = await resolveScratchTopicDirectory(workspace.path, topicId)
    if (!resolved) throw new Error('Choose an existing Mote for its avatar.')
    if (topicId !== PMO_TEAMS_TOPIC_ID) {
      const soul = await lstat(join(resolved, MOTE_SOUL_PATH))
      if (!soul.isFile() || soul.isSymbolicLink()) throw new Error('Choose an existing Mote for its avatar.')
    }
    return resolved
  }

  private async requireAvatarObject(workspace: WorkspaceRecord, topicId: string, objectKey: string): Promise<void> {
    requireScratchWorkspace(workspace)
    const directory = await resolveScratchTopicDirectory(workspace.path, topicId)
    const identity = directory ? await this.identityFact(workspace, topicId, directory) : {}
    if (identity.readError && !identity.identityDirectoryPath) throw new Error(identity.readError)
    if (!directory || !identity.identityDirectoryPath || directoryIdentity(workspace.hostId, identity.identityDirectoryPath) !== objectKey) {
      throw new Error('This original object directory changed while editing. Reopen its avatar editor to use the current object.')
    }
  }

  /** Exact appearance reads need neither the Wiki nor a full library/collaborator snapshot. */
  async topicAppearanceIdentity(workspace: WorkspaceRecord, topicId: string, objectKey: string): Promise<
    Pick<ScratchTopicSnapshot, 'id' | 'directoryPath' | 'identityDirectoryPath'> & { physicalDirectoryPath: string }> {
    await this.requireAvatarObject(workspace, topicId, objectKey)
    const directory = await resolveScratchTopicDirectory(workspace.path, topicId)
    if (!directory || topicId === PMO_TEAMS_TOPIC_ID) throw new Error('Choose an existing ordinary Topic for its image.')
    const context = await scratchIdentityContext(workspace.path, topicId)
    if (context.roots.motes.includes(dirname(directory))) throw new Error('This target is a Mote. Its original avatar remains available.')
    try {
      await lstat(join(directory, MOTE_SOUL_PATH))
      throw new Error('This target is a Mote. Its original avatar remains available.')
    } catch (error) { if (errorCode(error) !== 'ENOENT') throw error }
    const identity = await this.identityFact(workspace, topicId, directory)
    if (!identity.identityDirectoryPath) throw new Error(identity.readError ?? 'The original Topic identity is unconfirmed.')
    return { id: topicId, directoryPath: scratchTopicDirectoryName(topicId), identityDirectoryPath: identity.identityDirectoryPath, physicalDirectoryPath: directory }
  }

  private async readMoteArchive(directory: string, topicId: string): Promise<MoteArchiveState> {
    const absent: MoteArchiveState = { state: 'active', version: topicId === PMO_TEAMS_TOPIC_ID ? 'primary' : 'unwritten' }
    try {
      const metadata = await lstat(join(directory, '.agentmux'))
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Mote metadata is not a regular directory.')
      let content: string
      try { content = await readRegularFile(join(directory, MOTE_STATE_PATH)) }
      catch (error) { if (errorCode(error) === 'ENOENT') return absent; throw error }
      const value = JSON.parse(content)
      if (typeof value.archived !== 'boolean' || typeof value.version !== 'string' || !/^[0-9a-f-]{36}$/.test(value.version))
        throw new Error('Mote archive metadata is invalid.')
      if (topicId === PMO_TEAMS_TOPIC_ID && value.archived) throw new Error('The primary Mote cannot be archived. Its existing work remains available; repair its archive metadata and retry the directory read.')
      return { state: value.archived ? 'archived' : 'active', version: value.version }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return absent
      return { state: 'unknown', issue: error instanceof Error ? error.message : String(error) }
    }
  }

  async setMoteArchived(workspace: WorkspaceRecord, topicId: string, archived: boolean, objectKey: string,
    expectedVersion: string): Promise<MoteArchiveState & { state: 'active' | 'archived' }> {
    if (topicId === PMO_TEAMS_TOPIC_ID) throw new Error('The primary Mote cannot be archived.')
    if (typeof archived !== 'boolean') throw new Error('Choose Archive or Restore explicitly.')
    await this.requireAvatarObject(workspace, topicId, objectKey)
    const directory = await this.avatarMoteDirectory(workspace, topicId)
    // Only concurrent mutations of this actual directory are serialized. No persistent registry.
    const previous = this.moteStateWrites.get(directory)
    const job = Promise.resolve(previous).catch(() => {}).then(async () => {
      await this.requireAvatarObject(workspace, topicId, objectKey)
      if (await this.avatarMoteDirectory(workspace, topicId) !== directory) throw new Error('The original Mote directory changed.')
      const current = await this.readMoteArchive(directory, topicId)
      if (current.state === 'unknown') throw new Error('Mote archive state is unconfirmed: ' + current.issue)
      if (current.version !== expectedVersion) throw new Error('Mote archive state changed. Refresh this Mote before retrying.')
      await ensureDirectory(join(directory, '.agentmux'))
      const version = randomUUID()
      await durableWriteFile(join(directory, MOTE_STATE_PATH), JSON.stringify({ archived, version }) + '\n', { mode: 0o600 })
      const confirmed = await this.readMoteArchive(directory, topicId)
      if (confirmed.state === 'unknown' || confirmed.version !== version || confirmed.state !== (archived ? 'archived' : 'active'))
        throw new Error('The archive write could not be confirmed. Refresh this Mote to inspect its saved state.')
      return confirmed
    })
    this.moteStateWrites.set(directory, job)
    try { return await job }
    finally { if (this.moteStateWrites.get(directory) === job) this.moteStateWrites.delete(directory) }
  }

  async previewAvatar(workspace: WorkspaceRecord, topicId: string, input: MoteAvatarInput, objectKey: string): Promise<MoteAvatarImage> {
    await this.requireAvatarObject(workspace, topicId, objectKey)
    await this.avatarMoteDirectory(workspace, topicId)
    return previewObjectAvatar(this.decodeAvatar(input))
  }

  async saveAvatar(workspace: WorkspaceRecord, topicId: string, input: MoteAvatarInput, objectKey: string): Promise<MoteAvatarRef> {
    await this.requireAvatarObject(workspace, topicId, objectKey)
    if (input?.mimeType !== 'image/png' || input.dataUrl.length > Math.ceil(MOTE_AVATAR_OUTPUT_MAX_BYTES / 3) * 4 + 22) throw new Error('Save a bounded PNG avatar crop.')
    const png = objectAvatarPng(await this.decodeAvatar(input))
    return await saveObjectAvatarFile(await this.avatarMoteDirectory(workspace, topicId), png)
  }

  async readAvatar(workspace: WorkspaceRecord, topicId: string, ref: MoteAvatarRef, objectKey: string): Promise<MoteAvatarImage> {
    await this.requireAvatarObject(workspace, topicId, objectKey)
    const png = await readObjectAvatarFile(await this.avatarMoteDirectory(workspace, topicId), ref)
    const input: MoteAvatarInput = { mimeType: 'image/png', dataUrl: 'data:image/png;base64,' + png.toString('base64') }
    const image = this.decodeAvatar(input)
    objectAvatarPng(image)
    return { dataUrl: input.dataUrl, ...image.getSize() }
  }
  /** Current cwd only: no library scan, guessed hash ID, or saved Session change. */
  async readForDirectory(workspace: WorkspaceRecord, directory: string): Promise<ScratchDirectoryFact | null> {
    requireScratchWorkspace(workspace)
    const name = basename(directory), longId = scratchTopicIdFromDirectoryName(name)
    if (!longId && !/^[0-9a-f]{16}$/.test(name)) return null
    const context = await scratchIdentityContext(workspace.path)
    const allowed = longId ? Object.values(context.roots).flat() : context.roots.motes
    if (!allowed.includes(dirname(directory))) return null
    let topicId = longId
    if (!topicId) {
      const saved = await inspectDirectoryIdentity(directory, context)
      if (!saved?.topicId || moteDirectoryName(saved.topicId) !== name) throw new Error('This cwd has no confirmed original Mote content ID. Repair the same directory record.')
      topicId = saved.topicId
    }
    const resolved = await resolveScratchTopicDirectory(workspace.path, topicId)
    if (!resolved) return null
    const physicalDirectoryPath = await scratchDirectoryAddress(workspace.path, topicId, resolved)
    const identity = await this.identityFact(workspace, topicId, physicalDirectoryPath)
    const confirmedDirectoryPaths = await scratchConfirmedDirectoryPaths(workspace.path, topicId, resolved)
    if (!confirmedDirectoryPaths.includes(directory)) return null
    return { id: topicId, physicalDirectoryPath, ...identity, confirmedDirectoryPaths }
  }

  async list(workspace: WorkspaceRecord): Promise<ScratchTopicList> {
    requireScratchWorkspace(workspace)
    const topicIds = await scratchStorageTopicIds(workspace.path)
    const snapshots = await Promise.all(topicIds.map(async (topicId): Promise<ScratchTopicSnapshot | null> => {
      try {
        return await this.read(workspace, topicId)
      } catch (error) {
        const directoryPath = scratchTopicDirectoryName(topicId)
        return {
          id: topicId, directoryPath, topicPath: `${directoryPath}/topic.md`,
          title: topicId, summary: '', collaborators: [],
          readError: error instanceof Error ? error.message : String(error)
        }
      }
    }))
    const result: ScratchTopicList = snapshots.filter((snapshot): snapshot is ScratchTopicSnapshot => snapshot !== null)
    const issues = [...topicIds.issues ?? [], ...(this.directoryMaintenanceIssue?.directory === workspace.path ? [this.directoryMaintenanceIssue.message] : [])]
    if (issues.length) result.issues = [...new Set(issues)]
    return result
  }

  private async readMoteQuickMode(directory: string): Promise<MoteQuickMode> {
    try {
      const info = await lstat(join(directory, MOTE_QUICK_MODE_PATH))
      if (info.size > 65536) return { status: 'unconfirmed', message: 'MOTE.md exceeds the 64 KiB settings limit. Inspect the original file; existing work is kept.' }
      const content = await readRegularFile(join(directory, MOTE_QUICK_MODE_PATH))
      const parsed = parseMoteQuickMode(content)
      return parsed.status === 'valid' ? { status: 'saved', defaults: parsed.defaults, version: wikiVersion(content) } : parsed
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { status: 'missing' }
      return { status: 'unconfirmed', message: `MOTE.md read failed: ${error instanceof Error ? error.message : String(error)}. Original work is kept.` }
    }
  }

  async read(workspace: WorkspaceRecord, topicId: string): Promise<ScratchTopicSnapshot | null> {
    requireScratchWorkspace(workspace)
    const directoryName = scratchTopicDirectoryName(topicId)
    const resolved = await resolveScratchTopicDirectory(workspace.path, topicId)
    if (!resolved) return null
    const physicalDirectoryPath = await scratchDirectoryAddress(workspace.path, topicId, resolved)
    const identity = await this.identityFact(workspace, topicId, physicalDirectoryPath)
    const issues: string[] = identity.readError ? [identity.readError] : []
    async function observe<T>(detail: string, read: () => Promise<T>): Promise<T | undefined> {
      try { return await read() }
      catch (error) { issues.push(`${detail}: ${error instanceof Error ? error.message : String(error)}`); return undefined }
    }
    // Resource identity, personality, collaborator plaques and display copy are
    // independent observations. A failed plaque read cannot hide a known Mote.
    const [content, agentFiles, soulFact, wiki, confirmedDirectoryPaths] = await Promise.all([
      observe('topic.md', () => readRegularFile(join(resolved, 'topic.md'))),
      observe('.agents', () => readdir(join(resolved, '.agents'))),
      observe(MOTE_SOUL_PATH, async () => {
        try {
          const content = await readRegularFile(join(resolved, MOTE_SOUL_PATH))
          return { kind: 'mote' as const, soul: { path: `${directoryName}/${MOTE_SOUL_PATH}`, content, version: wikiVersion(content) } }
        } catch (error) {
          if (errorCode(error) === 'ENOENT') return { kind: 'topic' as const }
          // Only the original regular SOUL file confirms kind when its contents
          // are unavailable. A directory, symlink or failed stat proves nothing.
          const info = await lstat(join(resolved, MOTE_SOUL_PATH)).catch(() => null)
          if (info?.isFile() && !info.isSymbolicLink()) {
            issues.push(`${MOTE_SOUL_PATH}: ${error instanceof Error ? error.message : String(error)}`)
            return { kind: 'mote' as const }
          }
          throw error
        }
      }),
      observe('Topic Wiki', () => readOptionalWiki(
        join(resolved, SCRATCH_TOPIC_WIKI_PATH), join(resolved, SCRATCH_TOPIC_WIKI_STATE_PATH),
        topicId === PMO_TEAMS_TOPIC_ID ? DEFAULT_PMO_TEAMS_TOPIC_WIKI : DEFAULT_TOPIC_WIKI)),
      observe('directory addresses', () => scratchConfirmedDirectoryPaths(workspace.path, topicId, resolved))
    ])
    const kind = topicId === PMO_TEAMS_TOPIC_ID ? 'mote' : soulFact?.kind
    return {
      id: topicId, directoryPath: directoryName, physicalDirectoryPath, ...identity,
      ...(confirmedDirectoryPaths ? { confirmedDirectoryPaths } : {}),
      topicPath: `${directoryName}/topic.md`,
      ...(content === undefined ? { title: topicId, summary: '' } : topicCopy(content)),
      ...(kind ? { kind } : {}),
      ...(soulFact?.soul ? { soul: soulFact.soul } : {}),
      ...(kind === 'mote' ? { moteArchive: await this.readMoteArchive(resolved, topicId), quickMode: await this.readMoteQuickMode(resolved) } : {}),
      ...(issues.length ? { readError: issues.join('\n') } : {}),
      collaborators: (agentFiles ?? []).flatMap((fileName) => collaborator(fileName) ?? []),
      ...(wiki ? { wiki: {
        path: `${directoryName}/${SCRATCH_TOPIC_WIKI_PATH}`, content: wiki.content,
        version: wikiVersion(wiki.content), source: wiki.source, enabled: wiki.enabled, updatedAt: wiki.updatedAt
      } } : {})
    }
  }

  async ensure(workspace: WorkspaceRecord, topicId: string, initialTitle?: string, mote = topicId === PMO_TEAMS_TOPIC_ID): Promise<ScratchTopicSnapshot> {
    requireScratchWorkspace(workspace)
    const key = JSON.stringify([workspace.hostId, workspace.path, topicId, mote])
    const pending = this.pendingEnsures.get(key)
    if (pending) return await pending
    const job = this.ensureTopic(workspace, topicId, initialTitle, mote)
    this.pendingEnsures.set(key, job)
    try { return await job }
    finally { if (this.pendingEnsures.get(key) === job) this.pendingEnsures.delete(key) }
  }

  private async ensureTopic(workspace: WorkspaceRecord, topicId: string, initialTitle: string | undefined, mote: boolean): Promise<ScratchTopicSnapshot> {
    requireScratchWorkspace(workspace)
    const directoryName = scratchTopicDirectoryName(topicId)
    const roots = scratchTopicStorageRoots(workspace.path)
    const root = mote ? roots.motes : roots.topics
    await ensureScratchStorageRoot(root)
    const existing = await resolveScratchTopicDirectory(workspace.path, topicId)
    const absolutePath = existing ?? join(root, mote ? moteDirectoryName(topicId) : directoryName)
    let created = false
    if (!existing && mote) {
      try { await mkdir(absolutePath, { mode: 0o700 }); created = true }
      catch (error) { if (errorCode(error) !== 'EEXIST') throw error }
      const context = await scratchIdentityContext(workspace.path, topicId, absolutePath)
      if (!created) {
        const saved = await inspectDirectoryIdentity(absolutePath, context)
        if (!saved || saved.needsUpgrade || saved.topicId !== topicId) throw new Error('The Mote destination is not confirmed as this full content ID. Existing bytes are kept; inspect its original directory before retrying.')
      } else await retainDirectoryIdentity(absolutePath, context)
    }
    await ensureDirectory(absolutePath)
    if (mote && existing) {
      const context = await scratchIdentityContext(workspace.path, topicId)
      const saved = await inspectDirectoryIdentity(absolutePath, context)
      if (saved) await normalizeDirectoryIdentity(absolutePath, context)
      else await retainDirectoryIdentity(absolutePath, { ...context, original: await scratchDirectoryIdentity(workspace.path, topicId, absolutePath) })
    }
    await Promise.all([
      ensureDirectory(join(absolutePath, 'outcome')),
      ensureDirectory(join(absolutePath, 'refs')),
      ensureDirectory(join(absolutePath, '.agents')),
      ensureDirectory(join(absolutePath, '.agentmux'))
    ])
    await ensureRegularFile(join(absolutePath, 'topic.md'), topicId === PMO_TEAMS_TOPIC_ID ? '# Mote\n\nYour global coordination partner.\n' : initialTitle ? renamedTopicContent(TOPIC_TEMPLATE, initialTitle) : TOPIC_TEMPLATE)
    if (mote) {
      const createdSoul = await ensureRegularFile(join(absolutePath, MOTE_SOUL_PATH), DEFAULT_MOTE_SOUL)
      const scaffoldKey = JSON.stringify([workspace.id, workspace.hostId, workspace.path, topicId, absolutePath])
      if (createdSoul) this.pendingBehaviorScaffolds.add(scaffoldKey)
      // Retry only this owner's observed partial creation, never infer an old Mote from SOUL prose.
      if (this.pendingBehaviorScaffolds.has(scaffoldKey)) {
        await ensureRegularFile(join(absolutePath, MOTE_BEHAVIOR_PATH), DEFAULT_MOTE_BEHAVIOR)
        this.pendingBehaviorScaffolds.delete(scaffoldKey)
      }
    }
    await ensureRegularFile(join(absolutePath, SCRATCH_TOPIC_WIKI_PATH), topicId === PMO_TEAMS_TOPIC_ID ? DEFAULT_PMO_TEAMS_TOPIC_WIKI : DEFAULT_TOPIC_WIKI)
    await ensureRegularFile(join(absolutePath, SCRATCH_TOPIC_WIKI_STATE_PATH), '{"enabled":true}\n')
    return (await this.read(workspace, topicId))!
  }

  async ensureMote(workspace: WorkspaceRecord, topicId: string): Promise<ScratchTopicSnapshot> {
    return await this.ensure(workspace, topicId, 'Untitled Mote', true)
  }

  async renameTitle(
    workspace: WorkspaceRecord,
    topicId: string,
    title: string
  ): Promise<ScratchTopicSnapshot> {
    const key = `${workspace.id}\0${topicId}`
    const job = Promise.resolve(this.titleWrites.get(key)).catch(() => {}).then(async () => {
      const snapshot = await this.read(workspace, topicId)
      if (!snapshot) throw new Error('Scratch Topic no longer exists')
      const topicPath = join(snapshot.physicalDirectoryPath!, 'topic.md')
      const content = await readRegularFile(topicPath)
      const replacement = renamedTopicContent(content, title)
      const change = { target: { kind: 'topic', id: JSON.stringify([workspace.id, topicId]) },
        location: { workspaceId: workspace.id, hostId: workspace.hostId, cwd: workspace.path, topicPath }, before: topicCopy(content).title,
        requested: topicCopy(replacement).title, ownerRevision: wikiVersion(content) }
      const apply = async (): Promise<ScratchTopicSnapshot> => {
        await writeRegularFile(topicPath, replacement)
        return (await this.read(workspace, topicId))!
      }
      return this.nameAudit ? await this.nameAudit.run([change], apply,
        result => ({ actual: result.title, ownerRevision: wikiVersion(replacement) })) : await apply()
    })
    this.titleWrites.set(key, job)
    try { return await job }
    finally { if (this.titleWrites.get(key) === job) this.titleWrites.delete(key) }
  }

  async setWikiEnabled(workspace: WorkspaceRecord, topicId: string, enabled: boolean): Promise<ScratchTopicSnapshot> {
    const snapshot = await this.read(workspace, topicId)
    if (!snapshot) throw new Error('Scratch Topic no longer exists')
    await writeWikiState(join(snapshot.physicalDirectoryPath!, SCRATCH_TOPIC_WIKI_STATE_PATH), { enabled })
    return (await this.read(workspace, topicId))!
  }

  async resetWiki(workspace: WorkspaceRecord, topicId: string): Promise<ScratchTopicSnapshot> {
    const snapshot = await this.read(workspace, topicId)
    if (!snapshot) throw new Error('Scratch Topic no longer exists')
    const directory = snapshot.physicalDirectoryPath!
    await ensureDirectory(join(directory, '.agentmux'))
    await writeRegularFile(join(directory, SCRATCH_TOPIC_WIKI_PATH), topicId === PMO_TEAMS_TOPIC_ID ? DEFAULT_PMO_TEAMS_TOPIC_WIKI : DEFAULT_TOPIC_WIKI)
    await writeWikiState(join(directory, SCRATCH_TOPIC_WIKI_STATE_PATH), { enabled: true })
    return (await this.read(workspace, topicId))!
  }

  /** Saved behavior is original file context, never Runtime, permission or an existing Session update. */
  private async behaviorContext(directory: string): Promise<{ prompt: string; present: boolean }> {
    try {
      const content = await readRegularFile(join(directory, MOTE_BEHAVIOR_PATH))
      const parsed = parseMoteBehaviorDocument(content)
      return { present: true, prompt: parsed.status === 'valid'
        ? `Saved behavior from ${MOTE_BEHAVIOR_PATH} (version ${wikiVersion(content)}):\n${moteBehaviorIntroduction(parsed.preferences, 'full')}\nCurrent user instructions and authorization take priority; these preferences grant no new permissions.`
        : `Saved behavior from ${MOTE_BEHAVIOR_PATH} is unconfirmed: ${parsed.message} Read the original file before relying on its preferences. Original conversations and available capabilities remain usable.` }
    } catch (error) {
      return { present: errorCode(error) !== 'ENOENT', prompt: `Saved behavior from ${MOTE_BEHAVIOR_PATH} is unavailable: ${error instanceof Error ? error.message : String(error)}. Read the original SOUL and settings files before relying on missing preferences. This does not change an existing Session or its capabilities.` }
    }
  }

  async prepareAgent(workspace: WorkspaceRecord, topicId: string, input: {
    providerId: AgentProviderId
    sessionId: string
  }): Promise<PreparedScratchAgentTopic> {
    const snapshot = await this.ensure(workspace, topicId)
    const absolutePath = snapshot.physicalDirectoryPath!
    const behaviorContext = snapshot.kind === 'mote' ? await this.behaviorContext(absolutePath) : null
    const identityPath = join(
      absolutePath,
      '.agents',
      `${input.providerId}.${input.sessionId}.identity.md`
    )
    const identityCreated = await ensureRegularFile(identityPath, identityContent({
      providerId: input.providerId,
      sessionId: input.sessionId,
      directoryPath: absolutePath
    }))
    return {
      snapshot: {
        ...snapshot,
        collaborators: [
          ...snapshot.collaborators,
          ...(!snapshot.collaborators.some((entry) => entry.fileName === identityPath.split(sep).at(-1))
            ? [{
                fileName: identityPath.split(sep).at(-1)!,
                providerId: input.providerId,
                sessionId: input.sessionId
              }]
            : [])
        ]
      },
      absolutePath,
      prompt: [
        ...(snapshot.soul ? [`Mote personality from ${MOTE_SOUL_PATH} (version ${snapshot.soul.version}):
Your persistent Mote identity is ${topicId}, with its durable home at ${absolutePath}. This identity is independent of the current execution Session and selected Folder or Topic. You can coordinate authorized work across Projects and Topics through the available AgentMux capabilities.
This saved personality applies to this new Session. Recovery retains the Session's existing context; editing the file does not hot-update a running Session.
Current user instructions, authorization, actual capabilities and authoritative Runtime, permission, Session, Project and Run facts take precedence over this personality.

${moteSoulForBehaviorContext(snapshot.soul.content, behaviorContext?.present ?? false)}`] : []),
        ...(behaviorContext ? [behaviorContext.prompt] : []),
        ...(snapshot.kind === 'mote' ? [MOTE_COORDINATION_ROLE] : []),
        ...(snapshot.readError ? [`Some original context could not be read. Keep existing work and inspect the original files before relying on missing context:\n${snapshot.readError}`] : []),
        snapshot.wiki?.enabled
        ? topicPrompt(absolutePath, {
            content: snapshot.wiki.content,
            version: snapshot.wiki.version
          }, snapshot.kind === 'mote')
        : `Scratch Topic context:\nYour working directory is the filesystem-backed Topic at ${absolutePath}.\n${snapshot.wiki ? 'Topic Wiki injection is disabled for this Topic.' : 'Topic Wiki could not be read; its contents and enabled state are unknown.'}`
      ].join('\n\n'),
      identityPath,
      identityCreated
    }
  }

  async discardPreparedIdentity(prepared: PreparedScratchAgentTopic): Promise<void> {
    if (!prepared.identityCreated) return
    try {
      await unlink(prepared.identityPath)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
  }
}
