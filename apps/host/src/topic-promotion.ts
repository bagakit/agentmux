import { constants, link, lstat, mkdir, open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxError, durableWriteFile, mintObjectId, type KnowledgeTopic, type TopicPromotionReceipt, type TopicUnavailable } from '@agentmux/core'
import type { ScratchTopics } from './mote-resources.js'
import type { WorkspaceRecord } from './content-types.js'
import type { ScratchTopicSnapshot } from './mote-topic-model.js'
import { scratchTopicPhysicalPath } from './mote-topic-model.js'
import { resolveScratchTopicDirectory } from './mote-directories.js'
import { topicContentSpaceId, topicContentZoneId } from './topic-categories.js'
import type { TopicSpatialPort } from './topic-knowledge.js'

const RECORD = '.agentmux/topic-promotion.json'
type Stage = TopicPromotionReceipt['stage']
type PromotionRecord = {
  version: 1; operationId: string; topicId: string; contentIdentity: string; zoneId: string;
  device: string; inode: string; stage: Stage
}
type Resources = Pick<ScratchTopics, 'read' | 'prepareMotePromotion' | 'promoteMoteDirectory'>
const ongoing = new Map<string, Promise<unknown>>()
const stages: readonly Stage[] = ['personality', 'directory', 'spatial', 'complete']
const missing = (cause: unknown) => (cause as NodeJS.ErrnoException).code === 'ENOENT'
const failure = (message: string, code: string) => new AgentMuxError(message, code)
const issue = (cause: unknown): TopicUnavailable => ({
  code: cause instanceof AgentMuxError ? cause.code : (cause as NodeJS.ErrnoException)?.code ?? 'TOPIC_PROMOTION_UNCONFIRMED',
  message: (cause instanceof Error ? cause.message : String(cause)).replace(/[\r\n]+/gu, ' '),
  recovery: 'Inspect this original promotion. Explicitly apply its same operationId to continue; keep all original content and workfaces.'
})
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

/** One Host content operation, composing original file and Core spatial owners. Never controls a Run. */
export class TopicPromotionOwner {
  constructor(private readonly resources: Resources, private readonly workspace: () => WorkspaceRecord, private readonly spatial: TopicSpatialPort) {}
  private async directory(topicId: string): Promise<string | null> {
    return resolveScratchTopicDirectory(this.workspace().path, topicId)
  }
  private async metadata(directory: string): Promise<string> {
    const path = join(directory, '.agentmux'), info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure('The original Topic metadata directory is unconfirmed. Existing work is retained.', 'TOPIC_PROMOTION_RECORD_UNCONFIRMED')
    return path
  }
  private async read(topicId: string): Promise<PromotionRecord | null> {
    const directory = await this.directory(topicId)
    if (!directory) return null
    try { await this.metadata(directory) } catch (cause) { if (missing(cause)) return null; throw cause }
    let handle
    try { handle = await open(join(directory, RECORD), constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (cause) { if (missing(cause)) return null; throw cause }
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > 16 * 1024) throw failure('The original promotion record is not a bounded regular file.', 'TOPIC_PROMOTION_RECORD_UNCONFIRMED')
      const record = JSON.parse(await handle.readFile('utf8')) as PromotionRecord
      if (record.version !== 1 || record.topicId !== topicId || typeof record.operationId !== 'string' || !record.operationId ||
        typeof record.contentIdentity !== 'string' || typeof record.zoneId !== 'string' || !stages.includes(record.stage) ||
        typeof record.device !== 'string' || typeof record.inode !== 'string')
        throw failure('The original promotion record is unconfirmed. Preserve it and its original Topic.', 'TOPIC_PROMOTION_RECORD_UNCONFIRMED')
      // Readback confirms the original record's durability, including an earlier lost directory ACK.
      await handle.sync(); await syncDirectory(join(directory, '.agentmux'))
      return record
    } finally { await handle.close() }
  }
  private async assertOriginal(record: PromotionRecord): Promise<ScratchTopicSnapshot> {
    const directory = await this.directory(record.topicId)
    if (!directory) throw failure('The original Topic directory is unavailable; its promotion is retained.', 'TOPIC_NOT_FOUND')
    const info = await lstat(directory, { bigint: true })
    const topic = await this.resources.read(this.workspace(), record.topicId)
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev.toString() !== record.device || info.ino.toString() !== record.inode || !topic ||
      topicContentSpaceId(this.workspace(), topic) !== record.contentIdentity || topicContentZoneId(this.workspace(), topic) !== record.zoneId)
      throw failure('The original Topic identity changed. Keep both the content and this operation for inspection.', 'TOPIC_PROMOTION_IDENTITY_CONFLICT')
    return topic
  }
  private async save(record: PromotionRecord): Promise<void> {
    await this.assertOriginal(record)
    const directory = (await this.directory(record.topicId))!
    await this.metadata(directory)
    await durableWriteFile(join(directory, RECORD), JSON.stringify(record) + '\n', { requireDirectorySync: true })
  }
  private async begin(topicId: string, operationId: string): Promise<PromotionRecord> {
    const workspace = this.workspace(), topic = await this.resources.read(workspace, topicId)
    if (!topic) throw failure('Choose the exact existing Topic to promote.', 'TOPIC_NOT_FOUND')
    const original = await this.spatial.inspect(topic)
    if (original.contentKind !== 'topic' || topic.kind !== 'topic')
      throw failure('This object is not a confirmed ordinary Topic. Inspect its original identity and promotion before applying.', 'TOPIC_TARGET_IS_MOTE')
    const directory = scratchTopicPhysicalPath(workspace, topic), info = await lstat(directory, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure('The original Topic directory is unconfirmed.', 'TOPIC_PROMOTION_IDENTITY_CONFLICT')
    const record: PromotionRecord = { version: 1, operationId, topicId, contentIdentity: topicContentSpaceId(workspace, topic),
      zoneId: original.zoneId, device: info.dev.toString(), inode: info.ino.toString(), stage: 'personality' }
    const parent = join(directory, '.agentmux')
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const parentInfo = await lstat(parent)
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw failure('The original Topic metadata directory is unconfirmed.', 'TOPIC_PROMOTION_RECORD_UNCONFIRMED')
    // Publish a fully synced record without replacing a concurrent operation.
    const temporary = join(parent, 'topic-promotion-' + mintObjectId() + '.tmp')
    await durableWriteFile(temporary, JSON.stringify(record) + '\n', { requireDirectorySync: true })
    try {
      try { await link(temporary, join(directory, RECORD)); await syncDirectory(parent) }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause }
    } finally { await unlink(temporary); await syncDirectory(parent) }
    const confirmed = await this.read(topicId)
    if (!confirmed) throw failure('Promotion creation is unconfirmed. Inspect the same Topic and operation before deciding.', 'TOPIC_PROMOTION_RECORD_UNCONFIRMED')
    return confirmed
  }
  private async receipt(record: PromotionRecord, problems: TopicUnavailable[] = [], persistence: 'confirmed' | 'unconfirmed' = 'confirmed'): Promise<TopicPromotionReceipt> {
    let topic: KnowledgeTopic | null = null, moteSpaceId: string | null = null
    try {
      const snapshot = await this.assertOriginal(record), position = await this.spatial.inspect(snapshot)
      topic = { topicId: snapshot.id, hostId: this.workspace().hostId, zoneId: position.zoneId,
        directoryPath: scratchTopicPhysicalPath(this.workspace(), snapshot), title: snapshot.title, summary: snapshot.summary,
        categorySpaceIds: position.categorySpaceIds, chatIds: position.chatIds, spatialRevision: position.spatialRevision,
        ...(position.contentKind ? { contentKind: position.contentKind } : {}), ...(snapshot.readError ? { readError: snapshot.readError } : {}) }
      if (position.contentKind === 'mote' && position.moteSpaceId === record.contentIdentity) moteSpaceId = position.moteSpaceId
      if (record.stage === 'complete' && (snapshot.kind !== 'mote' || !moteSpaceId))
        problems.push(issue(failure('The saved promotion has completed, but its current content or spatial identity is unconfirmed.', 'TOPIC_PROMOTION_UNCONFIRMED')))
    } catch (cause) { problems.push(issue(cause)) }
    const complete = record.stage === 'complete' && problems.length === 0 && persistence === 'confirmed'
    return { operationId: record.operationId, topicId: record.topicId, state: complete ? 'complete' : 'partial', stage: record.stage,
      topic, moteSpaceId, unavailable: problems, diskDurability: persistence }
  }
  async inspect(topicId: string, operationId?: string): Promise<TopicPromotionReceipt | null> {
    const record = await this.read(topicId)
    if (!record) return null
    if (operationId !== undefined && record.operationId !== operationId)
      throw failure('This Topic has a different original promotion operation. Inspect without an operation ID to discover it.', 'TOPIC_PROMOTION_OPERATION_CONFLICT')
    return this.receipt(record)
  }
  async apply(topicId: string, operationId: string): Promise<TopicPromotionReceipt> {
    const key = JSON.stringify([this.workspace().hostId, this.workspace().path, topicId])
    const previous = ongoing.get(key)
    const job = Promise.resolve(previous).catch(() => {}).then(() => this.perform(topicId, operationId))
    ongoing.set(key, job)
    try { return await job } finally { if (ongoing.get(key) === job) ongoing.delete(key) }
  }
  private async perform(topicId: string, operationId: string): Promise<TopicPromotionReceipt> {
    const record = await this.read(topicId) ?? await this.begin(topicId, operationId)
    if (record.operationId !== operationId)
      throw failure('This Topic already has an original promotion. Inspect it and explicitly continue that same operation.', 'TOPIC_PROMOTION_OPERATION_CONFLICT')
    if (record.stage === 'complete') {
      const current = await this.receipt(record)
      if (current.state === 'complete') return current
      // Only this explicit continuation can repair a currently incomplete result.
      record.stage = 'personality'
    }
    let persistence: 'confirmed' | 'unconfirmed' = 'confirmed'
    try {
      // Each owner can inspect/resume its own durable side effects. Never replace edited files.
      await this.assertOriginal(record)
      if (record.stage === 'personality') {
        await this.resources.prepareMotePromotion(this.workspace(), topicId)
        record.stage = 'directory'; persistence = 'unconfirmed'; await this.save(record); persistence = 'confirmed'
      }
      if (record.stage === 'directory') {
        await this.resources.promoteMoteDirectory(this.workspace(), topicId)
        record.stage = 'spatial'; persistence = 'unconfirmed'; await this.save(record); persistence = 'confirmed'
      }
      if (record.stage === 'spatial') {
        const topic = await this.assertOriginal(record)
        await this.spatial.promoteTopic(topic, { zoneId: record.zoneId, contentIdentity: record.contentIdentity })
        record.stage = 'complete'; persistence = 'unconfirmed'; await this.save(record); persistence = 'confirmed'
      }
      return this.receipt(record)
    } catch (cause) { return this.receipt(record, [issue(cause)], persistence) }
  }
}
