import { createRequire } from 'node:module'
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { durableWriteFile } from './durable-write.js'
import { defaultAgentMuxStateDirectory } from './runtime-paths.js'
import { AgentMuxError } from './errors.js'
import { parseConversationLandmark, parseConversationLandmarkOperation, parseConversationLandmarkQuery, parseConversationLandmarkWrite, sameLandmarkScope, conversationLandmarkScope,
  type ConversationLandmark, type ConversationLandmarkActor, type ConversationLandmarkOperation, type ConversationLandmarkPage, type ConversationLandmarkQuery, type ConversationLandmarkWrite } from './conversation-landmarks.js'

type Document = { schemaVersion: 1; revision: number; points: Record<string, ConversationLandmark>; operations: Record<string, ConversationLandmarkOperation> }
const empty = (): Document => ({ schemaVersion: 1, revision: 0, points: {}, operations: {} })
const requireNative = createRequire(import.meta.url)
const fail = (message: string, code: string): never => { throw new AgentMuxError(message + ' Original reading points, records and Agents are retained.', code) }
/** Durable navigation metadata only. Target reachability belongs to the original reader. */
export class ConversationLandmarkStore {
  constructor(readonly path = join(defaultAgentMuxStateDirectory(), 'conversation-landmarks.json')) {
    if (!isAbsolute(path)) fail('The metadata location must be absolute.', 'CONVERSATION_LANDMARK_INVALID')
  }
  private async read(): Promise<Document> {
    let raw: string
    try { raw = await readFile(this.path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try { await readFile(this.path + '.previous') } catch (previous) { if ((previous as NodeJS.ErrnoException).code === 'ENOENT') return empty(); throw previous }
      return fail('The current metadata document is missing; restore its retained original snapshot.', 'CONVERSATION_LANDMARK_READ_UNCONFIRMED')
    }
    try {
      const p = JSON.parse(raw) as Document
      if (!p || Object.keys(p).some(key => !['schemaVersion', 'revision', 'points', 'operations'].includes(key)) || p.schemaVersion !== 1 || !Number.isSafeInteger(p.revision) || p.revision < 0 ||
        !p.points || typeof p.points !== 'object' || Array.isArray(p.points) || !p.operations || typeof p.operations !== 'object' || Array.isArray(p.operations)) throw new Error('Invalid metadata document.')
      for (const [id, point] of Object.entries(p.points)) if (parseConversationLandmark(point).id !== id) throw new Error('Point identity changed.')
      for (const [id, operation] of Object.entries(p.operations)) if (parseConversationLandmarkOperation(operation).input.operationId !== id || operation.revision > p.revision) throw new Error('Operation identity changed.')
      return p
    } catch (error) { return fail('The metadata could not be read; restore this same document or retry after repairing storage.', 'CONVERSATION_LANDMARK_READ_UNCONFIRMED') }
  }
  private page(document: Document, query: ConversationLandmarkQuery): ConversationLandmarkPage {
    const operation = query.operationId === undefined ? undefined : Object.hasOwn(document.operations, query.operationId) ? document.operations[query.operationId] : undefined
    return { hostId: query.hostId, agentSessionId: query.agentSessionId, revision: document.revision,
      points: Object.values(document.points).filter(point => sameLandmarkScope(conversationLandmarkScope(point), query)),
      recordedOperation: operation && sameLandmarkScope(operation.input, query) ? operation : null }
  }
  async list(input: ConversationLandmarkQuery): Promise<ConversationLandmarkPage> { return this.page(await this.read(), parseConversationLandmarkQuery(input)) }
  async apply(input: ConversationLandmarkWrite, actor: ConversationLandmarkActor): Promise<ConversationLandmarkPage> {
    const original = parseConversationLandmarkWrite(input)
    // Validate transport attribution before touching the metadata owner.
    parseConversationLandmarkOperation({ input: original, actor, revision: original.expectedRevision + 1 })
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const lock = await open(this.path + '.lock', 'a+', 0o600)
    try {
      const native = requireNative('fs-native-extensions') as { tryLock(fd: number): boolean }, deadline = Date.now() + 5000
      while (!native.tryLock(lock.fd)) {
        if (Date.now() >= deadline) fail('The metadata writer is busy; retry the same original operation.', 'CONVERSATION_LANDMARK_BUSY')
        await delay(10)
      }
      const current = await this.read(), recorded = Object.hasOwn(current.operations, original.operationId) ? current.operations[original.operationId] : undefined
      if (recorded) {
        if (!isDeepStrictEqual(recorded.input, original) || !isDeepStrictEqual(recorded.actor, actor)) fail('That operation identity already belongs to a different metadata intent.', 'CONVERSATION_LANDMARK_OPERATION_CONFLICT')
        // A prior replacement may have lost its directory ACK. Confirm the same bytes durably.
        await durableWriteFile(this.path, JSON.stringify(current) + '\n', { requireDirectorySync: true })
        return this.page(current, original)
      }
      if (original.expectedRevision !== current.revision) fail('The reading points changed; refresh the list before creating a new operation.', 'CONVERSATION_LANDMARK_CONFLICT')
      const next = structuredClone(current), change = original.change
      if (change.kind === 'create') {
        if (Object.hasOwn(next.points, change.point.id)) fail('The point identity already exists; inspect its original operation.', 'CONVERSATION_LANDMARK_CONFLICT')
        Object.defineProperty(next.points, change.point.id, { value: change.point, enumerable: true, writable: true, configurable: true })
      } else {
        const point = Object.hasOwn(next.points, change.id) ? next.points[change.id] : undefined
        if (!point || !sameLandmarkScope(conversationLandmarkScope(point), original)) return fail('The requested point is not in this exact conversation.', 'CONVERSATION_LANDMARK_NOT_FOUND')
        if (change.kind === 'rename') point.name = change.name
        else delete next.points[change.id]
      }
      next.revision++
      Object.defineProperty(next.operations, original.operationId, { value: { input: original, actor, revision: next.revision }, enumerable: true, writable: true, configurable: true })
      await durableWriteFile(this.path + '.previous', JSON.stringify(current) + '\n', { requireDirectorySync: true })
      await durableWriteFile(this.path, JSON.stringify(next) + '\n', { requireDirectorySync: true })
      return this.page(next, original)
    } finally { await lock.close() }
  }
}
