import { constants, lstat, open, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { AgentMuxError, type AgentMuxRpcCallContext, type TopicCategory, type KnowledgeTopic,
  type TopicMethod, type TopicParams, type TopicResult, type AgentMuxRpcTopicsOwner,
  type TopicMigrationPreview, type TopicMigrationReceipt, type TopicKnowledge, type TopicKnowledgeItem, type TopicKnowledgeWrite, type TopicUnavailable } from '@agentmux/core'
import type { WorkspaceRecord } from '../shared/contracts.js'
import { directoryIdentity } from '../shared/space-addresses.js'
import { UNCLASSIFIED_TOPIC_CATEGORY_ID } from '../shared/topic-categories.js'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicPhysicalPath,
  scratchTopicStorageRoots, scratchTopicDirectoryName, SCRATCH_TOPIC_WIKI_PATH, SCRATCH_TOPIC_WIKI_STATE_PATH, type ScratchTopicSnapshot } from '../shared/scratch-topics.js'
import { isTopicMethod, parseTopicParams, parseTopicResult, parseTopicKnowledge } from '@agentmux/core/control'
import { ensureScratchStorageRoot } from './scratch-topic-directories.js'
import type { ScratchTopics } from './scratch-topics.js'
import type { WorkspaceFiles } from './workspace-files.js'

export type TopicSpatialInspection = {
  zoneId: string; categorySpaceIds: string[]; chatIds: string[]; spatialRevision: number;
  contentIdentity?: string
}
/** Borrows the original Core graph; content metadata never copies membership. */
export interface TopicSpatialPort {
  inspect(topic: ScratchTopicSnapshot): Promise<TopicSpatialInspection>
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
async function boundedFile(path: string, maxBytes = 1024 * 1024): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > maxBytes) throw new AgentMuxError('Topic content is not a bounded regular file.', 'TOPIC_CONTENT_INVALID')
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await handle.readFile())
  } finally { await handle.close() }
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}
/** The same filesystem and revision-aware save owners are consumed by GUI and public CUI. */
export class TopicKnowledgeOwner implements AgentMuxRpcTopicsOwner {
  private spatial?: TopicSpatialPort
  constructor(private readonly scratch: Pick<ScratchTopics, 'list' | 'read' | 'ensure'>,
    private readonly files: Pick<WorkspaceFiles, 'write'>, private readonly workspace: () => WorkspaceRecord) {}
  setSpatialPort(port: TopicSpatialPort): void { this.spatial = port }
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
  async listTopicSnapshots(): Promise<ScratchTopicSnapshot[]> { return await this.scratch.list(this.scope()) }
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
  private async readKnowledge(topic: ScratchTopicSnapshot, entryId: string): Promise<TopicKnowledge | null> {
    try {
      const directory = await this.knowledgeDirectory(topic), content = await boundedFile(join(directory, entryId + '.json'))
      const entry = parseTopicKnowledge({ ...JSON.parse(content), revision: hash(content) })
      if (entry.topicId !== topic.id || entry.entryId !== entryId) throw new AgentMuxError('Knowledge bytes belong to another original entry. Keep both identities and inspect the original file.', 'TOPIC_KNOWLEDGE_IDENTITY_CONFLICT')
      return entry
    } catch (error) { if (missing(error)) return null; throw error }
  }
  private async knowledgeEntries(topic: ScratchTopicSnapshot, query: string | null, limit: number,
    entries: TopicKnowledgeItem[], unavailable: TopicUnavailable[], budget: { bytes: number }): Promise<void> {
    if (topic.readError) throw new AgentMuxError('This content scope is unconfirmed. Repair the original metadata before reading its knowledge; the original files and work remain available.', 'TOPIC_SCOPE_UNCONFIRMED')
    let directory: string
    try { directory = await this.knowledgeDirectory(topic) } catch (error) { if (missing(error)) return; throw error }
    const names = (await readdir(directory)).filter(name => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/u.test(name)).sort()
    for (const name of names) {
      if (entries.length >= limit) { unavailable.push(issue(new AgentMuxError('Knowledge results reached the requested limit. Read exact entries or narrow this query to continue.', 'TOPIC_KNOWLEDGE_PARTIAL'), topic.id)); return }
      const entryId = name.slice(0, -5)
      try {
        const entry = await this.readKnowledge(topic, entryId)
        if (!entry) { unavailable.push(issue(new Error('The original knowledge entry changed during discovery.'), entryId)); continue }
        if (query !== null && ![entry.title, entry.content, entry.scope ?? '', JSON.stringify(entry.sources)].join('\n').toLocaleLowerCase().includes(query)) continue
        const bytes = Buffer.byteLength(JSON.stringify(entry))
        if (budget.bytes + bytes > 1024 * 1024) { unavailable.push(issue(new AgentMuxError('Knowledge results reached the read budget. Read exact entries or narrow this query to continue.', 'TOPIC_KNOWLEDGE_PARTIAL'), topic.id)); return }
        budget.bytes += bytes; entries.push(entry)
      } catch (error) {
        entries.push({ topicId: topic.id, entryId, readError: issue(error).message })
        unavailable.push(issue(error, entryId))
      }
    }
  }
  async call<M extends TopicMethod>(method: M, params: TopicParams<M>, context?: AgentMuxRpcCallContext): Promise<TopicResult<M>> {
    if (!isTopicMethod(method)) throw new AgentMuxError('Choose a registered Topic operation.', 'INVALID_CONTROL_REQUEST')
    const input = parseTopicParams(method, params), p = input as Record<string, unknown>
    context?.signal?.throwIfAborted()
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
          result = { topic: this.topicFact(topic, await this.spatialPort().inspect(topic)), diskDurability: 'confirmed' }; break
        }
        const category = p.categoryId ? await this.readCategory(p.categoryId as string) : await this.ensureDefaultCategoryContent()
        await this.spatialPort().ensureCategory(category)
        if (!topic) {
          topic = await this.scratch.ensure(this.scope(), p.topicId as string, p.title as string)
          await this.confirmTopicScaffold(topic)
        }
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
        const topic = await this.requireTopic(p.topicId as string)
        result = { entry: topic ? await this.readKnowledge(topic, p.entryId as string) : null }; break
      }
      case 'topic.knowledge.write': {
        const topic = await this.requireTopic(p.topicId as string)
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
      case 'topic.knowledge.ls': case 'topic.knowledge.search': {
        const entries: TopicKnowledgeItem[] = [], unavailable: TopicUnavailable[] = [], limit = p.limit as number ?? 32
        const query = method === 'topic.knowledge.search' ? (p.query as string).toLocaleLowerCase() : null
        const topics = p.topicId ? [await this.requireTopic(p.topicId as string)].filter((topic): topic is ScratchTopicSnapshot => topic !== null)
          : (await this.listTopicSnapshots()).filter(topic => !this.isMote(topic))
        const budget = { bytes: 0 }
        for (const topic of topics) {
          try { await this.knowledgeEntries(topic, query, limit, entries, unavailable, budget) }
          catch (error) { unavailable.push(issue(error, topic.id)) }
        }
        result = { entries, unavailable }; break
      }
      case 'topic.migrate.preview': result = await this.spatialPort().migratePreview(); break
      case 'topic.migrate.apply': result = await this.spatialPort().migrateApply(p.expectedRevision as number); break
    }
    return parseTopicResult(method, result, input)
  }
}
