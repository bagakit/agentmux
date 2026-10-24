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
import { feishuReplyCard, fragmentFeishuReply } from './reply-card.js'
import { feishuRoleCard, type FeishuRoleSpeaker } from './role-card.js'
import type { PublicationSpeaker } from '../../publication-speaker.js'
import { feishuQueryReaction, readFeishuQueryReaction, feishuReactionMapping, feishuReactionReceipt } from './reaction.js'

const path = '/open-apis/im/v1/messages'
const currentCardRenderVersion = 'feishu-conversation-v8'
// Retained frozen cards use their original wire; this never prepares or replays an older effect.
const nativeCardRenderVersions = ['feishu-group-v2', 'feishu-conversation-v3', 'feishu-conversation-v4', 'feishu-conversation-v5', 'feishu-conversation-v6', 'feishu-conversation-v7', currentCardRenderVersion]
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const unknown = (): PublicationReceipt => ({ state: 'unknown', reason: 'effect-unconfirmed' })
const key = (operationId: string) => createHash('sha256').update(operationId).digest('base64url')
function inputStatus(payload: Extract<PublicationPayload, { kind: 'speech' }>): string | undefined {
  const input = payload.inputSubmission
  return input ? ({ waiting: 'Saved · waiting for Agent', stopped: 'Saved · delivery stopped', 'terminal-confirmed': 'Sent to Agent · acceptance not confirmed',
    admitted: 'Accepted by Agent', 'not-applied': 'Not delivered to Agent', unknown: 'Saved · delivery to Agent unconfirmed' }[input.status])
    + (input.observation === 'rejoin-needed' ? '\nReconnect this input in AgentMux' : '') : undefined
}
function appendInputStatus(card: Record<string, unknown>, payload: Extract<PublicationPayload, { kind: 'speech' }>, speaker: Pick<PublicationSpeaker, 'kind'>): void {
  const status = speaker.kind === 'human' ? inputStatus(payload) : undefined
  if (status) (object(card.body)!.elements as unknown[]).push({ tag: 'div', text_size: 'notation', text: { tag: 'plain_text', content: status } })
}
function ownSender(value: unknown, application: ConnectionApplication): boolean {
  const sender = object(value)
  return sender?.sender_type === 'app' && sender.id_type === 'app_id' && sender.id === application.appId
}
function requestCard(prepared: PreparedPublication): Record<string, unknown> | null {
  try {
    const body = object(JSON.parse(prepared.request.body!)), card = typeof body?.content === 'string' ? object(JSON.parse(body.content)) : null
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
/** Feed preview only. Visible card text supplies the excerpt; no action values or private references. */
function cardSummary(card: Record<string, unknown>, operation: Pick<PublicationOperation, 'payload' | 'presentationTime' | 'speaker'>): string {
  const at = operation.presentationTime, date = at === undefined || !Number.isFinite(at) || Math.abs(at) > 8.64e15 ? null : new Date(at)
  const time = date ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` : undefined
  const title = object(object(card.header)?.title)?.content
  const purpose = operation.payload.kind === 'speech' && operation.speaker
    ? [{ agent: 'Agent', human: 'User', external: 'External message', mixed: 'Mixed authors', unknown: 'Unknown author' }[operation.speaker.kind],
      operation.payload.phase === 'final' ? 'Reply' : operation.payload.phase === 'progress' ? 'Progress' : undefined].filter(Boolean).join(' · ')
    : operation.payload.kind === 'permission' ? 'Permission' : typeof title === 'string' ? title : operation.payload.kind === 'speech'
      ? operation.payload.phase === 'final' ? 'Agent reply' : operation.payload.phase === 'progress' ? 'Agent progress' : 'Conversation message' : 'Conversation message'
  const text = (elements: unknown): string[] => !Array.isArray(elements) ? [] : elements.flatMap(element => {
    const node = object(element), content = object(node?.text)?.content
    return node?.tag === 'markdown' && typeof node.content === 'string' ? [node.content]
      : node?.tag === 'table' && Array.isArray(node.columns) && Array.isArray(node.rows) ? [
        ...node.columns.map(column => String(object(column)?.display_name ?? '')),
        ...node.rows.flatMap(row => Object.values(object(row) ?? {}).map(String))]
      : node?.tag === 'div' && typeof content === 'string' ? [content]
      : node?.tag === 'form' ? text(node.elements) : node?.tag === 'img' && typeof object(node.alt)?.content === 'string' ? [String(object(node.alt)!.content)] : []
  })
  const body = (operation.payload.kind === 'speech' && operation.speaker ? [publicationSpeechText(operation.payload)]
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

  fragmentText(payload: Extract<PublicationPayload, { kind: 'speech' }>, target: PublicationTarget, speaker?: PublicationSpeaker): readonly PublicationTextFragment[] | undefined {
    if (!speaker && (payload.phase !== 'final' || payload.relay)) return undefined
    // A first recorded time adds a fixed HH:mm prefix. Measure it too, and
    // reserve the largest possible continuation label for this source text.
    const count = Math.max(2, payload.text.length)
    const fits = (part: PublicationTextFragment, fragment: { ordinal: number; count: number }) => {
      // Without line breaks there cannot be a native table. Its Markdown
      // component preserves every source byte, so this lower bound is exact.
      if (!/[\r\n]/u.test(part.text) && Buffer.byteLength(part.text) > FEISHU_MESSAGE_BODY_BYTES) return false
      const displayed = { ...payload, text: (part.presentationContext?.before ?? '') + part.text + (part.presentationContext?.after ?? '') }
      const role = speaker ? { kind: speaker.kind, ...(speaker.name ? { name: speaker.name } : {}) } : undefined
      const card = role ? feishuRoleCard(publicationSpeechText(displayed), role, { ...(payload.phase ? { phase: payload.phase } : {}), fragment, ...(part.presentationContext?.literal ? { literal: true } : {}) })
        : feishuReplyCard(publicationSpeechText(displayed), fragment, part.presentationContext?.literal)
      if (speaker) appendInputStatus(card, displayed, speaker)
      card.config = { ...object(card.config), summary: { content: cardSummary(card, { payload: displayed, presentationTime: 0, ...(speaker ? { speaker } : {}) }) } }
      return Buffer.byteLength(JSON.stringify({ receive_id: target.externalConversationId, msg_type: 'interactive', uuid: 'x'.repeat(43), content: JSON.stringify(card) })) <= FEISHU_MESSAGE_BODY_BYTES
    }
    if (fits({ text: payload.text }, { ordinal: 0, count: 1 })) return [{ text: payload.text }]
    return fragmentFeishuReply(payload.text, part => fits(part, { ordinal: count - 1, count }))
  }

  prepare(operation: Readonly<PublicationOperation>): PreparedPublication {
    feishuIdentity(operation.target.externalConversationId)
    feishuIdentity(operation.target.application.appId)
    if (!['open.feishu.cn', 'open.larksuite.com'].includes(operation.target.application.domain)) feishuFailure('FEISHU_APPLICATION_INVALID')
    const mapping = operation.mapping
    if (mapping) feishuIdentity(mapping.messageId)
    if (operation.payload.kind === 'query-feedback') {
      if (operation.effect !== 'upsert' || mapping && (mapping.messageId !== operation.payload.messageId || mapping.threadId !== undefined)) feishuFailure('FEISHU_QUERY_FEEDBACK_INVALID')
      return { adapterId: this.adapterId, renderVersion: this.renderVersion, requestKey: operation.operationId, request: feishuQueryReaction(operation.payload) }
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
    } else if (operation.payload.kind === 'question') {
      card = feishuQuestionCard(operation.payload, feishuIdentity(operation.reference.agentSessionId))
    } else if (operation.payload.kind === 'permission') {
      const payload = operation.payload
      const status = { pending: 'Choose one original permission option.', 'response-sent': 'Response returned. Native adoption and completion are not confirmed.', unconfirmed: 'The original response is not confirmed. Check it in amux; it will not be resent.', unavailable: 'Continue in the original amux terminal.' }[payload.status]
      card = { config: { update_multi: true }, header: { title: { tag: 'plain_text', content: payload.title } }, elements: [
        ...(payload.context === undefined ? [] : [{ tag: 'div', text: { tag: 'plain_text', content: payload.context } }]),
        { tag: 'div', text: { tag: 'plain_text', content: status } },
        ...payload.options.map(option => ({ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: option.label }, value: { actionRef: option.actionRef } }] }))
      ] }
    } else if (operation.payload.kind === 'speech' && operation.speaker) {
      const payload = operation.payload, snapshot = operation.speaker, uploaded = operation.avatarUploads?.at(-1)
      const speaker: FeishuRoleSpeaker = { kind: snapshot.kind, ...(snapshot.name ? { name: snapshot.name } : {}),
        ...(operation.avatarSource?.imageKey ? { imageKey: feishuIdentity(operation.avatarSource.imageKey) }
          : uploaded?.state === 'confirmed' ? { imageKey: feishuIdentity(uploaded.imageKey) } : {}) }
      card = feishuRoleCard(publicationSpeechText({ ...payload, text: (payload.presentationContext?.before ?? '') + payload.text + (payload.presentationContext?.after ?? '') }), speaker,
        { ...(payload.phase ? { phase: payload.phase } : {}), fragment: operation.fragment, ...(payload.presentationContext?.literal ? { literal: true } : {}) })
      appendInputStatus(card, payload, snapshot)
    } else if (operation.payload.kind === 'speech' && operation.payload.relay) {
      if (!publicationSpeechText(operation.payload)) feishuFailure('FEISHU_PUBLICATION_CONTENT_UNSUPPORTED')
      const authors = operation.payload.relay.sources.map(source => source.author.kind)
      const kinds = new Set(authors), human = authors.length > 0 && authors.every(kind => kind === 'human')
      const title = human ? 'User' : kinds.size > 1 ? 'Mixed authors' : kinds.has('external') ? 'External message'
        : kinds.has('agent') ? 'Agent input' : 'Unknown author'
      const input = human ? operation.payload.inputSubmission : undefined
      const inputStatus = input ? ({ waiting: 'Saved · waiting for Agent', stopped: 'Saved · delivery stopped',
        'terminal-confirmed': 'Sent to Agent · acceptance not confirmed', admitted: 'Accepted by Agent',
        'not-applied': 'Not delivered to Agent', unknown: 'Saved · delivery to Agent unconfirmed' }[input.status]
        + (input.observation === 'rejoin-needed' ? '\nReconnect this input in AgentMux' : '')) : undefined
      card = { config: { update_multi: true }, header: { title: { tag: 'plain_text', content: title + ' · via amux' }, template: human ? 'green' : 'grey' },
        elements: [{ tag: 'div', text: { tag: 'plain_text', content: publicationSpeechText(operation.payload) } },
          ...(inputStatus ? [{ tag: 'div', text: { tag: 'plain_text', content: inputStatus } }] : [])] }
    } else if (operation.payload.kind === 'speech') {
      if (!publicationSpeechText(operation.payload)) feishuFailure('FEISHU_PUBLICATION_CONTENT_UNSUPPORTED')
      const text = publicationSpeechText(operation.payload)
      if (operation.payload.phase === 'final') {
        card = feishuReplyCard(publicationSpeechText({ ...operation.payload, text: (operation.payload.presentationContext?.before ?? '') + operation.payload.text + (operation.payload.presentationContext?.after ?? '') }), operation.fragment, operation.payload.presentationContext?.literal)
      } else if (operation.payload.phase === 'progress') {
        card = { schema: '2.0', config: { update_multi: true },
          body: { padding: '8px 12px 8px 12px', vertical_spacing: '4px',
            elements: [{ tag: 'div', text_size: 'notation', text: { tag: 'plain_text', content: text } }] } }
      } else {
        const title = 'Conversation message'
        card = { config: { update_multi: true }, header: { title: { tag: 'plain_text', content: title }, template: 'blue' },
          elements: [{ tag: 'div', text: { tag: 'plain_text', content: text } }] }
      }
    } else if (operation.payload.kind === 'image') {
      const uploaded = operation.uploads?.at(-1)
      if (uploaded?.state !== 'confirmed' || !('imageKey' in uploaded)) feishuFailure('FEISHU_IMAGE_UPLOAD_UNCONFIRMED')
      card = { config: { update_multi: true }, header: { title: { tag: 'plain_text', content: 'Shared image' } },
        elements: [{ tag: 'img', img_key: feishuIdentity(uploaded.imageKey), alt: { tag: 'plain_text', content: operation.payload.image.alt || 'Original conversation image' } }] }
    }
    if (card) {
      card.config = { ...object(card.config), summary: { content: cardSummary(card, operation) } }
      const encode = () => JSON.stringify({ ...(mapping ? {} : { receive_id: operation.target.externalConversationId, msg_type: 'interactive', uuid: key(operation.operationId) }), content: JSON.stringify(card) })
      let body = encode()
      if (Buffer.byteLength(body) > FEISHU_MESSAGE_BODY_BYTES && operation.payload.kind === 'speech' && operation.speaker) {
        // The exact optional asset key cannot force another body fragment or delay its delivery.
        const identity = (object(card.body)!.elements as Record<string, unknown>[])[0]!
        if (identity.icon) { delete identity.icon; body = encode() }
      }
      if (Buffer.byteLength(body) > FEISHU_MESSAGE_BODY_BYTES) feishuFailure('FEISHU_PUBLICATION_REQUEST_TOO_LARGE')
      return { adapterId: this.adapterId, renderVersion: this.renderVersion, requestKey: operation.operationId, request: {
        method: mapping ? 'PATCH' : 'POST', path: mapping ? `${path}/${encodeURIComponent(mapping.messageId)}` : path,
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
      if (reaction) return mapping === undefined || mapping.messageId === reaction.messageId && mapping.threadId === undefined
      if (mapping) return prepared.request.path === `${path}/${encodeURIComponent(feishuIdentity(mapping.messageId))}` &&
        prepared.request.query === undefined && (prepared.request.method === 'DELETE' && prepared.request.body === undefined || prepared.request.method === 'PUT' && prepared.request.contentType === 'application/json' && (requestText(prepared) !== null || requestImage(prepared) !== null) || prepared.request.method === 'PATCH' && nativeCardRenderVersions.includes(prepared.renderVersion) && prepared.request.contentType === 'application/json' && requestCard(prepared) !== null)
      const body = object(JSON.parse(prepared.request.body!))
      return prepared.request.method === 'POST' && prepared.request.path === path && prepared.request.contentType === 'application/json' && prepared.request.query?.receive_id_type === 'chat_id' &&
        body?.receive_id === target.externalConversationId && body.uuid === key(prepared.requestKey) && (body.msg_type === 'file' && requestFile(prepared) !== null || body.msg_type === 'post' && (requestText(prepared) !== null || requestImage(prepared) !== null) || body.msg_type === 'interactive' && nativeCardRenderVersions.includes(prepared.renderVersion) && requestCard(prepared) !== null)
    } catch { return false }
  }
  async dispatch(prepared: PreparedPublication, target: PublicationTarget, credential: string, signal: AbortSignal, mapping?: Readonly<PublicationMapping>): Promise<PublicationReceipt> {
    if (!this.valid(prepared, target, mapping)) return { state: 'not-applied', reason: 'unsupported-format' }
    try {
      let status: number | undefined
      const response = await this.clients.withClient(target, credential, client => client.request<unknown>({
        url: prepared.request.path, method: prepared.request.method, params: prepared.request.query, headers: { 'Content-Type': 'application/json; charset=utf-8' },
        // The SDK merges data into an object. Axios must serialize the original frozen bytes instead.
        ...(prepared.request.body === undefined ? {} : { data: {}, transformRequest: [() => prepared.request.body] }),
        validateStatus: value => { status = value; return true }, signal
      }), signal)
      const reaction = readFeishuQueryReaction(prepared)
      if (reaction) return feishuReactionReceipt(response, status, reaction, target.application, mapping)
      const result = object(response), failed = failure(status, result?.code)
      if (failed) return failed
      const data = object(result?.data)
      if (!data || !consistent(data, target, mapping)) return unknown()
      if (prepared.request.method === 'DELETE') return mapping ? { state: 'confirmed', mapping: { ...mapping } } : unknown()
      if (prepared.request.method === 'PATCH') return mapping ? { state: 'confirmed', mapping: { ...mapping } } : unknown()
      const card = requestCard(prepared), messageId = feishuIdentity(data.message_id)
      if (data.chat_id !== target.externalConversationId || data.msg_type !== undefined && data.msg_type !== (card ? 'interactive' : requestFile(prepared) ? 'file' : 'post')) return unknown()
      const body = object(data.body)
      // A successful create returns the native reading representation, not the
      // authored card JSON. The original request's ID/target receipt confirms it.
      if (!card && body?.content !== undefined && !(requestFile(prepared) ? sameFile(body.content, prepared) : requestImage(prepared) ? sameImagePost(body.content, prepared) : samePost(body.content, requestText(prepared)!))) return unknown()
      if (mapping) return { state: 'confirmed', mapping: { ...mapping } }
      const threadId = data.thread_id === undefined ? undefined : feishuIdentity(data.thread_id)
      return { state: 'confirmed', mapping: { messageId, ...(threadId === undefined ? {} : { threadId }) } }
    } catch { return unknown() }
  }
  async inspect(prepared: PreparedPublication, target: PublicationTarget, credential: string, signal: AbortSignal, mapping?: Readonly<PublicationMapping>): Promise<PublicationReceipt | null> {
    const reaction = readFeishuQueryReaction(prepared)
    if (reaction) {
      if (!this.valid(prepared, target, mapping)) return null
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
