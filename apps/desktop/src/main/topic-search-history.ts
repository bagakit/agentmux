import { constants, open } from 'node:fs/promises'
import { AgentMuxError, durableWriteFile, type TopicSearchHistory, type TopicSearchObservation,
  type TopicSearchRecord, type TopicParams, type TopicUnavailable } from '@agentmux/core'
import { parseTopicParams, parseTopicSearchRecord } from '@agentmux/core/control'

export const TOPIC_SEARCH_HISTORY_MAX_RECORDS = 128
export const TOPIC_SEARCH_HISTORY_MAX_BYTES = 1024 * 1024
type Snapshot = { schema: 'agentmux.topic-search-history.v1'; records: TopicSearchRecord[]; prunedRecords: number }

export function searchHistoryUnavailable(source?: string, step: 'read' | 'save' | 'service' = 'service'): TopicUnavailable {
  return { code: 'TOPIC_SEARCH_HISTORY_UNAVAILABLE',
    message: step === 'service' ? 'Search history is unavailable. Search results and original files remain available.'
      : `Search history could not be ${step === 'read' ? 'read' : 'saved'}. Search results and original files remain available.`,
    recovery: 'Check the local history file and storage, then retry. Keep its existing bytes during repair; a missing record does not prove that a search never ran.',
    ...(source ? { source } : {}) }
}

/** Query observations only. Serial, bounded snapshots reuse the original durable writer. */
export class TopicSearchHistoryOwner {
  private tail: Promise<void> = Promise.resolve()
  constructor(private readonly path: string) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.tail.then(operation)
    this.tail = work.then(() => {}, () => {})
    return work
  }

  private async load(): Promise<Snapshot> {
    let handle
    try { handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schema: 'agentmux.topic-search-history.v1', records: [], prunedRecords: 0 }
      throw error
    }
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > TOPIC_SEARCH_HISTORY_MAX_BYTES) throw new AgentMuxError('Search history is not a bounded regular snapshot.', 'TOPIC_SEARCH_HISTORY_UNAVAILABLE')
      const bytes = Buffer.alloc(info.size)
      let readBytes = 0
      while (readBytes < bytes.length) {
        const read = await handle.read(bytes, readBytes, Math.min(65536, bytes.length - readBytes), readBytes)
        if (!read.bytesRead) throw new AgentMuxError('Search history changed while reading.', 'TOPIC_SEARCH_HISTORY_UNAVAILABLE')
        readBytes += read.bytesRead
      }
      const after = await handle.stat()
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new AgentMuxError('Search history changed while reading.', 'TOPIC_SEARCH_HISTORY_UNAVAILABLE')
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid history snapshot')
      const snapshot = value as Snapshot
      if (Object.keys(snapshot).length !== 3 || snapshot.schema !== 'agentmux.topic-search-history.v1'
        || !Number.isSafeInteger(snapshot.prunedRecords) || snapshot.prunedRecords < 0
        || !Array.isArray(snapshot.records) || snapshot.records.length > TOPIC_SEARCH_HISTORY_MAX_RECORDS) throw new Error('Invalid history snapshot')
      snapshot.records.forEach(parseTopicSearchRecord)
      if (new Set(snapshot.records.map(record => record.searchId)).size !== snapshot.records.length) throw new Error('Duplicate search identities')
      return snapshot
    } finally { await handle.close() }
  }

  async record(record: TopicSearchRecord): Promise<TopicSearchObservation> {
    const captured = structuredClone(parseTopicSearchRecord(record))
    return await this.serial(async () => {
      let step: 'read' | 'save' = 'read'
      try {
        // Always load the actual disk. A failed directory ACK may have replaced it;
        // cached acknowledged bytes must never overwrite that uncertain observation.
        const prior = await this.load()
        step = 'save'
        if (prior.records.some(item => item.searchId === captured.searchId)) throw new Error('Search identity already recorded')
        const next: Snapshot = { ...prior, records: [captured, ...prior.records] }
        let content = JSON.stringify(next) + '\n'
        while (next.records.length > TOPIC_SEARCH_HISTORY_MAX_RECORDS || Buffer.byteLength(content) > TOPIC_SEARCH_HISTORY_MAX_BYTES) {
          if (next.records.length <= 1) throw new Error('One search observation exceeds history retention')
          next.records.pop(); next.prunedRecords++
          if (!Number.isSafeInteger(next.prunedRecords)) throw new Error('History retention count is no longer representable')
          content = JSON.stringify(next) + '\n'
        }
        await durableWriteFile(this.path, content, { mode: 0o600, requireDirectorySync: true })
        return { record: captured, history: 'saved', unavailable: [] }
      } catch {
        // Error messages may contain file bytes (for example a JSON parse excerpt).
        return { record: captured, history: 'unavailable', unavailable: [searchHistoryUnavailable(this.path, step)] }
      }
    })
  }

  async read(params: TopicParams<'topic.knowledge.history'>): Promise<TopicSearchHistory> {
    const input = parseTopicParams('topic.knowledge.history', params)
    return await this.serial(async () => {
      const retention = { maxRecords: TOPIC_SEARCH_HISTORY_MAX_RECORDS, maxBytes: TOPIC_SEARCH_HISTORY_MAX_BYTES, prunedRecords: 0 }
      try {
        const snapshot = await this.load()
        const records = snapshot.records.filter(record => (input.topicId === undefined || record.topicId === input.topicId)
          && (input.query === undefined || record.query === input.query) && (input.searchId === undefined || record.searchId === input.searchId))
        const limit = input.limit ?? 32
        return { records: records.slice(0, limit), hasMore: records.length > limit,
          retention: { ...retention, prunedRecords: snapshot.prunedRecords }, unavailable: [] }
      } catch { return { records: [], hasMore: false, retention, unavailable: [searchHistoryUnavailable(this.path, 'read')] } }
    })
  }
}
