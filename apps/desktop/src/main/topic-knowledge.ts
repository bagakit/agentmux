import { constants, lstat, open, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { AgentMuxError, type AgentMuxRpcCallContext, type TopicCategory, type KnowledgeTopic,
  type TopicMethod, type TopicParams, type TopicResult, type AgentMuxRpcTopicsOwner,
  parseFileListResult, parseFileReadResult, type FileReadParams,
  type TopicMigrationPreview, type TopicMigrationReceipt, type TopicKnowledge, type TopicKnowledgeItem, type TopicKnowledgeDocument, type TopicKnowledgeWrite, type TopicUnavailable,
  type TopicSearchRecord, type TopicSearchObservation } from '@agentmux/core'
import type { WorkspaceRecord } from '../shared/contracts.js'
import { directoryIdentity } from '../shared/space-addresses.js'
import { UNCLASSIFIED_TOPIC_CATEGORY_ID } from '../shared/topic-categories.js'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicPhysicalPath,
  scratchTopicStorageRoots, scratchTopicDirectoryName, SCRATCH_TOPIC_WIKI_PATH, SCRATCH_TOPIC_WIKI_STATE_PATH, type ScratchTopicSnapshot, type ScratchTopicList } from '../shared/scratch-topics.js'
import { isTopicMethod, parseTopicParams, parseTopicResult, parseTopicKnowledge } from '@agentmux/core/control'
import { ensureScratchStorageRoot } from './scratch-topic-directories.js'
import type { ScratchTopics } from './scratch-topics.js'
import type { WorkspaceFiles } from './workspace-files.js'
import type { FileReadOwner } from './file-read-owner.js'
import { TopicSearchHistoryOwner, searchHistoryUnavailable, TOPIC_SEARCH_HISTORY_MAX_BYTES, TOPIC_SEARCH_HISTORY_MAX_RECORDS } from './topic-search-history.js'

const DOCUMENT_MAX_BYTES = 128 * 1024
const SEARCH_MAX_BYTES = 4 * 1024 * 1024
const SEARCH_MAX_CANDIDATES = 512
const DOCUMENT_FORMATS = new Set(['md', 'markdown', 'txt', 'rst', 'adoc', 'org', 'json', 'csv', 'yaml', 'yml', 'html'])
const DOCUMENT_ARTIFACTS = new Set(['node_modules', 'dist', 'build', 'coverage', 'target'])
type KnowledgeReadBudget = { chargedBytes: number; readBytes: number; unconfirmedReads: number; candidates: number;
  topicsVisited: number; stopped: boolean; stopReason: TopicSearchRecord['stopReason']; signal: AbortSignal }
function isOriginalDocument(path: string): boolean {
  if (path === SCRATCH_TOPIC_WIKI_PATH) return true
  if (path.split('/').some(part => part.startsWith('.') || DOCUMENT_ARTIFACTS.has(part))) return false
  if (/^knowledge\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/u.test(path)) return false
  return DOCUMENT_FORMATS.has(path.split('.').at(-1)!.toLowerCase())
}

export type TopicSpatialInspection = {
  zoneId: string; categorySpaceIds: string[]; chatIds: string[]; spatialRevision: number;
  contentIdentity?: string
  contentKind?: 'topic' | 'mote'
}
export type TopicSpatialIdentity = Pick<ScratchTopicSnapshot, 'id' | 'directoryPath' | 'identityDirectoryPath' | 'readError'>
/** Borrows the original Core graph; content metadata never copies membership. */
export interface TopicSpatialPort {
  inspect(topic: TopicSpatialIdentity): Promise<TopicSpatialInspection>
  ensureCategory(category: TopicCategory): Promise<unknown>
  ensureTopic(topic: ScratchTopicSnapshot, categoryId?: string): Promise<TopicSpatialInspection>
  moveTopic(topicId: string, categoryId: string, expectedRevision: number): Promise<TopicSpatialInspection & { previousCategorySpaceIds: string[] }>
  migratePreview(): Promise<TopicMigrationPreview>
  migrateApply(expectedRevision: number): Promise<TopicMigrationReceipt>
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT' }
function hash(bytes: string): string { return 'sha256:' + createHash('sha256').update(bytes).digest('hex') }
function issue(error: unknown, source?: string) {
  return { code: error instanceof AgentMuxError ? error.code : 'TOPIC_CONTENT_UNAVAILABLE',
    message: error instanceof Error ? error.message : String(error),
    recovery: 'Read this exact object again after its original content or spatial owner is available.', ...(source ? { source } : {}) }
}
async function regularDirectory(path: string, create = false): Promise<string> {
  if (create) await ensureScratchStorageRoot(path)
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new AgentMuxError('Topic content requires its original regular directory.', 'TOPIC_DIRECTORY_UNCONFIRMED')
  return await realpath(path)
}
async function boundedFile(path: string, maxBytes = 1024 * 1024, onReadCost?: (bytes: number) => void, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let scannedBytes = 0
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > maxBytes) throw new AgentMuxError('Topic content is not a bounded regular file.', 'TOPIC_CONTENT_INVALID')
    let bytes: Buffer
    if (onReadCost) {
      bytes = Buffer.alloc(info.size)
      while (scannedBytes < info.size) {
        signal?.throwIfAborted()
        const read = await handle.read(bytes, scannedBytes, Math.min(64 * 1024, info.size - scannedBytes), scannedBytes)
        if (!read.bytesRead) throw new AgentMuxError('The original entry changed during its bounded read.', 'TOPIC_CONTENT_UNAVAILABLE')
        scannedBytes += read.bytesRead
      }
      const after = await handle.stat()
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new AgentMuxError('The original entry changed during its bounded read.', 'TOPIC_CONTENT_UNAVAILABLE')
    } else bytes = await handle.readFile()
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } finally { onReadCost?.(scannedBytes); await handle.close() }
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}
/** The same filesystem and revision-aware save owners are consumed by GUI and public CUI. */
export class TopicKnowledgeOwner implements AgentMuxRpcTopicsOwner {
  private spatial?: TopicSpatialPort
  private originalFiles?: Pick<FileReadOwner, 'list' | 'read'>
  constructor(private readonly scratch: Pick<ScratchTopics, 'list' | 'read' | 'ensure' | 'topicAppearanceIdentity'>,
    private readonly files: Pick<WorkspaceFiles, 'write'>, private readonly workspace: () => WorkspaceRecord,
    private readonly history?: TopicSearchHistoryOwner) {}
  setSpatialPort(port: TopicSpatialPort): void { this.spatial = port }
  setFileReadPort(port: Pick<FileReadOwner, 'list' | 'read'>): void { this.originalFiles = port }
  private scope(): WorkspaceRecord {
    const workspace = this.workspace()
    if (workspace.id !== SCRATCH_WORKSPACE_ID || workspace.hostId !== 'local') throw new AgentMuxError('Use the original local Topics content workspace.', 'TOPIC_WORKSPACE_UNAVAILABLE')
    return workspace
  }
  private spatialPort(): TopicSpatialPort {
    if (!this.spatial) throw new AgentMuxError('Topic spatial membership is currently unconfirmed. Existing content and Agents remain available.', 'CONTROL_UNAVAILABLE')
    return this.spatial
  }
  private categoryPath(categoryId: string): string { return join(scratchTopicStorageRoots(this.scope().path).topics, `category--${categoryId}`) }
  /** A descriptor of an exact missing category is used only by read-only migration previews. */
  categoryDescriptor(categoryId: string, title: string): TopicCategory {
    const workspace = this.scope(), directoryPath = this.categoryPath(categoryId)
    return { categoryId, title, hostId: workspace.hostId, directoryPath,
      spaceId: directoryIdentity(workspace.hostId, directoryPath), revision: null }
  }
  async listCategories(): Promise<TopicCategory[]> {
    const root = scratchTopicStorageRoots(this.scope().path).topics
    let names: string[]
    try { await regularDirectory(root); names = await readdir(root) }
    catch (error) { if (missing(error)) return []; throw error }
    return await Promise.all(names.filter(name => /^category--[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(name)).sort().map(async name => {
      const id = name.slice('category--'.length), descriptor = this.categoryDescriptor(id, id)
      try { return await this.readCategory(id) }
      catch (error) { return { ...descriptor, readError: issue(error).message } }
    }))
  }
  private async readCategory(categoryId: string): Promise<TopicCategory> {
    const directory = await regularDirectory(this.categoryPath(categoryId)), path = join(directory, 'category.md')
    const content = await boundedFile(path, 65536), title = /^#\s+(.+)$/mu.exec(content)?.[1]?.trim()
    if (!title || title.length > 120) throw new AgentMuxError('Topic Category needs a readable title in category.md.', 'TOPIC_CATEGORY_INVALID')
    return { ...this.categoryDescriptor(categoryId, title), revision: hash(content) }
  }
  private async save(directory: string, path: string, content: string, expectedRevision: string | null, originalPath?: string): Promise<string> {
    await regularDirectory(directory)
    const scope = originalPath ? this.scope() : { ...this.scope(), path: directory }
    const result = await this.files.write(scope, { path: originalPath ?? path, content, expectedRevision })
    if (result.status === 'conflict') throw new AgentMuxError(`Topic content changed. Refresh before retrying (current revision: ${result.observedRevision ?? 'absent'}).`, 'TOPIC_CONTENT_CONFLICT', JSON.stringify({ observedRevision: result.observedRevision }))
    if (result.status !== 'written') throw new AgentMuxError(result.message + ' Inspect the exact saved object before deciding; do not automatically repeat this write.', result.status === 'unknown' ? 'TOPIC_SAVE_UNCONFIRMED' : result.code)
    await syncDirectory(directory)
    const confirmed = await boundedFile(join(directory, path))
    if (hash(confirmed) !== result.revision) throw new AgentMuxError('The saved Topic content changed before confirmation. Read its current contents before deciding.', 'TOPIC_SAVE_UNCONFIRMED')
    return result.revision
  }
  private async createCategoryContent(categoryId: string, title: string): Promise<TopicCategory> {
    const root = scratchTopicStorageRoots(this.scope().path).topics
    await regularDirectory(root, true)
    const directory = this.categoryPath(categoryId)
    await regularDirectory(directory, true)
    let current: TopicCategory | null = null
    try { current = await this.readCategory(categoryId) } catch (error) { if (!missing(error)) throw error }
    if (current) return current
    await this.save(directory, 'category.md', `# ${title.trim()}\n`, null)
    await syncDirectory(root)
    return await this.readCategory(categoryId)
  }
  async ensureDefaultCategoryContent(): Promise<TopicCategory> {
    return await this.createCategoryContent(UNCLASSIFIED_TOPIC_CATEGORY_ID, '未分类')
  }
  async listTopicSnapshots(): Promise<ScratchTopicList> { return await this.scratch.list(this.scope()) }
  /** Client appearance borrows exact identity and directory facts, never knowledge-body reads. */
  async topicAppearanceDirectory(workspaceId: string, topicId: string, objectKey: string): Promise<string> {
    const workspace = this.scope()
    if (workspace.id !== workspaceId) throw new Error('The original Topic workspace changed. Reopen its image editor.')
    const identity = await this.scratch.topicAppearanceIdentity(workspace, topicId, objectKey)
    if ((await this.spatialPort().inspect(identity)).contentKind !== 'topic')
      throw new Error('The original ordinary Topic identity is unconfirmed. Its files and workface remain available; refresh its spatial identity.')
    return identity.physicalDirectoryPath
  }
  async categoryAppearanceDirectory(categoryId: string, objectKey: string): Promise<{ hostId: string; directoryPath: string }> {
    parseTopicParams('topic.ls', { categoryId })
    const category = await this.readCategory(categoryId)
    if (category.spaceId !== objectKey) throw new Error('The original Category changed. Reopen its image editor.')
    return { hostId: category.hostId, directoryPath: category.directoryPath }
  }
  private async confirmTopicScaffold(topic: ScratchTopicSnapshot): Promise<void> {
    const directory = scratchTopicPhysicalPath(this.scope(), topic)
    for (const path of ['topic.md', SCRATCH_TOPIC_WIKI_PATH, SCRATCH_TOPIC_WIKI_STATE_PATH]) {
      const handle = await open(join(directory, path), constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        if (!(await handle.stat()).isFile()) throw new AgentMuxError('The created Topic file is unconfirmed.', 'TOPIC_SAVE_UNCONFIRMED')
        await handle.sync()
      } finally { await handle.close() }
    }
    for (const path of ['outcome', 'refs', '.agents', '.agentmux']) await syncDirectory(await regularDirectory(join(directory, path)))
    await syncDirectory(await regularDirectory(directory))
    await syncDirectory(scratchTopicStorageRoots(this.scope().path).topics)
  }
  private isMote(topic: ScratchTopicSnapshot): boolean { return topic.id === PMO_TEAMS_TOPIC_ID || topic.soul !== undefined || topic.moteArchive !== undefined }
  private async requireTopic(topicId: string): Promise<ScratchTopicSnapshot | null> {
    const topic = await this.scratch.read(this.scope(), topicId)
    if (topic && this.isMote(topic)) throw new AgentMuxError('Choose an ordinary knowledge Topic. This target is a Mote; its original content and work remain available.', 'TOPIC_TARGET_IS_MOTE')
    return topic
  }
  /** Missing personality metadata cannot override an original Core Mote identity. */
  private async confirmKnowledgeTopic(topic: ScratchTopicSnapshot): Promise<TopicSpatialInspection> {
    if (topic.readError) throw new AgentMuxError('This content scope is unconfirmed. Repair the original metadata before reading its knowledge; the original files and work remain available.', 'TOPIC_SCOPE_UNCONFIRMED')
    const original = await this.spatialPort().inspect(topic)
    if (original.contentKind !== 'topic') throw new AgentMuxError('The original Topic kind is not confirmed. Refresh its original spatial identity before this knowledge operation; content, workfaces and healthy Agents remain available.', 'TOPIC_IDENTITY_UNCONFIRMED')
    return original
  }
  private async requireKnowledgeTopic(topicId: string): Promise<ScratchTopicSnapshot | null> {
    const topic = await this.requireTopic(topicId)
    if (topic) await this.confirmKnowledgeTopic(topic)
    return topic
  }
  private topicFact(topic: ScratchTopicSnapshot, spatial: TopicSpatialInspection): KnowledgeTopic {
    return { topicId: topic.id, hostId: this.scope().hostId, zoneId: spatial.zoneId,
      directoryPath: scratchTopicPhysicalPath(this.scope(), topic), title: topic.title, summary: topic.summary,
      categorySpaceIds: spatial.categorySpaceIds, chatIds: spatial.chatIds, spatialRevision: spatial.spatialRevision,
      ...(topic.readError ? { readError: topic.readError } : {}) }
  }
  private async knowledgeDirectory(topic: ScratchTopicSnapshot, create = false): Promise<string> {
    const directory = await regularDirectory(scratchTopicPhysicalPath(this.scope(), topic))
    const knowledge = join(directory, 'knowledge')
    return await regularDirectory(knowledge, create)
  }
  private async readKnowledge(topic: ScratchTopicSnapshot, entryId: string, maxBytes?: number, onReadCost?: (bytes: number) => void, signal?: AbortSignal): Promise<TopicKnowledge | null> {
    try {
      const directory = await this.knowledgeDirectory(topic), content = await boundedFile(join(directory, entryId + '.json'), maxBytes, onReadCost, signal)
      const entry = parseTopicKnowledge({ ...JSON.parse(content), revision: hash(content) })
      if (entry.topicId !== topic.id || entry.entryId !== entryId) throw new AgentMuxError('Knowledge bytes belong to another original entry. Keep both identities and inspect the original file.', 'TOPIC_KNOWLEDGE_IDENTITY_CONFLICT')
      return entry
    } catch (error) { if (missing(error)) return null; throw error }
  }
  private canContinue(topic: ScratchTopicSnapshot, budget: KnowledgeReadBudget, count: number, limit: number, unavailable: TopicUnavailable[]): boolean {
    if (budget.stopped) return false
    const reason = budget.signal.aborted ? 'deadline' : count >= limit ? 'result-limit'
      : budget.chargedBytes >= SEARCH_MAX_BYTES ? 'byte-limit' : budget.candidates >= SEARCH_MAX_CANDIDATES ? 'candidate-limit' : null
    if (reason) {
      this.stopDiscovery(budget, reason, unavailable, topic.id)
      return false
    }
    return true
  }
  private stopDiscovery(budget: KnowledgeReadBudget, reason: NonNullable<TopicSearchRecord['stopReason']>, unavailable: TopicUnavailable[], source?: string): void {
    budget.stopped = true; budget.stopReason = reason
    unavailable.push(issue(new AgentMuxError(`Knowledge discovery reached its ${reason}. Narrow the Topic/query or open the original file to continue; this is a partial observation.`, 'TOPIC_KNOWLEDGE_PARTIAL'), source))
  }
  private chargeRead(budget: KnowledgeReadBudget, reservation: number) {
    budget.chargedBytes += reservation
    let confirmedBytes: number | null = null, invalid = false
    return {
      confirm: (bytes: number) => {
        if (invalid) return
        if (confirmedBytes !== null || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > reservation) {
          if (confirmedBytes !== null) { budget.readBytes -= confirmedBytes; budget.chargedBytes += reservation - confirmedBytes }
          confirmedBytes = null; invalid = true
          return
        }
        confirmedBytes = bytes; budget.readBytes += bytes; budget.chargedBytes += bytes - reservation
      },
      finish: () => { if (confirmedBytes === null) budget.unconfirmedReads++ }
    }
  }
  private async knowledgeEntries(topic: ScratchTopicSnapshot, query: string | null, limit: number,
    entries: TopicKnowledgeItem[], unavailable: TopicUnavailable[], budget: KnowledgeReadBudget): Promise<void> {
    let directory: string
    try { directory = await this.knowledgeDirectory(topic) } catch (error) { if (missing(error)) return; throw error }
    const names = (await readdir(directory)).filter(name => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/u.test(name)).sort()
    for (const name of names) {
      if (!this.canContinue(topic, budget, entries.length, limit, unavailable)) return
      budget.candidates++
      const entryId = name.slice(0, -5)
      const reservation = Math.min(1024 * 1024, SEARCH_MAX_BYTES - budget.chargedBytes), charge = this.chargeRead(budget, reservation)
      try {
        const entry = await this.readKnowledge(topic, entryId, reservation, charge.confirm, budget.signal)
        if (!entry) { unavailable.push(issue(new Error('The original knowledge entry changed during discovery.'), entryId)); continue }
        if (query !== null && ![entry.title, entry.content, entry.scope ?? '', JSON.stringify(entry.sources)].join('\n').toLocaleLowerCase().includes(query)) continue
        entries.push(entry)
      } catch (error) {
        entries.push({ topicId: topic.id, entryId, readError: issue(error).message })
        unavailable.push(issue(error, entryId))
      } finally { charge.finish() }
    }
  }
  private async documentEntries(topic: ScratchTopicSnapshot, original: TopicSpatialInspection, query: string | null, limit: number,
    entries: TopicKnowledgeItem[], documents: TopicKnowledgeDocument[], unavailable: TopicUnavailable[], budget: KnowledgeReadBudget): Promise<void> {
    if (!this.canContinue(topic, budget, entries.length + documents.length, limit, unavailable)) return
    if (!this.originalFiles) throw new AgentMuxError('The original Files owner is unavailable. Saved entries and original file workfaces remain available.', 'CONTROL_UNAVAILABLE')
    const workspace = this.scope(), expectedResource = { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path }
    const request = { zoneId: original.zoneId, path: '.', expectedResource, limit: SEARCH_MAX_CANDIDATES - budget.candidates }
    const listing = parseFileListResult(await this.originalFiles.list(request, { signal: budget.signal }), request)
    if (listing.result.status !== 'listed') throw new AgentMuxError(listing.result.message, listing.result.code)
    if (!listing.result.complete || listing.result.omitted !== 'none') unavailable.push(issue(new AgentMuxError(
      `Original document discovery is bounded or omits Git-ignored files (${listing.result.partialReason ?? listing.result.omitted}). Open the exact original file or narrow discovery to continue.`, 'TOPIC_KNOWLEDGE_PARTIAL'), topic.id))
    if (listing.result.omitted === 'git-ignored') unavailable.push(issue(new AgentMuxError('Git-ignored document candidates were omitted by the original Files owner.', 'TOPIC_DOCUMENTS_GIT_IGNORED'), topic.id))
    if (listing.result.partialReason) {
      unavailable.push(issue(new AgentMuxError('The original Files owner returned partial document discovery.', 'TOPIC_DOCUMENT_DISCOVERY_' + listing.result.partialReason.toUpperCase()), topic.id))
      if (listing.result.partialReason === 'limit') budget.stopReason ??= 'candidate-limit'
    }
    const paths = [...listing.result.files]
    // The original metadata owner confirms a saved Wiki; Git omission must not hide this explicit source.
    if (topic.wiki?.updatedAt != null && paths.length < request.limit && !paths.includes(SCRATCH_TOPIC_WIKI_PATH)) paths.push(SCRATCH_TOPIC_WIKI_PATH)
    for (const path of paths.sort()) {
      if (!this.canContinue(topic, budget, entries.length + documents.length, limit, unavailable)) return
      budget.candidates++
      if (!isOriginalDocument(path)) continue
      const target: FileReadParams = { zoneId: original.zoneId, path, expectedResource, maxBytes: DOCUMENT_MAX_BYTES }
      const document: TopicKnowledgeDocument = { topicId: topic.id, target, title: path.split('/').at(-1)!, snippet: null, revision: null, readScope: 'name' }
      if (query === null) { documents.push(document); continue }
      const reservation = Math.min(DOCUMENT_MAX_BYTES, SEARCH_MAX_BYTES - budget.chargedBytes), charge = this.chargeRead(budget, reservation)
      try {
        const read = parseFileReadResult(await this.originalFiles.read(target, { maxFileBytes: reservation, signal: budget.signal,
          onReadCost: cost => charge.confirm(cost.payloadBytes)
        }), target)
        if (reservation < DOCUMENT_MAX_BYTES && read.result.status === 'error' && read.result.code === 'WORKSPACE_FILE_BYTE_LIMIT') {
          unavailable.push(issue(new AgentMuxError('The remaining shared byte budget cannot cover this original document. Narrow the Topic/query or read its exact file; the unobserved tail is partial.', 'TOPIC_KNOWLEDGE_PARTIAL'), topic.id + ':' + path))
          budget.stopped = true; budget.stopReason = 'byte-limit'
          return
        }
        if (read.result.status !== 'read') throw new AgentMuxError(
          read.result.status === 'error' || read.result.status === 'unknown' ? read.result.message : `The original document is ${read.result.status}; its bytes and file workface are kept.`,
          read.result.status === 'error' || read.result.status === 'unknown' ? read.result.code : 'TOPIC_DOCUMENT_UNAVAILABLE')
        const text = read.result.document.content, position = text.toLocaleLowerCase().indexOf(query)
        if (position < 0 && !path.toLocaleLowerCase().includes(query)) continue
        documents.push({ ...document, readScope: 'full', revision: read.result.document.revision,
          snippet: text.slice(Math.max(0, position - 60), Math.max(0, position - 60) + 240) })
      } catch (error) { unavailable.push(issue(error, topic.id + ':' + path)) }
      finally { charge.finish() }
    }
  }
  private readBudget(context?: AgentMuxRpcCallContext): KnowledgeReadBudget {
    const deadline = AbortSignal.timeout(10000)
    return { chargedBytes: 0, readBytes: 0, unconfirmedReads: 0, candidates: 0, topicsVisited: 0, stopped: false, stopReason: null,
      signal: context?.signal ? AbortSignal.any([context.signal, deadline]) : deadline }
  }
  private async collectKnowledge(topicId: string | undefined, query: string | null, limit: number,
    entries: TopicKnowledgeItem[], documents: TopicKnowledgeDocument[], unavailable: TopicUnavailable[], budget: KnowledgeReadBudget,
    context?: AgentMuxRpcCallContext): Promise<void> {
    context?.signal?.throwIfAborted()
    const discovery = topicId ? null : await this.listTopicSnapshots()
    for (const message of discovery?.issues ?? []) unavailable.push(issue(new AgentMuxError(message, 'TOPIC_SCOPE_UNCONFIRMED')))
    const exact = topicId ? await this.requireTopic(topicId) : null
    if (topicId && !exact) throw new AgentMuxError('The exact Topic does not exist. Choose an existing ordinary Topic before searching its knowledge.', 'TOPIC_NOT_FOUND')
    const topics = topicId ? [exact!] : discovery!.filter(topic => !this.isMote(topic))
    for (const topic of topics) {
      context?.signal?.throwIfAborted()
      if (!this.canContinue(topic, budget, entries.length + documents.length, limit, unavailable)) break
      budget.topicsVisited++
      let originalConfirmed = false
      try {
        const original = await this.confirmKnowledgeTopic(topic)
        originalConfirmed = true
        await this.knowledgeEntries(topic, query, limit - documents.length, entries, unavailable, budget)
        await this.documentEntries(topic, original, query, limit, entries, documents, unavailable, budget)
      } catch (error) {
        context?.signal?.throwIfAborted()
        if (topicId && !originalConfirmed) throw error
        unavailable.push(issue(error, topic.id))
      }
    }
    context?.signal?.throwIfAborted()
    if (budget.signal.aborted && !budget.stopped) this.stopDiscovery(budget, 'deadline', unavailable, topicId)
  }
  private async listKnowledge(params: TopicParams<'topic.knowledge.ls'>, context?: AgentMuxRpcCallContext): Promise<TopicResult<'topic.knowledge.ls'>> {
    const entries: TopicKnowledgeItem[] = [], documents: TopicKnowledgeDocument[] = [], unavailable: TopicUnavailable[] = []
    await this.collectKnowledge(params.topicId, null, params.limit ?? 32, entries, documents, unavailable, this.readBudget(context), context)
    return { entries, documents, unavailable }
  }
  private async searchKnowledge(params: TopicParams<'topic.knowledge.search'>, context?: AgentMuxRpcCallContext): Promise<TopicResult<'topic.knowledge.search'>> {
    const startedAt = Date.now(), clock = performance.now(), budget = this.readBudget(context)
    const entries: TopicKnowledgeItem[] = [], documents: TopicKnowledgeDocument[] = [], unavailable: TopicUnavailable[] = [], limit = params.limit ?? 32
    let failed = false, failure: unknown
    try { await this.collectKnowledge(params.topicId, params.query.toLocaleLowerCase(), limit, entries, documents, unavailable, budget, context) }
    catch (error) { failed = true; failure = error; unavailable.push(issue(error, params.topicId)) }
    const cancelled = context?.signal?.aborted === true
    if (cancelled) { budget.stopReason = 'cancelled'; unavailable.push(issue(new AgentMuxError('The caller cancelled this search.', 'TOPIC_SEARCH_CANCELLED'), params.topicId)) }
    const issues: TopicSearchRecord['issues'] = []
    let omittedIssueCount = 0
    for (const { code, source } of unavailable) {
      // Keep exact source identities; a wire-unrepresentable source is an omitted
      // observation, never a truncated path or a reason to lose healthy results.
      if (issues.length >= 32 || !code.length || code.length > 120 || /[\0\r\n]/u.test(code)
        || source !== undefined && (!source.length || source.length > 4096 || /[\0\r\n]/u.test(source))) { omittedIssueCount++; continue }
      issues.push({ code, ...(source ? { source } : {}) })
    }
    const record: TopicSearchRecord = { searchId: randomUUID(), query: params.query, topicId: params.topicId ?? null, limit,
      startedAt, finishedAt: Math.max(startedAt, Date.now()), durationMs: Math.max(0, Math.round(performance.now() - clock)),
      outcome: cancelled ? 'cancelled' : failed ? 'error' : unavailable.length ? 'partial' : 'complete',
      counters: { topicsVisited: budget.topicsVisited, candidates: budget.candidates, readBytes: budget.readBytes,
        chargedBytes: budget.chargedBytes, unconfirmedReads: budget.unconfirmedReads,
        entryMatches: entries.filter(entry => !('readError' in entry)).length, documentMatches: documents.length },
      stopReason: budget.stopReason, issues, omittedIssueCount }
    const observation: TopicSearchObservation = this.history ? await this.history.record(record)
      : { record, history: 'unavailable', unavailable: [searchHistoryUnavailable()] }
    if (failed) throw failure
    context?.signal?.throwIfAborted()
    return { entries, documents, unavailable, observation }
  }
  async call<M extends TopicMethod>(method: M, params: TopicParams<M>, context?: AgentMuxRpcCallContext): Promise<TopicResult<M>> {
    if (!isTopicMethod(method)) throw new AgentMuxError('Choose a registered Topic operation.', 'INVALID_CONTROL_REQUEST')
    const input = parseTopicParams(method, params), p = input as Record<string, unknown>
    if (method !== 'topic.knowledge.search') context?.signal?.throwIfAborted()
    let result: unknown
    switch (method) {
      case 'topic.category.ls': {
        const categories = await this.listCategories()
        result = { categories, unavailable: categories.filter(item => item.readError).map(item => issue(new Error(item.readError!), item.categoryId)) }; break
      }
      case 'topic.category.create': {
        const category = await this.createCategoryContent(p.categoryId as string, p.title as string)
        await this.spatialPort().ensureCategory(category)
        result = { category, diskDurability: 'confirmed' }; break
      }
      case 'topic.category.rename': {
        const category = await this.readCategory(p.categoryId as string), content = await boundedFile(join(category.directoryPath, 'category.md'), 65536)
        const updated = content.replace(/^#\s+.+$/mu, `# ${(p.title as string).trim()}`)
        await this.save(category.directoryPath, 'category.md', updated, p.expectedRevision as string)
        const renamed = await this.readCategory(category.categoryId)
        await this.spatialPort().ensureCategory(renamed)
        result = { category: renamed, diskDurability: 'confirmed' }; break
      }
      case 'topic.ls': {
        const categories = p.categoryId ? await this.listCategories() : []
        const category = categories.find(item => item.categoryId === p.categoryId)
        if (p.categoryId && (!category || category.readError)) throw new AgentMuxError('The exact Topic Category is unavailable. Existing Topics remain available through topic ls.', 'TOPIC_CATEGORY_UNAVAILABLE')
        const topics: KnowledgeTopic[] = [], unavailable = []
        for (const snapshot of await this.listTopicSnapshots()) {
          if (this.isMote(snapshot) || p.topicId && snapshot.id !== p.topicId) continue
          try {
            const topic = this.topicFact(snapshot, await this.spatialPort().inspect(snapshot))
            if (!category || topic.categorySpaceIds.includes(category.spaceId)) topics.push(topic)
            if (snapshot.readError) unavailable.push(issue(new Error(snapshot.readError), snapshot.id))
          } catch (error) { unavailable.push(issue(error, snapshot.id)) }
        }
        result = { topics, unavailable }; break
      }
      case 'topic.inspect': {
        const topic = await this.requireTopic(p.topicId as string)
        result = { topic: topic ? this.topicFact(topic, await this.spatialPort().inspect(topic)) : null, unavailable: [] }; break
      }
      case 'topic.create': {
        let topic = await this.requireTopic(p.topicId as string)
        if (topic) {
          const original = await this.spatialPort().inspect(topic)
          if (original.contentKind === 'topic') {
            result = { topic: this.topicFact(topic, original), diskDurability: 'confirmed' }; break
          }
          if (topic.kind !== 'topic' || topic.readError)
            throw new AgentMuxError('The original Topic content is unconfirmed. Repair its original metadata and retry creation with the same ID; its files and work remain available.', 'TOPIC_SCOPE_UNCONFIRMED')
        }
        const category = p.categoryId ? await this.readCategory(p.categoryId as string) : await this.ensureDefaultCategoryContent()
        await this.spatialPort().ensureCategory(category)
        // A failed spatial CAS can leave durable content without its Core registration.
        // Ensure the same scaffold without replacing any already authored bytes.
        topic = await this.scratch.ensure(this.scope(), p.topicId as string, p.title as string)
        await this.confirmTopicScaffold(topic)
        const position = await this.spatialPort().ensureTopic(topic, category.categoryId)
        result = { topic: this.topicFact(topic, position), diskDurability: 'confirmed' }; break
      }
      case 'topic.move': {
        const topic = await this.requireTopic(p.topicId as string)
        if (!topic) throw new AgentMuxError('The exact Topic does not exist.', 'TOPIC_NOT_FOUND')
        await this.readCategory(p.categoryId as string)
        const position = await this.spatialPort().moveTopic(topic.id, p.categoryId as string, p.expectedRevision as number)
        result = { topic: this.topicFact(topic, position), previousCategorySpaceIds: position.previousCategorySpaceIds,
          spatialRevision: position.spatialRevision, diskDurability: 'confirmed' }; break
      }
      case 'topic.knowledge.read': {
        const topic = await this.requireKnowledgeTopic(p.topicId as string)
        result = { entry: topic ? await this.readKnowledge(topic, p.entryId as string) : null }; break
      }
      case 'topic.knowledge.write': {
        const topic = await this.requireKnowledgeTopic(p.topicId as string)
        if (!topic) throw new AgentMuxError('Choose an existing exact Topic before saving knowledge.', 'TOPIC_NOT_FOUND')
        const directory = await this.knowledgeDirectory(topic, true)
        const { expectedRevision, ...authored } = input as TopicKnowledgeWrite
        const saved = { ...authored, updatedAt: Date.now() }, bytes = JSON.stringify(saved) + '\n'
        const fileName = saved.entryId + '.json'
        await this.save(directory, fileName, bytes, expectedRevision, scratchTopicDirectoryName(topic.id) + '/knowledge/' + fileName)
        await syncDirectory(scratchTopicPhysicalPath(this.scope(), topic))
        const entry = await this.readKnowledge(topic, saved.entryId)
        if (!entry || entry.revision !== hash(bytes)) throw new AgentMuxError('Knowledge save could not be confirmed. Read this exact entry before deciding; do not automatically repeat the write.', 'TOPIC_SAVE_UNCONFIRMED')
        result = { entry, diskDurability: 'confirmed' }; break
      }
      case 'topic.knowledge.ls': result = await this.listKnowledge(input as TopicParams<'topic.knowledge.ls'>, context); break
      case 'topic.knowledge.search': result = await this.searchKnowledge(input as TopicParams<'topic.knowledge.search'>, context); break
      case 'topic.knowledge.history': result = this.history ? await this.history.read(input as TopicParams<'topic.knowledge.history'>)
        : { records: [], hasMore: false, retention: { maxRecords: TOPIC_SEARCH_HISTORY_MAX_RECORDS,
          maxBytes: TOPIC_SEARCH_HISTORY_MAX_BYTES, prunedRecords: 0 }, unavailable: [searchHistoryUnavailable()] }; break
      case 'topic.migrate.preview': result = await this.spatialPort().migratePreview(); break
      case 'topic.migrate.apply': result = await this.spatialPort().migrateApply(p.expectedRevision as number); break
    }
    return parseTopicResult(method, result, input)
  }
}
