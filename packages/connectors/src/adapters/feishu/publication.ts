import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import type { ConnectionApplication } from '@agentmux/core/connections'
import type { PublicationImage, PublicationFile } from '../../publication-resource.js'
import type { PublicationAdapter } from '../../publication-adapter.js'
import type { PublicationMapping, PublicationOperation, PublicationReceipt, PublicationTarget, PublicationPayload, PublicationTextFragment } from '../../publication-store.js'
import { parsePreparedPublication, publicationSpeechText, type PreparedPublication } from '../../publication-wire.js'
import type { FeishuAdapter } from './index.js'
import { feishuFailure, feishuIdentity, FEISHU_MESSAGE_BODY_BYTES } from './message.js'
import { feishuQuestionCard } from './question-card.js'
import { fragmentFeishuReply } from './reply-card.js'
import { feishuRoleCard, type FeishuRoleSpeaker } from './role-card.js'
import { feishuReplyFooterBudget } from './reply-footer.js'
import type { PublicationSpeaker } from '../../publication-speaker.js'
import type { PublicationCardAdapter } from '../../publication-card.js'
import { feishuQueryReaction, readFeishuQueryReaction, feishuReactionMapping, feishuReactionReceipt } from './reaction.js'

const path = '/open-apis/im/v1/messages'
const currentCardRenderVersion = 'feishu-conversation-v12'
// Retained frozen cards use their original wire; this never prepares or replays an older effect.
const nativeCardRenderVersions = ['feishu-group-v2', 'feishu-conversation-v3', 'feishu-conversation-v4', 'feishu-conversation-v5', 'feishu-conversation-v6', 'feishu-conversation-v7', 'feishu-conversation-v8', 'feishu-conversation-v9', 'feishu-conversation-v10', 'feishu-conversation-v11', currentCardRenderVersion]
const cardsPath = '/open-apis/cardkit/v1/cards'
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const unknown = (): PublicationReceipt => ({ state: 'unknown', reason: 'effect-unconfirmed' })
const key = (operationId: string) => createHash('sha256').update(operationId).digest('base64url')
function inputStatus(payload: Extract<PublicationPayload, { kind: 'speech' }>): string | undefined {
  const input = payload.inputSubmission
  return input ? ({ waiting: 'Saved · waiting for Agent', stopped: 'Saved · delivery stopped', 'terminal-confirmed': 'Sent to Agent · acceptance not confirmed',
    admitted: 'Accepted by Agent', 'not-applied': 'Not delivered to Agent', unknown: 'Saved · delivery to Agent unconfirmed' }[input.status])
    + (input.observation === 'rejoin-needed' ? '\nReconnect this input in AgentMux' : '') : undefined
}
function speechCard(payload: Extract<PublicationPayload, { kind: 'speech' }>, speaker: FeishuRoleSpeaker,
  originalMessage?: PublicationOperation['originalMessage'], fragment?: PublicationOperation['fragment']): Record<string, unknown> {
  const status = inputStatus(payload)
  return feishuRoleCard(publicationSpeechText({ ...payload, text: (payload.presentationContext?.before ?? '') + payload.text + (payload.presentationContext?.after ?? '') }), speaker,
    { ...(payload.phase ? { phase: payload.phase } : {}), ...(fragment ? { fragment } : {}),
      ...(payload.presentationContext?.literal ? { literal: true } : {}), incoming: originalMessage !== undefined, ...(status ? { status } : {}),
      ...(payload.replyMetadata ? { replyMetadata: payload.replyMetadata } : {}) })
}
function identityElementId(operation: Readonly<PublicationOperation>): string {
  const speaker = operation.speaker, avatar = speaker?.avatar
  return 'author_' + createHash('sha256').update(JSON.stringify([speaker?.kind, speaker?.reference, speaker?.mote, avatar?.input, avatar?.target, avatar?.revision])).digest('hex').slice(0, 13)
}
function roleSpeaker(operation: Readonly<PublicationOperation>, identity = false): FeishuRoleSpeaker {
  const snapshot = operation.speaker ?? { kind: 'unknown' as const }, uploaded = operation.avatarUploads?.at(-1)
  return { kind: snapshot.kind, ...(snapshot.name ? { name: snapshot.name } : {}), ...(identity ? { elementId: identityElementId(operation) } : {}),
    ...(operation.avatarSource?.imageKey ? { imageKey: feishuIdentity(operation.avatarSource.imageKey) }
      : uploaded?.state === 'confirmed' ? { imageKey: feishuIdentity(uploaded.imageKey) } : {}) }
}
function ownSender(value: unknown, application: ConnectionApplication): boolean {
  const sender = object(value)
  return sender?.sender_type === 'app' && sender.id_type === 'app_id' && sender.id === application.appId
}
function requestCard(prepared: PreparedPublication): Record<string, unknown> | null {
  try {
    const body = object(JSON.parse(prepared.request.body!)), envelope = object(body?.card)
    const source = envelope?.type === 'card_json' ? envelope.data : body?.type === 'card_json' ? body.data : body?.content
    const card = typeof source === 'string' ? object(JSON.parse(source)) : null
    if (!card || object(card.config)?.update_multi !== true) return null
    if (card.schema === '2.0') return (card.header === undefined || object(object(card.header)?.title)?.tag === 'plain_text') && Array.isArray(object(card.body)?.elements) ? card : null
    if (object(object(card.header)?.title)?.tag !== 'plain_text' || !Array.isArray(card.elements)) return null
    for (const element of card.elements) {
      const value = object(element)
      if (value?.tag === 'div') { if (object(value.text)?.tag !== 'plain_text' || typeof object(value.text)?.content !== 'string') return null }
      else if (value?.tag === 'img') { if (typeof value.img_key !== 'string' || object(value.alt)?.tag !== 'plain_text') return null }
      else if (value?.tag === 'action' && Array.isArray(value.actions) && value.actions.length === 1) {
        const button = object(value.actions[0]), text = object(button?.text), ref = object(button?.value)
        if (button?.tag !== 'button' || text?.tag !== 'plain_text' || typeof text.content !== 'string') return null
        if (typeof button.url === 'string' && button.value === undefined) {
          const link = new URL(button.url), sessionId = decodeURIComponent(link.pathname.slice(1))
          if (button.url !== `amux://agent/${encodeURIComponent(feishuIdentity(sessionId))}`) return null
        } else {
          if (button.url !== undefined || !ref || Object.keys(ref).length !== 1) return null
          feishuIdentity(ref.actionRef)
        }
      } else return null
    }
    return card
  } catch { return null }
}
function requestEntity(prepared: PreparedPublication): string | null {
  try {
    const body = object(JSON.parse(prepared.request.body!)), card = typeof body?.content === 'string' ? object(JSON.parse(body.content)) : null
    const id = object(card?.data)?.card_id
    return card?.type === 'card' && typeof id === 'string' && id.length <= 20 ? feishuIdentity(id) : null
  } catch { return null }
}
function identityElement(value: unknown, id: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  if (object(value)?.element_id === id) return object(value)
  for (const child of Object.values(value)) { const found = identityElement(child, id); if (found) return found }
  return null
}
function nativeSequence(body: Record<string, unknown> | null, prepared: PreparedPublication): boolean {
  return !!body && Number.isSafeInteger(body.sequence) && Number(body.sequence) >= 1 && Number(body.sequence) <= 2_147_483_647 && body.uuid === key(prepared.requestKey)
}
function nativeFailure(status: number | undefined, code: unknown): Exclude<PublicationReceipt, { state: 'confirmed' }> | null {
  if (status !== undefined && status >= 500) return { state: 'unknown', reason: 'platform-unavailable' }
  if ([10002, 200740, 200750, 200770, 200810, 200860, 300301, 300302, 200220, 300305, 300307, 300311, 300317, 300121].includes(Number(code))) return { state: 'not-applied', reason: 'platform-rejected' }
  return failure(status, code) as Exclude<PublicationReceipt, { state: 'confirmed' }> | null
}
/** Feed preview only. Visible card text supplies the excerpt; no action values or private references. */
function cardSummary(card: Record<string, unknown>, operation: Pick<PublicationOperation, 'payload' | 'presentationTime' | 'speaker' | 'originalMessage'>): string {
  const at = operation.presentationTime, date = at === undefined || !Number.isFinite(at) || Math.abs(at) > 8.64e15 ? null : new Date(at)
  const time = date ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` : undefined
  const title = object(object(card.header)?.title)?.content
  const purpose = operation.payload.kind === 'speech' && operation.originalMessage ? 'Agent · Incoming' : operation.payload.kind === 'speech'
    ? [{ agent: 'Agent', human: 'User', external: 'External message', mixed: 'Mixed authors', unknown: 'Unknown author' }[operation.speaker?.kind ?? 'unknown'],
      operation.payload.phase === 'final' ? 'Reply' : operation.payload.phase === 'progress' ? 'Progress' : undefined].filter(Boolean).join(' · ')
    : operation.payload.kind === 'question' ? 'Question' : operation.payload.kind === 'permission' ? 'Permission' : typeof title === 'string' ? title : 'Conversation message'
  const text = (elements: unknown): string[] => !Array.isArray(elements) ? [] : elements.flatMap(element => {
    const node = object(element), content = object(node?.text)?.content
    return node?.tag === 'markdown' && typeof node.content === 'string' ? [node.content]
      : node?.tag === 'table' && Array.isArray(node.columns) && Array.isArray(node.rows) ? [
        ...node.columns.map(column => String(object(column)?.display_name ?? '')),
        ...node.rows.flatMap(row => Object.values(object(row) ?? {}).map(String))]
      : node?.tag === 'div' && typeof content === 'string' ? [content]
      : node?.tag === 'form' ? text(node.elements) : node?.tag === 'img' && typeof object(node.alt)?.content === 'string' ? [String(object(node.alt)!.content)] : []
  })
  const body = (operation.payload.kind === 'speech' ? [publicationSpeechText(operation.payload)]
    : operation.payload.kind === 'question' ? [operation.payload.text, ...operation.payload.questions.map(question => question.prompt)].filter(Boolean)
    : [...(operation.payload.kind === 'permission' && typeof title === 'string' ? [title] : []),
      ...text(card.elements ?? object(card.body)?.elements)]).join(' ').replace(/\s+/gu, ' ').trim()
  return Array.from([time, purpose, body].filter(Boolean).join(' · ')).slice(0, 60).join('')
}
function sameCard(value: unknown, prepared: PreparedPublication): boolean {
  if (typeof value !== 'string') return false
  try { return isDeepStrictEqual(JSON.parse(value), requestCard(prepared)) } catch { return false }
}
function requestText(prepared: PreparedPublication): string | null {
  try {
    const body = object(JSON.parse(prepared.request.body!))
    if (typeof body?.content !== 'string' || body.msg_type !== 'post') return null
    const content = object(JSON.parse(body.content))
    const language = object(content?.zh_cn), paragraphs = language?.content
    if (!Array.isArray(paragraphs) || paragraphs.length !== 1 || !Array.isArray(paragraphs[0]) || paragraphs[0].length !== 1) return null
    const node = object(paragraphs[0][0])
    return node?.tag === 'text' && node.un_escape === false && typeof node.text === 'string' ? node.text : null
  } catch { return null }
}
/** The documented native post shape is unlocalized and may include an empty style array. */
function samePost(value: unknown, text: string): boolean {
  if (typeof value !== 'string') return false
  try {
    const content = object(JSON.parse(value)), paragraphs = content?.content
    if (content?.title !== '' || !Array.isArray(paragraphs) || paragraphs.length !== 1 || !Array.isArray(paragraphs[0]) || paragraphs[0].length !== 1) return false
    const node = object(paragraphs[0][0])
    return node?.tag === 'text' && node.text === text && (node.style === undefined || Array.isArray(node.style) && node.style.length === 0)
  } catch { return false }
}
function requestImage(prepared: PreparedPublication): string | null {
  try {
    const body = object(JSON.parse(prepared.request.body!)), post = typeof body?.content === 'string' ? object(JSON.parse(body.content)) : null
    const content = object(post?.zh_cn), rows = content?.content
    if (body?.msg_type !== 'post' || content?.title !== '' || !Array.isArray(rows) || rows.length !== 1 || !Array.isArray(rows[0]) || rows[0].length !== 1) return null
    const image = object(rows[0][0])
    return image?.tag === 'img' && Object.keys(image).length === 2 ? feishuIdentity(image.image_key) : null
  } catch { return null }
}
function sameImagePost(value: unknown, prepared: PreparedPublication): boolean {
  if (typeof value !== 'string') return false
  try {
    const post = object(JSON.parse(value)), rows = post?.content
    if (post?.title !== '' || !Array.isArray(rows) || rows.length !== 1 || !Array.isArray(rows[0]) || rows[0].length !== 1) return false
    const image = object(rows[0][0])
    return image?.tag === 'img' && image.image_key === requestImage(prepared)
  } catch { return false }
}
function requestFile(prepared: PreparedPublication): string | null {
  try {
    const body = object(JSON.parse(prepared.request.body!)), content = typeof body?.content === 'string' ? object(JSON.parse(body.content)) : null
    return body?.msg_type === 'file' && content && Object.keys(content).length === 1 ? feishuIdentity(content.file_key) : null
  } catch { return null }
}
function sameFile(value: unknown, prepared: PreparedPublication): boolean {
  if (typeof value !== 'string') return false
  try { return object(JSON.parse(value))?.file_key === requestFile(prepared) } catch { return false }
}
function failure(status: number | undefined, code: unknown): PublicationReceipt | null {
  // An explicit in-flight response cannot establish non-application, even under a retry's request key.
  if (code === 230049) return unknown()
  if (status !== undefined && status >= 500) return { state: 'unknown', reason: 'platform-unavailable' }
  if (status === 429 || code === 230020) return { state: 'not-applied', reason: 'rate-limited' }
  if ([230011, 230019, 230050, 230110, 232009].includes(code as number) || status === 404) return { state: 'not-applied', reason: 'thread-unavailable' }
  if ([230025, 230054].includes(code as number)) return { state: 'not-applied', reason: 'unsupported-format' }
  if ([230001, 230002, 230006, 230013, 230015, 230017, 230018, 230022, 230027, 230028, 230035, 230038, 230055, 230071, 230072, 230075, 230111].includes(code as number) || status === 401 || status === 403) return { state: 'not-applied', reason: 'platform-rejected' }
  if (code !== 0 || status !== undefined && (status < 200 || status >= 300)) return unknown()
  return null
}
function consistent(data: Record<string, unknown>, target: PublicationTarget, mapping?: Readonly<PublicationMapping>): boolean {
  if (data.message_id !== undefined && mapping && data.message_id !== mapping.messageId ||
      data.chat_id !== undefined && data.chat_id !== target.externalConversationId ||
      data.sender !== undefined && !ownSender(data.sender, target.application) ||
      data.deleted !== undefined && typeof data.deleted !== 'boolean' || data.deleted === true ||
      data.thread_id !== undefined && mapping && data.thread_id !== mapping.threadId) return false
  return true
}

/** Stateless platform effects. The original Host owns source selection, durable work, ordering and retries. */
export class FeishuPublicationAdapter implements PublicationAdapter {
  readonly adapterId = 'feishu'
  readonly renderVersion = currentCardRenderVersion
  readonly supportedRenderVersions = ['feishu-post-group-v1', ...nativeCardRenderVersions]
  readonly fragmentBytes = 4_096
  readonly addressing = 'group'
  readonly permissionActions = true as const
  readonly questionActions = true as const
  readonly queryFeedback = true as const
  readonly replyMetadata = true as const
  readonly cards: PublicationCardAdapter = {
    prepareCreate: operation => {
      const card = requestCard(this.prepare(operation, true))
      if (card?.schema !== '2.0' || !identityElement(card, identityElementId(operation))) feishuFailure('FEISHU_NATIVE_CARD_UNSUPPORTED')
      return { adapterId: this.adapterId, renderVersion: this.renderVersion, requestKey: operation.operationId,
        request: { method: 'POST', path: cardsPath, contentType: 'application/json', body: JSON.stringify({ type: 'card_json', data: JSON.stringify(card) }) } }
    },
    create: async (prepared, target, credential, signal) => {
      try {
        parsePreparedPublication(prepared, this)
        if (prepared.request.method !== 'POST' || prepared.request.path !== cardsPath || requestCard(prepared)?.schema !== '2.0') return { state: 'not-applied', reason: 'unsupported-format' }
        const { result, status } = await this.request(prepared, target, credential, signal), failed = nativeFailure(status, result?.code)
        if (failed) return failed
        const id = feishuIdentity(object(result?.data)?.card_id)
        return id.length <= 20 ? { state: 'confirmed', id } : { state: 'unknown', reason: 'effect-unconfirmed' }
      } catch { return { state: 'unknown', reason: 'effect-unconfirmed' } }
    },
    preparePortrait: (operation, sequence) => {
      const mapping = operation.mapping?.nativeCard
      if (!mapping) feishuFailure('FEISHU_NATIVE_CARD_REQUIRED')
      const card = requestCard(this.prepare({ ...operation, cardSequence: sequence })), id = identityElementId(operation), element = identityElement(card, id)
      if (!element || object(element.icon)?.tag !== 'custom_icon') feishuFailure('FEISHU_PORTRAIT_UNAVAILABLE')
      return { adapterId: this.adapterId, renderVersion: this.renderVersion, requestKey: operation.operationId + ':portrait', request: {
        method: 'PUT', path: `${cardsPath}/${encodeURIComponent(mapping.id)}/elements/${id}`, contentType: 'application/json',
        body: JSON.stringify({ uuid: key(operation.operationId + ':portrait'), sequence, element: JSON.stringify(element) }) } }
    },
    portrait: async (prepared, target, credential, signal, mapping) => {
      try {
        if (!this.validPortrait(prepared, mapping)) return { state: 'not-applied', reason: 'unsupported-format' }
        const { result, status } = await this.request(prepared, target, credential, signal)
        return nativeFailure(status, result?.code) ?? { state: 'confirmed' }
      } catch { return { state: 'unknown', reason: 'effect-unconfirmed' } }
    },
    inspectPortrait: async (prepared, target, credential, signal, mapping) => {
      if (!this.validPortrait(prepared, mapping)) return null
      try {
        const body = object(JSON.parse(prepared.request.body!)), expected = object(JSON.parse(String(body?.element))), id = String(expected?.element_id)
        const value = await this.readMessage(target, credential, signal, mapping)
        if (!value || value.msg_type !== 'interactive' || value.deleted === true) return null
        const card = JSON.parse(String(object(value.body)?.content))
        return isDeepStrictEqual(identityElement(card, id), expected) ? { state: 'confirmed' } : null
      } catch { return null }
    }
  }
  readonly images = {
    maxBytes: 10 * 1024 * 1024,
    accepts: (image: PublicationImage) => image.byteLength > 0 && image.byteLength <= this.images.maxBytes && image.width > 0 && image.height > 0 &&
      image.width <= (image.mimeType === 'image/gif' ? 2000 : 12000) && image.height <= (image.mimeType === 'image/gif' ? 2000 : 12000),
    upload: async (image: PublicationImage, target: PublicationTarget, credential: string, signal: AbortSignal) => {
      if (!this.images.accepts(image) || Buffer.from(image.dataBase64, 'base64').length !== image.byteLength ||
        createHash('sha256').update(Buffer.from(image.dataBase64, 'base64')).digest('hex') !== image.sha256 || signal.aborted) return { state: 'unknown' as const }
      try {
        // This pinned method returns data:{image_key} unwrapped, unlike client.request.
        const result = object(await this.clients.withClient(target, credential, client => client.im.image.create({ data: { image_type: 'message', image: Buffer.from(image.dataBase64, 'base64') } }), signal))
        return result?.image_key ? { state: 'confirmed' as const, imageKey: feishuIdentity(result.image_key) } : { state: 'unknown' as const }
      } catch { return { state: 'unknown' as const } }
    }
  }
  readonly files = {
    maxBytes: 16 * 1024 * 1024,
    accepts: (file: PublicationFile) => file.byteLength > 0 && file.byteLength <= this.files.maxBytes && typeof file.displayName === 'string' && file.displayName.length > 0,
    upload: async (file: PublicationFile, target: PublicationTarget, credential: string, signal: AbortSignal) => {
      if (!this.files.accepts(file) || file.dataBase64.length > Math.ceil(this.files.maxBytes / 3) * 4 || signal.aborted) return { state: 'unknown' as const }
      const bytes = Buffer.from(file.dataBase64, 'base64')
      if (bytes.length !== file.byteLength || bytes.toString('base64') !== file.dataBase64 ||
        createHash('sha256').update(bytes).digest('hex') !== file.sha256 || signal.aborted) return { state: 'unknown' as const }
      try {
        const result = object(await this.clients.withClient(target, credential, client => client.im.file.create({
          data: { file_type: 'stream', file_name: file.displayName, file: bytes }
        }), signal))
        return result?.file_key ? { state: 'confirmed' as const, fileKey: feishuIdentity(result.file_key) } : { state: 'unknown' as const }
      } catch { return { state: 'unknown' as const } }
    }
  }
  constructor(private readonly clients: Pick<FeishuAdapter, 'withClient'>) {}
  fragmentBytesFor(target: PublicationTarget): number {
    // One ASCII control byte can occupy seven bytes after both JSON encodings.
    // Reserve the fixed post/uuid envelope and the exact encoded audience.
    return Math.max(4, Math.min(this.fragmentBytes, Math.floor((FEISHU_MESSAGE_BODY_BYTES - 1024 - Buffer.byteLength(JSON.stringify(target.externalConversationId))) / 8)))
  }

  fragmentText(payload: Extract<PublicationPayload, { kind: 'speech' }>, target: PublicationTarget, speaker?: PublicationSpeaker, originalMessage?: PublicationOperation['originalMessage']): readonly PublicationTextFragment[] | undefined {
    // A first recorded time adds a fixed HH:mm prefix. Measure it too, and
    // reserve the largest possible continuation label for this source text.
    const count = Math.max(2, payload.text.length)
    const fits = (part: PublicationTextFragment, fragment: { ordinal: number; count: number }) => {
      // A late native outcome/usage snapshot must fit the original last text slice.
      const displayed = { ...payload, ...(payload.replyMetadata ? { replyMetadata: feishuReplyFooterBudget(payload.replyMetadata) } : {}),
        text: part.text, ...(part.presentationContext ? { presentationContext: part.presentationContext } : {}) }
      const role: FeishuRoleSpeaker = { kind: speaker?.kind ?? 'unknown', ...(speaker?.name ? { name: speaker.name } : {}), elementId: 'author_' + 'x'.repeat(13) }
      const card = speechCard(displayed, role, originalMessage, fragment)
      card.config = { ...object(card.config), summary: { content: cardSummary(card, { payload: displayed, presentationTime: 0, ...(speaker ? { speaker } : {}), ...(originalMessage ? { originalMessage } : {}) }) } }
      const data = JSON.stringify(card)
      // The same fragment may later update its original entity. Measure both native envelopes,
      // including its fixed identity component and largest sequence, independently of avatar readiness.
      return Math.max(...[
        { receive_id: target.externalConversationId, msg_type: 'interactive', uuid: 'x'.repeat(43), content: data },
        { card: { type: 'card_json', data }, uuid: 'x'.repeat(43), sequence: 2_147_483_647 }
      ].map(body => Buffer.byteLength(JSON.stringify(body)))) <= FEISHU_MESSAGE_BODY_BYTES
    }
    if (fits({ text: payload.text }, { ordinal: 0, count: 1 })) return [{ text: payload.text }]
    return fragmentFeishuReply(payload.text, part => fits(part, { ordinal: count - 1, count }))
  }

  prepare(operation: Readonly<PublicationOperation>, identity = !!operation.mapping?.nativeCard): PreparedPublication {
    feishuIdentity(operation.target.externalConversationId)
    feishuIdentity(operation.target.application.appId)
    if (!['open.feishu.cn', 'open.larksuite.com'].includes(operation.target.application.domain)) feishuFailure('FEISHU_APPLICATION_INVALID')
    const mapping = operation.mapping
    if (mapping) feishuIdentity(mapping.messageId)
    if (operation.payload.kind === 'query-feedback') {
      if (mapping && (mapping.messageId !== operation.payload.messageId || mapping.threadId !== undefined || mapping.nativeCard !== undefined)) feishuFailure('FEISHU_QUERY_FEEDBACK_INVALID')
      return { adapterId: this.adapterId, renderVersion: this.renderVersion, requestKey: operation.operationId, request: feishuQueryReaction(operation.payload, operation.effect, mapping) }
    }
    if (operation.effect === 'withdraw') {
      if (!mapping) feishuFailure('FEISHU_PUBLICATION_MAPPING_REQUIRED')
      return { adapterId: this.adapterId, renderVersion: this.renderVersion, requestKey: operation.operationId, request: { method: 'DELETE', path: `${path}/${encodeURIComponent(mapping.messageId)}` } }
    }
    let card: Record<string, unknown> | undefined
    if (operation.payload.kind === 'binding-lifecycle') {
      const payload = operation.payload
      const title = { connected: 'Conversation connected', disconnected: 'Conversation disconnected', paused: 'Conversation paused', resumed: 'Conversation resumed', updated: 'Conversation sharing updated' }[payload.event]
      const ended = payload.event === 'disconnected', paused = payload.event === 'paused'
      const publication = payload.scope.publication === 'future-shared-conversation' ? 'New normal conversation messages are shared with this group.' : 'New public Agent replies are shared with this group.'
      const input = payload.scope.input === 'all-messages' ? 'Authorized members can send requests directly.' : 'Authorized members can send requests by mentioning or replying to the bot.'
      const status = ended ? 'This group no longer synchronizes with the Agent. The Agent and its conversation are kept.'
        : paused ? 'New messages are paused in both directions. The Agent, group and member permissions are kept.'
        : payload.synchronization === null ? 'The relationship is saved. Automatic synchronization has not been confirmed; inspect it in AgentMux Connections.'
        : !payload.synchronization ? 'The group is linked, but automatic synchronization is off. Enable it in AgentMux Connections to start sharing.'
        : 'This relationship is saved. Individual message receipts show whether each direction is working.'
      card = { config: { update_multi: true }, header: { template: ended || paused ? 'grey' : 'blue', title: { tag: 'plain_text', content: title } }, elements: [
        { tag: 'div', text: { tag: 'plain_text', content: `Agent ${payload.agentSessionId}` } },
        { tag: 'div', text: { tag: 'plain_text', content: `Group ${operation.target.externalConversationId}` } },
        { tag: 'div', text: { tag: 'plain_text', content: status } },
        ...(!ended && !paused ? [{ tag: 'div', text: { tag: 'plain_text', content: `${publication}\n${input}\nEarlier history is not backfilled. Internal reasoning, raw tool details and system context are not shared.` } }] : []),
        { tag: 'action', actions: [{ tag: 'button', type: 'default', text: { tag: 'plain_text', content: 'Open conversation' }, url: `amux://agent/${encodeURIComponent(payload.agentSessionId)}` }] }
      ] }
    } else if (operation.payload.kind === 'failure') {
      const payload = operation.payload
      card = { config: { update_multi: true }, header: { template: 'red', title: { tag: 'plain_text', content: 'Request failed' } }, elements: [
        { tag: 'div', text: { tag: 'plain_text', content: payload.message ?? 'The Agent could not complete this request.' } },
        { tag: 'div', text: { tag: 'plain_text', content: payload.recovery } },
        { tag: 'div', text: { tag: 'plain_text', content: payload.code + (payload.httpStatusCode === undefined ? '' : ` · HTTP ${payload.httpStatusCode}`) } },
        { tag: 'action', actions: [{ tag: 'button', type: 'default', text: { tag: 'plain_text', content: 'Open conversation' }, url: `amux://agent/${encodeURIComponent(operation.reference.agentSessionId)}` }] }
      ] }
    } else if (operation.payload.kind === 'question') {
      card = feishuQuestionCard(operation.payload, feishuIdentity(operation.reference.agentSessionId), roleSpeaker(operation, identity))
    } else if (operation.payload.kind === 'permission') {
      const payload = operation.payload
      const status = { pending: 'Choose one original permission option.', 'response-sent': 'Response returned. Native adoption and completion are not confirmed.', unconfirmed: 'The original response is not confirmed. Check it in amux; it will not be resent.', unavailable: 'Continue in the original amux terminal.' }[payload.status]
      card = { config: { update_multi: true }, header: { title: { tag: 'plain_text', content: payload.title } }, elements: [
        ...(payload.context === undefined ? [] : [{ tag: 'div', text: { tag: 'plain_text', content: payload.context } }]),
        { tag: 'div', text: { tag: 'plain_text', content: status } },
        ...payload.options.map(option => ({ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: option.label }, value: { actionRef: option.actionRef } }] }))
      ] }
    } else if (operation.payload.kind === 'speech') {
      if (!publicationSpeechText(operation.payload)) feishuFailure('FEISHU_PUBLICATION_CONTENT_UNSUPPORTED')
      const speaker = roleSpeaker(operation, identity)
      card = speechCard(operation.payload, speaker, operation.originalMessage, operation.fragment)
    } else if (operation.payload.kind === 'image') {
      const uploaded = operation.uploads?.at(-1)
      if (uploaded?.state !== 'confirmed' || !('imageKey' in uploaded)) feishuFailure('FEISHU_IMAGE_UPLOAD_UNCONFIRMED')
      card = { schema: '2.0', config: { update_multi: true }, header: { title: { tag: 'plain_text', content: 'Shared image' } },
        body: { elements: [{ tag: 'img', img_key: feishuIdentity(uploaded.imageKey), alt: { tag: 'plain_text', content: operation.payload.image.alt || 'Original conversation image' } }] } }
    }
    if (card) {
      card.config = { ...object(card.config), summary: { content: cardSummary(card, operation) } }
      const native = mapping?.nativeCard
      const created = !mapping && operation.cardPreparation?.useForMessage && operation.cardPreparation.receipt.state === 'confirmed' ? operation.cardPreparation.receipt.id : undefined
      if (native && (card.schema !== '2.0' || !Number.isSafeInteger(operation.cardSequence) || operation.cardSequence! < 1 || operation.cardSequence! > 2_147_483_647)) feishuFailure('FEISHU_NATIVE_CARD_UNSUPPORTED')
      const encode = () => JSON.stringify(native ? { card: { type: 'card_json', data: JSON.stringify(card) }, uuid: key(operation.operationId), sequence: operation.cardSequence }
        : { ...(mapping ? {} : { receive_id: operation.target.externalConversationId, msg_type: 'interactive', uuid: key(operation.operationId) }), content: JSON.stringify(created ? { type: 'card', data: { card_id: created } } : card) })
      let body = encode()
      if (Buffer.byteLength(body) > FEISHU_MESSAGE_BODY_BYTES && operation.payload.kind === 'speech' && operation.speaker) {
        // The exact optional asset key cannot force another body fragment or delay its delivery.
        const { imageKey: _imageKey, ...speaker } = roleSpeaker(operation, identity)
        card = speechCard(operation.payload, speaker, operation.originalMessage, operation.fragment)
        card.config = { ...object(card.config), summary: { content: cardSummary(card, operation) } }
        body = encode()
      }
      if (Buffer.byteLength(body) > FEISHU_MESSAGE_BODY_BYTES) feishuFailure('FEISHU_PUBLICATION_REQUEST_TOO_LARGE')
      return { adapterId: this.adapterId, renderVersion: this.renderVersion, requestKey: operation.operationId, request: {
        method: native ? 'PUT' : mapping ? 'PATCH' : 'POST', path: native ? `${cardsPath}/${encodeURIComponent(native.id)}` : mapping ? `${path}/${encodeURIComponent(mapping.messageId)}` : path,
        ...(mapping ? {} : { query: { receive_id_type: 'chat_id' } }), contentType: 'application/json', body } }
    }
    if (operation.payload.kind === 'file') {
      if (mapping) feishuFailure('FEISHU_FILE_REPLACEMENT_REQUIRES_WITHDRAWAL')
      const uploaded = operation.uploads?.at(-1)
      if (uploaded?.state !== 'confirmed' || !('fileKey' in uploaded)) feishuFailure('FEISHU_FILE_UPLOAD_UNCONFIRMED')
      const body = JSON.stringify({ receive_id: operation.target.externalConversationId, msg_type: 'file',
        content: JSON.stringify({ file_key: feishuIdentity(uploaded.fileKey) }), uuid: key(operation.operationId) })
      if (Buffer.byteLength(body) > FEISHU_MESSAGE_BODY_BYTES) feishuFailure('FEISHU_PUBLICATION_REQUEST_TOO_LARGE')
      return { adapterId: this.adapterId, renderVersion: this.renderVersion, requestKey: operation.operationId, request: {
        method: 'POST', path, query: { receive_id_type: 'chat_id' }, contentType: 'application/json', body } }
    }
    return feishuFailure('FEISHU_PUBLICATION_CONTENT_UNSUPPORTED')
  }
  private valid(prepared: PreparedPublication, target: PublicationTarget, mapping?: Readonly<PublicationMapping>): boolean {
    try {
      parsePreparedPublication(prepared, this)
      if (prepared.request.body !== undefined && Buffer.byteLength(prepared.request.body) > FEISHU_MESSAGE_BODY_BYTES) return false
      const reaction = readFeishuQueryReaction(prepared)
      if (reaction) return (reaction.reactionId === undefined || mapping?.reactionId === reaction.reactionId) &&
        (mapping === undefined || mapping.messageId === reaction.messageId && mapping.threadId === undefined && mapping.nativeCard === undefined)
      if (mapping?.nativeCard && prepared.request.method !== 'DELETE') return prepared.request.method === 'PUT' && prepared.request.path === `${cardsPath}/${encodeURIComponent(mapping.nativeCard.id)}` &&
        prepared.request.query === undefined && prepared.request.contentType === 'application/json' && requestCard(prepared)?.schema === '2.0' && nativeSequence(object(JSON.parse(prepared.request.body!)), prepared)
      if (mapping) return prepared.request.path === `${path}/${encodeURIComponent(feishuIdentity(mapping.messageId))}` &&
        prepared.request.query === undefined && (prepared.request.method === 'DELETE' && prepared.request.body === undefined || prepared.request.method === 'PUT' && prepared.request.contentType === 'application/json' && (requestText(prepared) !== null || requestImage(prepared) !== null) || prepared.request.method === 'PATCH' && nativeCardRenderVersions.includes(prepared.renderVersion) && prepared.request.contentType === 'application/json' && requestCard(prepared) !== null)
      const body = object(JSON.parse(prepared.request.body!))
      return prepared.request.method === 'POST' && prepared.request.path === path && prepared.request.contentType === 'application/json' && prepared.request.query?.receive_id_type === 'chat_id' &&
        body?.receive_id === target.externalConversationId && body.uuid === key(prepared.requestKey) && (body.msg_type === 'file' && requestFile(prepared) !== null || body.msg_type === 'post' && (requestText(prepared) !== null || requestImage(prepared) !== null) || body.msg_type === 'interactive' && nativeCardRenderVersions.includes(prepared.renderVersion) && (requestCard(prepared) !== null || requestEntity(prepared) !== null))
    } catch { return false }
  }
  private validPortrait(prepared: PreparedPublication, mapping: Readonly<PublicationMapping>): boolean {
    try {
      parsePreparedPublication(prepared, this)
      const body = object(JSON.parse(prepared.request.body!)), element = object(JSON.parse(String(body?.element))), id = String(element?.element_id)
      return !!mapping.nativeCard && prepared.request.method === 'PUT' && prepared.request.path === `${cardsPath}/${encodeURIComponent(mapping.nativeCard.id)}/elements/${id}` &&
        /^[A-Za-z][A-Za-z0-9_]{0,19}$/u.test(id) && element?.tag === 'div' && object(element.icon)?.tag === 'custom_icon' && nativeSequence(body, prepared)
    } catch { return false }
  }
  private async request(prepared: PreparedPublication, target: PublicationTarget, credential: string, signal: AbortSignal) {
    let status: number | undefined
    const response = await this.clients.withClient(target, credential, client => client.request<unknown>({
      url: prepared.request.path, method: prepared.request.method, params: prepared.request.query, headers: { 'Content-Type': 'application/json; charset=utf-8' },
      ...(prepared.request.body === undefined ? {} : { data: {}, transformRequest: [() => prepared.request.body] }),
      validateStatus: value => { status = value; return true }, signal
    }), signal)
    return { response, result: object(response), status }
  }
  private async readMessage(target: PublicationTarget, credential: string, signal: AbortSignal, mapping: Readonly<PublicationMapping>): Promise<Record<string, unknown> | null> {
    let status: number | undefined
    const response = await this.clients.withClient(target, credential, client => client.request<unknown>({ url: `${path}/${encodeURIComponent(feishuIdentity(mapping.messageId))}`, method: 'GET', params: { user_id_type: 'open_id', card_msg_content_type: 'user_card_content' }, validateStatus: value => { status = value; return true }, signal }), signal)
    const result = object(response), items = object(result?.data)?.items
    if (result?.code !== 0 || status !== undefined && (status < 200 || status >= 300) || !Array.isArray(items)) return null
    const matches = items.map(object).filter(item => item?.message_id === mapping.messageId)
    const original = matches.length === 1 ? matches[0] : null
    return original && original.chat_id === target.externalConversationId && ownSender(original.sender, target.application) && (original.thread_id === undefined || original.thread_id === mapping.threadId) ? original : null
  }
  async dispatch(prepared: PreparedPublication, target: PublicationTarget, credential: string, signal: AbortSignal, mapping?: Readonly<PublicationMapping>): Promise<PublicationReceipt> {
    if (!this.valid(prepared, target, mapping)) return { state: 'not-applied', reason: 'unsupported-format' }
    try {
      const { response, status } = await this.request(prepared, target, credential, signal)
      const reaction = readFeishuQueryReaction(prepared)
      if (reaction) return feishuReactionReceipt(response, status, reaction, target.application, mapping)
      const result = object(response), failed = failure(status, result?.code)
      if (mapping?.nativeCard && prepared.request.method === 'PUT') return nativeFailure(status, result?.code) ?? { state: 'confirmed', mapping: { ...mapping } }
      if (failed) return failed
      const data = object(result?.data)
      if (!data || !consistent(data, target, mapping)) return unknown()
      if (prepared.request.method === 'DELETE') return mapping ? { state: 'confirmed', mapping: { ...mapping } } : unknown()
      if (prepared.request.method === 'PATCH') return mapping ? { state: 'confirmed', mapping: { ...mapping } } : unknown()
      const card = requestCard(prepared), entity = requestEntity(prepared), messageId = feishuIdentity(data.message_id)
      if (data.chat_id !== target.externalConversationId || data.msg_type !== undefined && data.msg_type !== (card || entity ? 'interactive' : requestFile(prepared) ? 'file' : 'post')) return unknown()
      const body = object(data.body)
      // A successful create returns the native reading representation, not the
      // authored card JSON. The original request's ID/target receipt confirms it.
      if (!card && !entity && body?.content !== undefined && !(requestFile(prepared) ? sameFile(body.content, prepared) : requestImage(prepared) ? sameImagePost(body.content, prepared) : samePost(body.content, requestText(prepared)!))) return unknown()
      if (mapping) return { state: 'confirmed', mapping: { ...mapping } }
      const threadId = data.thread_id === undefined ? undefined : feishuIdentity(data.thread_id)
      return { state: 'confirmed', mapping: { messageId, ...(threadId === undefined ? {} : { threadId }), ...(entity ? { nativeCard: { id: entity, operationId: prepared.requestKey } } : {}) } }
    } catch { return unknown() }
  }
  async inspect(prepared: PreparedPublication, target: PublicationTarget, credential: string, signal: AbortSignal, mapping?: Readonly<PublicationMapping>): Promise<PublicationReceipt | null> {
    const reaction = readFeishuQueryReaction(prepared)
    if (reaction) {
      if (!this.valid(prepared, target, mapping)) return null
      // A missing delete ACK stays unknown: list absence cannot attest to that original DELETE.
      if (reaction.reactionId !== undefined) return null
      // A missing ACK can only read this original message/stage; absence never authorizes another POST.
      try {
        let token: string | undefined, confirmed: PublicationMapping | undefined
        const seen = new Set<string>()
        do {
          if (signal.aborted) return null
          let status: number | undefined
          const response = await this.clients.withClient(target, credential, client => client.request<unknown>({
            url: prepared.request.path, method: 'GET', params: { reaction_type: reaction.emojiType, page_size: 50, ...(token ? { page_token: token } : {}) },
            validateStatus: value => { status = value; return true }, signal
          }), signal)
          const result = object(response), data = object(result?.data)
          if (signal.aborted || result?.code !== 0 || status !== undefined && (status < 200 || status >= 300) ||
              !data || !Array.isArray(data.items) || typeof data.has_more !== 'boolean') return null
          for (const item of data.items) {
            const found = feishuReactionMapping(item, reaction, target.application, mapping)
            if (!found) continue
            if (confirmed) return null
            confirmed = found
          }
          if (!data.has_more) return confirmed ? { state: 'confirmed', mapping: confirmed } : null
          const next = feishuIdentity(data.page_token)
          if (seen.has(next)) return null
          seen.add(next); token = next
        } while (true)
      } catch { return null }
    }
    // No supported lookup by uuid exists. A missing create ID, including after dedup expiry, stays unknown.
    if (!mapping || !(this.valid(prepared, target, mapping) || this.valid(prepared, target))) return null
    try {
      feishuIdentity(mapping.messageId)
      let status: number | undefined
      const response = await this.clients.withClient(target, credential, client => client.request<unknown>({ url: `${path}/${encodeURIComponent(mapping.messageId)}`, method: 'GET', params: { user_id_type: 'open_id', ...(requestCard(prepared) ? { card_msg_content_type: 'user_card_content' } : {}) }, validateStatus: value => { status = value; return true }, signal }), signal)
      const result = object(response), items = object(result?.data)?.items
      if (result?.code !== 0 || status !== undefined && (status < 200 || status >= 300) || !Array.isArray(items)) return null
      const matches = items.map(object).filter(item => item?.message_id === mapping.messageId)
      if (matches.length !== 1) return null
      const original = matches[0]!
      if (original.deleted !== undefined && typeof original.deleted !== 'boolean' || original.chat_id !== target.externalConversationId || !ownSender(original.sender, target.application) || original.thread_id !== undefined && original.thread_id !== mapping.threadId) return null
      if (prepared.request.method === 'DELETE') return original.deleted === true ? { state: 'confirmed', mapping: { ...mapping } } : null
      return original.deleted !== true && (requestCard(prepared) ? original.msg_type === 'interactive' && sameCard(object(original.body)?.content, prepared) : requestFile(prepared) ? original.msg_type === 'file' && sameFile(object(original.body)?.content, prepared) : original.msg_type === 'post' && (requestImage(prepared) ? sameImagePost(object(original.body)?.content, prepared) : samePost(object(original.body)?.content, requestText(prepared)!))) ? { state: 'confirmed', mapping: { ...mapping } } : null
    } catch { return null }
  }
}
