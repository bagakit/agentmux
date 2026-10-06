import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import parser from 'stream-json/parser.js'
import type { Token } from 'stream-json/parser.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { projectSessionUserMessages, sessionHistoryTextForReading } from './session-user-messages.js'
import type { AgentSessionHistoryReadInput, AgentSessionHistoryReadPage, AgentSessionHistoryReader, AgentSessionHistoryReadContext } from './session-history-reader.js'
import type { AgentSessionHistoryDescriptor, AgentSessionHistoryPage, AgentSessionHistoryItem, AgentTimelineItem, AgentSessionUserMessage, AgentSessionHistorySource } from './types.js'

type Reader = Pick<AgentSessionHistoryReader, 'sessionHistorySources' | 'sessionTimeline' | 'sessionHistoryPage'> & Partial<Pick<AgentSessionHistoryReader, 'sessionHistoryResource'>>
type Position = { page: string | null; index: number }
type Cursor = Position & { version: 1; readId: string; scope: string }
type View = { id: string; scope: string; binding: string; revision: string; touchedAt: number;
  captured?: readonly AgentTimelineItem[]; firstNative?: AgentSessionHistoryPage; nativeSource?: AgentSessionHistorySource; bytes: number }
// Read snapshots only: no author/input/delivery state. An original continuation remains
// append-safe without repeatedly loading/cloning/hashing the entire captured Timeline.
// The weak owner and short idle lifetime release these with their actual reader.
const views = new WeakMap<Reader, Map<string, View>>()
const idleMs = 5 * 60_000, maxViews = 16, retainedBytes = 64 * 1024 * 1024
const key = randomBytes(32)
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const fail = (message: string, code = 'AGENT_SESSION_HISTORY_SOURCE_CHANGED'): never => { throw new AgentMuxError(message, code) }
const scopeOf = (input: AgentSessionHistoryReadInput) => digest(JSON.stringify([input.hostId, input.agentSessionId, input.source, input.query ?? '']))
const bindingOf = (descriptor: AgentSessionHistoryDescriptor, source: AgentSessionHistoryReadInput['source']) => {
  const history = descriptor.history, handle = history?.nativeHandle
  return digest(JSON.stringify([descriptor.hostId, descriptor.agentSessionId, source === 'native' ? [history?.providerId, history?.executorId, history?.workspacePath,
    handle?.kind, handle?.sessionId, handle?.kind === 'provider' ? handle.transcriptPath : undefined] : null]))
}
const sameSource = (a: AgentSessionHistorySource, b: AgentSessionHistorySource) => a.providerId === b.providerId && a.nativeSessionId === b.nativeSessionId
function encode(cursor: Cursor): string {
  const body = Buffer.from(JSON.stringify(cursor)).toString('base64url')
  return body + '.' + createHmac('sha256', key).update(body).digest('base64url')
}
function decode(value: string, scope: string): Cursor {
  try {
    const [body, mac, extra] = value.split('.')
    if (!body || !mac || extra) throw new Error('cursor')
    const supplied = Buffer.from(mac, 'base64url'), expected = createHmac('sha256', key).update(body).digest()
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('signature')
    const cursor = rpcRecord(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')), ['version', 'readId', 'scope', 'page', 'index']) as Cursor
    if (cursor.version !== 1 || cursor.scope !== scope || typeof cursor.readId !== 'string' ||
      !(cursor.page === null || typeof cursor.page === 'string' && cursor.page.length > 0) || !Number.isSafeInteger(cursor.index) || cursor.index < 0) throw new Error('scope')
    return cursor
  } catch { return fail('This query continuation changed, expired or belongs to another Host, Agent or query. Read its first page again.') }
}
function ownerViews(owner: Reader): Map<string, View> {
  let entries = views.get(owner)
  if (!entries) { entries = new Map(); views.set(owner, entries) }
  const now = Date.now()
  for (const [id, view] of entries) if (now - view.touchedAt > idleMs) entries.delete(id)
  return entries
}
function retain(entries: Map<string, View>, view: View): void {
  entries.delete(view.id); entries.set(view.id, view)
  let total = [...entries.values()].reduce((sum, item) => sum + item.bytes, 0)
  // Eviction ends only a read lease, never a Session capability. Retain the newest
  // snapshot even if the original owner's one bounded Timeline exceeds the cache budget.
  for (const [id, old] of entries) {
    if (entries.size <= maxViews && total <= retainedBytes || id === view.id) break
    entries.delete(id); total -= old.bytes
  }
}
async function descriptorFor(owner: Reader, input: AgentSessionHistoryReadInput, options: AgentSessionHistoryReadContext): Promise<AgentSessionHistoryDescriptor> {
  const descriptor = options.resolveSource ? await options.resolveSource(input.agentSessionId)
    : (await owner.sessionHistorySources()).find(item => item.hostId === input.hostId && item.agentSessionId === input.agentSessionId)
  return descriptor && descriptor.hostId === input.hostId && descriptor.agentSessionId === input.agentSessionId ? descriptor
    : fail('No exact retained Session exists at the requested Host.', 'UNKNOWN_AGENT_SESSION')
}
async function nativePage(owner: Reader, input: AgentSessionHistoryReadInput, cursor: string | null, signal?: AbortSignal): Promise<AgentSessionHistoryPage> {
  const page = await owner.sessionHistoryPage(input.agentSessionId, { limit: 100, ...(cursor ? { cursor } : {}), ...(signal ? { signal } : {}) })
  signal?.throwIfAborted()
  if (page.agentSessionId !== input.agentSessionId) return fail('Native history belongs to another Agent.', 'CONTROL_PROTOCOL_ERROR')
  return page
}

/** Stream one original serialized text part. Never materialize a large resource
 * as a second string or search its title/preview. The original receipt/hash
 * owner qualifies every byte; matching state is bounded by the literal query. */
type LiteralMatcher = { query: string; tail: string; matched: boolean }
function feed(matcher: LiteralMatcher, chunk: string): void {
  const text = matcher.tail + chunk
  matcher.matched ||= text.includes(matcher.query)
  matcher.tail = matcher.query.length > 1 ? text.slice(-(matcher.query.length - 1)) : ''
}

async function streamResourceText(owner: Reader, input: AgentSessionHistoryReadInput, message: AgentSessionUserMessage,
  partIndex: number, matcher: LiteralMatcher, signal?: AbortSignal, span?: { start: number; end: number }): Promise<{ span?: { start: number; end: number }; length: number }> {
  const part = message.contentParts[partIndex]!
  if (part.kind !== 'resource' || part.resourceType !== 'text' || part.content?.kind !== 'text' || !owner.sessionHistoryResource || message.source.kind !== 'native')
    return fail('The original text resource reader is unavailable; this query has not skipped its record.', 'AGENT_SESSION_HISTORY_RESOURCE_UNAVAILABLE')
  const source = { providerId: message.source.providerId, nativeSessionId: message.source.nativeSessionId }
  const stream = parser.asStream({ packKeys: true, streamKeys: false, packStrings: false, packNumbers: true, streamStrings: true, streamNumbers: false })
  let textValue = false, textSeen = false, textLength = 0, depth = 0, topKey = '', rangeKey = '', inRange = false, rangePresent = false, streamError: unknown
  let rangeStart: number | undefined, rangeEnd: number | undefined
  const hash = createHash('sha256'), decoder = new TextDecoder('utf-8', { fatal: true })
  stream.on('data', (token: Token) => {
    if (token.name === 'startObject' || token.name === 'startArray') {
      if (depth === 1 && topKey === 'readingRange') { inRange = true; rangePresent = true }
      depth++
    }
    if (token.name === 'keyValue') {
      if (depth === 1) topKey = token.value
      else if (depth === 2 && inRange) rangeKey = token.value
    }
    if (token.name === 'startString') { textValue = depth === 1 && topKey === 'text'; textSeen ||= textValue }
    if (token.name === 'stringChunk' && textValue) {
      const chunk = token.value, start = textLength
      textLength += chunk.length
      if (span) feed(matcher, chunk.slice(Math.max(0, span.start - start), Math.max(0, Math.min(chunk.length, span.end - start))))
      else feed(matcher, chunk)
    }
    if (token.name === 'endString') textValue = false
    if (token.name === 'numberValue' && depth === 2 && inRange) {
      if (rangeKey === 'start') rangeStart = Number(token.value)
      if (rangeKey === 'end') rangeEnd = Number(token.value)
    }
    if (token.name === 'endObject' || token.name === 'endArray') { if (depth === 2) inRange = false; depth-- }
  })
  stream.on('error', error => { streamError = error })
  let offsetBytes = 0, expectedReference = part.reference
  try {
    do {
      signal?.throwIfAborted()
      const receipt = await owner.sessionHistoryResource(input.agentSessionId, { source, recordId: message.source.recordId,
        ...(message.turnId ? { turnId: message.turnId } : {}), partIndex, expectedReference, offsetBytes, maxBytes: 128 * 1024, ...(signal ? { signal } : {}) })
      signal?.throwIfAborted()
      const bytes = receipt.result
      if (receipt.agentSessionId !== input.agentSessionId || !sameSource(receipt.source, source) || receipt.recordId !== message.source.recordId ||
        receipt.turnId !== message.turnId || receipt.partIndex !== partIndex || receipt.reference !== expectedReference || bytes.status !== 'fragment' ||
        bytes.encoding !== 'json-utf8' || bytes.offsetBytes !== offsetBytes || bytes.totalBytes !== part.content.byteLength || bytes.sha256 !== part.content.sha256 ||
        bytes.byteLength < 1 || bytes.byteLength > 128 * 1024) return fail('Original text query bytes changed.', 'CONTROL_PROTOCOL_ERROR')
      const data = Buffer.from(bytes.dataBase64, 'base64')
      if (data.length !== bytes.byteLength || data.toString('base64') !== bytes.dataBase64 || offsetBytes + data.length > part.content.byteLength ||
        bytes.nextOffsetBytes !== (offsetBytes + data.length === part.content.byteLength ? null : offsetBytes + data.length)) return fail('Original text query fragment is incomplete.', 'CONTROL_PROTOCOL_ERROR')
      hash.update(data)
      await new Promise<void>((resolve, reject) => stream.write(decoder.decode(data, { stream: true }), error => error ? reject(error) : resolve()))
      if (streamError) throw streamError
      offsetBytes += data.length
      if (bytes.continuationReference !== undefined) {
        if (typeof bytes.continuationReference !== 'string' || !bytes.continuationReference || /[\0\r\n]/u.test(bytes.continuationReference)) return fail('Original text continuation is invalid.', 'CONTROL_PROTOCOL_ERROR')
        expectedReference = bytes.continuationReference
      }
    } while (offsetBytes < part.content.byteLength)
    await new Promise<void>((resolve, reject) => { stream.once('finish', resolve); stream.once('error', reject); stream.end(decoder.decode()) })
    if (streamError) throw streamError
    if (hash.digest('hex') !== part.content.sha256) return fail('Original queried text changed.')
    if (!textSeen || rangePresent && (!Number.isSafeInteger(rangeStart) || !Number.isSafeInteger(rangeEnd) || rangeStart! < 0 || rangeEnd! < rangeStart! || rangeEnd! > textLength))
      return fail('Original queried text has an invalid semantic reading span.', 'CONTROL_PROTOCOL_ERROR')
    return { length: textLength, ...(rangePresent ? { span: { start: rangeStart!, end: rangeEnd! } } : {}) }
  } finally { stream.destroy() }
}
async function matches(owner: Reader, input: AgentSessionHistoryReadInput, message: AgentSessionUserMessage, signal?: AbortSignal): Promise<boolean> {
  const query = input.query ?? ''
  if (!query) return true
  const matcher: LiteralMatcher = { query, tail: '', matched: false }
  const answerText = message.questionAnswers?.length ? message.questionAnswers.map(answer => answer.answer).join('\n\n') : undefined
  let parts = 0, answerPlaced = false
  // The same text domain as sessionUserMessageText after complete resource reads:
  // reading spans, first-text answer replacement, and one newline between parts.
  for (let index = 0; index < message.contentParts.length; index++) {
    const part = message.contentParts[index]!
    if (part.kind !== 'text' && !(part.kind === 'resource' && part.resourceType === 'text' && part.content?.kind === 'text')) continue
    if (parts++) feed(matcher, '\n')
    if (answerText !== undefined && !answerPlaced) { feed(matcher, answerText); answerPlaced = true }
    else if (part.kind === 'text') feed(matcher, sessionHistoryTextForReading(part))
    else {
      const before = { ...matcher }
      const original = await streamResourceText(owner, input, message, index, matcher, signal)
      // readingRange can follow text in the original serialized part. A second
      // bounded pass applies that exact span; the usual unwrapped part needs one.
      if (original.span && (original.span.start !== 0 || original.span.end !== original.length)) {
        Object.assign(matcher, before)
        await streamResourceText(owner, input, message, index, matcher, signal, original.span)
      }
    }
    if (matcher.matched) return true
  }
  if (answerText !== undefined && !answerPlaced) feed(matcher, answerText)
  return matcher.matched
}

export async function readAgentUserMessageHistory(owner: Reader, input: AgentSessionHistoryReadInput, options: AgentSessionHistoryReadContext): Promise<AgentSessionHistoryReadPage> {
  const { signal } = options
  const entries = ownerViews(owner), scope = scopeOf(input), original = input.cursor ? decode(input.cursor, scope) : null
  let descriptor = await descriptorFor(owner, input, options)
  signal?.throwIfAborted()
  let view = original ? entries.get(original.readId) : undefined
  if (original && (!view || view.scope !== scope || view.binding !== bindingOf(descriptor, input.source))) return fail('The original query window expired or its retained source changed. Read the first page again.')
  if (!view) {
    const id = randomUUID()
    if (input.source === 'captured') {
      const snapshot = await owner.sessionTimeline(input.agentSessionId)
      signal?.throwIfAborted()
      if (snapshot.agentSessionId !== input.agentSessionId || snapshot.items.some(item => item.agentSessionId !== input.agentSessionId)) return fail('Captured history belongs to another Agent.', 'CONTROL_PROTOCOL_ERROR')
      const serialized = JSON.stringify(snapshot)
      view = { id, scope, binding: bindingOf(descriptor, input.source), revision: digest(serialized), touchedAt: Date.now(),
        captured: [...snapshot.items].reverse(), bytes: Buffer.byteLength(serialized) }
    } else {
      const firstNative = await nativePage(owner, input, null, signal)
      descriptor = await descriptorFor(owner, input, options)
      if (descriptor.history?.providerId !== firstNative.source.providerId || descriptor.history.nativeHandle &&
        descriptor.history.nativeHandle.sessionId !== firstNative.source.nativeSessionId) return fail('Native query source belongs to another conversation.', 'CONTROL_PROTOCOL_ERROR')
      const serialized = JSON.stringify(firstNative)
      view = { id, scope, binding: bindingOf(descriptor, input.source), revision: digest(serialized), touchedAt: Date.now(),
        firstNative, nativeSource: firstNative.source, bytes: Buffer.byteLength(serialized) }
    }
    retain(entries, view)
  }
  view.touchedAt = Date.now(); retain(entries, view)
  const position: Position = { page: original?.page ?? null, index: original?.index ?? 0 }
  const limit = input.limit ?? 30, scanLimit = input.scanLimit ?? 200, budgetBytes = input.maxBytes ?? 1024 * 1024
  const result: AgentSessionHistoryReadPage = { hostId: input.hostId, agentSessionId: input.agentSessionId, source: input.source,
    kind: 'user-message', revision: view.revision, availability: 'empty', order: 'newest-first', items: [], userMessages: [],
    scan: { examined: 0, complete: false }, nextCursor: null, budgetBytes, ...(view.nativeSource ? { nativeSource: view.nativeSource } : {}) }
  const cursor = () => encode({ version: 1, readId: view!.id, scope, ...position })
  let page = view.firstNative && (position.page === null ? view.firstNative : await nativePage(owner, input, position.page, signal))
  if (page && view.nativeSource && !sameSource(page.source, view.nativeSource)) return fail('Native query source changed.')
  let items: readonly (AgentTimelineItem | AgentSessionHistoryItem)[] = view.captured ?? [...page!.items].reverse()
  while (true) {
    signal?.throwIfAborted()
    if (position.index > items.length) return fail('Query cursor exceeds its original page.')
    if (position.index === items.length) {
      if (!page || page.nextCursor === null) { result.scan!.complete = true; break }
      if (page.nextCursor === position.page) return fail('The original native query cursor did not advance.', 'CONTROL_PROTOCOL_ERROR')
      position.page = page.nextCursor; position.index = 0
      if (result.scan!.examined >= scanLimit || result.userMessages!.length >= limit) break
      page = await nativePage(owner, input, position.page, signal)
      if (!sameSource(page.source, view.nativeSource!)) return fail('Native query source changed.')
      items = [...page.items].reverse()
      continue
    }
    if (result.scan!.examined >= scanLimit || result.userMessages!.length >= limit) break
    const item = items[position.index]!
    const messages = input.source === 'captured'
      ? projectSessionUserMessages({ agentSessionId: input.agentSessionId, timeline: { agentSessionId: input.agentSessionId, revision: 0, items: [item as AgentTimelineItem] } })
      : projectSessionUserMessages({ agentSessionId: input.agentSessionId, historyPage: { agentSessionId: input.agentSessionId, source: view.nativeSource!, items: [item as AgentSessionHistoryItem], nextCursor: null } })
    const message = messages[0]
    if (message && await matches(owner, input, message, signal)) {
      const serializedBytes = Buffer.byteLength(JSON.stringify({ ...result, availability: 'available', userMessages: [...result.userMessages!, message], nextCursor: cursor() }))
      if (serializedBytes > budgetBytes - 1024) {
        if (!result.userMessages!.length) {
          let requiredBytes = serializedBytes + 1024
          for (;;) {
            const exact = Buffer.byteLength(JSON.stringify({ ...result, budgetBytes: requiredBytes, availability: 'available', userMessages: [message], nextCursor: cursor() })) + 1024
            if (exact === requiredBytes) break
            requiredBytes = exact
          }
          throw new AgentMuxError('This original user record exceeds the requested result budget. The source and query were not skipped.',
            'AGENT_SESSION_HISTORY_BUDGET', JSON.stringify({ phase: 'query-result', requiredBytes, maxBytes: 16 * 1024 * 1024, cursor: cursor() }))
        }
        break
      }
      result.userMessages!.push(message)
      result.availability = 'available'
    }
    position.index++; result.scan!.examined++
  }
  if (!result.scan!.complete) result.nextCursor = cursor()
  return result
}
