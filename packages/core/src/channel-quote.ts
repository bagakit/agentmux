import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseConnectionActor, parseConnectionApplication } from './room-binding-codec.js'
import type { ConnectionActor, ConnectionApplication } from './connections-contract.js'
import { channelActorKey, parseChannelActorProfileObservation, type ChannelActorProfileObservation } from './channel-profile.js'

/** Original native observations. None of these declarations carries an input grant. */
export type ChannelQuoteAuthor = { kind: 'user' | 'bot'; actor: ConnectionActor; profile?: ChannelActorProfileObservation } | { kind: 'unknown' }
export type ChannelQuoteResource = {
  resourceId: string; kind: 'file' | 'image' | 'audio' | 'video' | 'other'
  name?: string; mediaType?: string; sizeBytes?: number; url?: string
}
export type ChannelQuoteRecord = {
  messageId: string; contentType: string; content: string; author: ChannelQuoteAuthor
  createdAt?: number; updatedAt?: number; revision?: string
  replyToMessageId?: string; threadId?: string; resources?: ChannelQuoteResource[]
}
export type ChannelQuoteRange = {
  from: { messageId: string; inclusive: boolean } | null
  /** Exclusive current request. Its body is never repeated in records. */
  throughMessageId: string
  origin: 'first-observed' | 'admitted-input'
}
export type ChannelQuoteGap = { reason: string; fromMessageId?: string; throughMessageId?: string }
/** Complete means this bounded range as visible to the native API at observedAt,
 * not deleted content, earlier revisions or history before a first baseline. */
export type ChannelTranscriptQuote = {
  version: 1; application: ConnectionApplication; externalConversationId: string; observedAt: number
  range: ChannelQuoteRange; coverage: 'complete' | 'partial' | 'unavailable'
  gaps: ChannelQuoteGap[]; records: ChannelQuoteRecord[]
}

const code = 'INVALID_CHANNEL_QUOTE'
const fail = (): never => { throw new AgentMuxError('The original channel transcript quote is invalid.', code) }
const object = (value: unknown, fields: readonly string[]) => rpcRecord(value, fields, code)
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(value)) fail()
  return value as string
}
const time = (value: unknown): number => { if (!Number.isSafeInteger(value) || Number(value) < 0) fail(); return value as number }
const sameApplication = (left: ConnectionApplication, right: ConnectionApplication) => left.domain === right.domain && left.appId === right.appId

export function parseChannelTranscriptQuote(value: unknown): ChannelTranscriptQuote {
  const p = object(value, ['version', 'application', 'externalConversationId', 'observedAt', 'range', 'coverage', 'gaps', 'records'])
  const application = parseConnectionApplication(p.application), r = object(p.range, ['from', 'throughMessageId', 'origin'])
  if (p.version !== 1 || !['first-observed', 'admitted-input'].includes(String(r.origin)) ||
      !['complete', 'partial', 'unavailable'].includes(String(p.coverage)) || !Array.isArray(p.gaps) || !Array.isArray(p.records)) fail()
  let from: ChannelQuoteRange['from'] = null
  if (r.from !== null) {
    const f = object(r.from, ['messageId', 'inclusive'])
    if (typeof f.inclusive !== 'boolean') fail()
    from = { messageId: id(f.messageId), inclusive: f.inclusive as boolean }
  }
  if (r.origin === 'admitted-input' && (!from || from.inclusive)) fail()
  const throughMessageId = id(r.throughMessageId)
  const gaps = (p.gaps as unknown[]).map(value => {
    const g = object(value, ['reason', 'fromMessageId', 'throughMessageId']), reason = id(g.reason)
    if (!/^[a-z][a-z0-9-]{0,95}$/u.test(reason)) fail()
    return { reason, ...(g.fromMessageId === undefined ? {} : { fromMessageId: id(g.fromMessageId) }),
      ...(g.throughMessageId === undefined ? {} : { throughMessageId: id(g.throughMessageId) }) }
  })
  if (p.coverage === 'complete' ? !from || gaps.length !== 0 : gaps.length === 0) fail()
  const ids = new Set<string>()
  const records = (p.records as unknown[]).map(value => {
    const m = object(value, ['messageId', 'contentType', 'content', 'author', 'createdAt', 'updatedAt', 'revision', 'replyToMessageId', 'threadId', 'resources'])
    const messageId = id(m.messageId), a = object(m.author, ['kind', 'actor', 'profile'])
    if (typeof m.content !== 'string' || ids.has(messageId) || messageId === throughMessageId || from && !from.inclusive && messageId === from.messageId) fail()
    ids.add(messageId)
    let author: ChannelQuoteAuthor
    if (a.kind === 'unknown') {
      if (a.actor !== undefined || a.profile !== undefined) fail()
      author = { kind: 'unknown' }
    } else {
      if (a.kind !== 'user' && a.kind !== 'bot') fail()
      const actor = parseConnectionActor(a.actor), profile = a.profile === undefined ? undefined : parseChannelActorProfileObservation(a.profile)
      if (!sameApplication(actor.application, application) || profile && channelActorKey(profile.actor) !== channelActorKey(actor)) fail()
      author = { kind: a.kind as 'user' | 'bot', actor, ...(profile ? { profile } : {}) }
    }
    let resources: ChannelQuoteResource[] | undefined
    if (m.resources !== undefined) {
      if (!Array.isArray(m.resources)) fail()
      const seen = new Set<string>()
      resources = (m.resources as unknown[]).map(value => {
        const r = object(value, ['resourceId', 'kind', 'name', 'mediaType', 'sizeBytes', 'url']), resourceId = id(r.resourceId)
        if (!['file', 'image', 'audio', 'video', 'other'].includes(String(r.kind)) || seen.has(resourceId)) fail()
        seen.add(resourceId)
        return { resourceId, kind: r.kind as ChannelQuoteResource['kind'], ...(r.name === undefined ? {} : { name: id(r.name) }),
          ...(r.mediaType === undefined ? {} : { mediaType: id(r.mediaType) }), ...(r.sizeBytes === undefined ? {} : { sizeBytes: time(r.sizeBytes) }),
          ...(r.url === undefined ? {} : { url: id(r.url) }) }
      })
    }
    return { messageId, contentType: id(m.contentType), content: m.content as string, author,
      ...(m.createdAt === undefined ? {} : { createdAt: time(m.createdAt) }), ...(m.updatedAt === undefined ? {} : { updatedAt: time(m.updatedAt) }),
      ...(m.revision === undefined ? {} : { revision: id(m.revision) }), ...(m.replyToMessageId === undefined ? {} : { replyToMessageId: id(m.replyToMessageId) }),
      ...(m.threadId === undefined ? {} : { threadId: id(m.threadId) }), ...(resources === undefined ? {} : { resources }) }
  })
  return { version: 1, application, externalConversationId: id(p.externalConversationId), observedAt: time(p.observedAt),
    range: { from, throughMessageId, origin: r.origin as ChannelQuoteRange['origin'] }, coverage: p.coverage as ChannelTranscriptQuote['coverage'], gaps, records }
}

/** One deterministic JSON line. Source content cannot introduce markup boundaries. */
export function channelTranscriptQuoteJson(value: ChannelTranscriptQuote): string {
  return JSON.stringify(parseChannelTranscriptQuote(value)).replace(/[<>&]/gu, char => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' })[char]!)
}
