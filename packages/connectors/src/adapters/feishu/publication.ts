import { createHash } from 'node:crypto'
import type { ConnectionApplication } from '@agentmux/core/connections'
import type { PublicationAdapter } from '../../publication-adapter.js'
import type { PublicationMapping, PublicationOperation, PublicationReceipt, PublicationTarget } from '../../publication-store.js'
import { parsePreparedPublication, type PreparedPublication } from '../../publication-wire.js'
import type { FeishuAdapter } from './index.js'
import { feishuFailure, feishuIdentity } from './message.js'

const path = '/open-apis/im/v1/messages'
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const unknown = (): PublicationReceipt => ({ state: 'unknown', reason: 'effect-unconfirmed' })
const key = (operationId: string) => createHash('sha256').update(operationId).digest('base64url')
function ownSender(value: unknown, application: ConnectionApplication): boolean {
  const sender = object(value)
  return sender?.sender_type === 'app' && sender.id_type === 'app_id' && sender.id === application.appId
}
function post(text: string): string {
  return JSON.stringify({ zh_cn: { title: '', content: [[{ tag: 'text', text, un_escape: false }]] } })
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
  readonly renderVersion = 'feishu-post-group-v1'
  readonly supportedRenderVersions = [this.renderVersion]
  readonly fragmentBytes = 4_096
  readonly addressing = 'group'
  constructor(private readonly clients: Pick<FeishuAdapter, 'withClient'>) {}

  prepare(operation: Readonly<PublicationOperation>): PreparedPublication {
    feishuIdentity(operation.target.externalConversationId)
    feishuIdentity(operation.target.application.appId)
    if (!['open.feishu.cn', 'open.larksuite.com'].includes(operation.target.application.domain)) feishuFailure('FEISHU_APPLICATION_INVALID')
    const mapping = operation.mapping
    if (mapping) feishuIdentity(mapping.messageId)
    if (operation.effect === 'withdraw') {
      if (!mapping) feishuFailure('FEISHU_PUBLICATION_MAPPING_REQUIRED')
      return { adapterId: this.adapterId, renderVersion: this.renderVersion, requestKey: operation.operationId, request: { method: 'DELETE', path: `${path}/${encodeURIComponent(mapping.messageId)}` } }
    }
    const text = [operation.payload.text, ...(operation.payload.questions ?? []).map(question => [question.prompt, ...question.options.map(option => `- ${option.label}`)].join('\n'))].filter(Boolean).join('\n\n')
    if (!text) feishuFailure('FEISHU_PUBLICATION_CONTENT_UNSUPPORTED')
    const body = JSON.stringify({ ...(mapping ? {} : { receive_id: operation.target.externalConversationId }), msg_type: 'post', content: post(text), ...(mapping ? {} : { uuid: key(operation.operationId) }) })
    // The platform limit applies after both JSON encodings, including exact target and envelope overhead.
    if (Buffer.byteLength(body) > 30 * 1024) feishuFailure('FEISHU_PUBLICATION_REQUEST_TOO_LARGE')
    return { adapterId: this.adapterId, renderVersion: this.renderVersion, requestKey: operation.operationId, request: {
      method: mapping ? 'PUT' : 'POST', path: mapping ? `${path}/${encodeURIComponent(mapping.messageId)}` : path,
      ...(mapping ? {} : { query: { receive_id_type: 'chat_id' } }), contentType: 'application/json', body
    } }
  }
  private valid(prepared: PreparedPublication, target: PublicationTarget, mapping?: Readonly<PublicationMapping>): boolean {
    try {
      parsePreparedPublication(prepared, this)
      if (prepared.request.body !== undefined && Buffer.byteLength(prepared.request.body) > 30 * 1024) return false
      if (mapping) return prepared.request.path === `${path}/${encodeURIComponent(feishuIdentity(mapping.messageId))}` &&
        prepared.request.query === undefined && (prepared.request.method === 'DELETE' && prepared.request.body === undefined || prepared.request.method === 'PUT' && prepared.request.contentType === 'application/json' && requestText(prepared) !== null)
      const body = object(JSON.parse(prepared.request.body!))
      return prepared.request.method === 'POST' && prepared.request.path === path && prepared.request.contentType === 'application/json' && prepared.request.query?.receive_id_type === 'chat_id' &&
        body?.receive_id === target.externalConversationId && body.uuid === key(prepared.requestKey) && body.msg_type === 'post' && requestText(prepared) !== null
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
      const result = object(response), failed = failure(status, result?.code)
      if (failed) return failed
      const data = object(result?.data)
      if (!data || !consistent(data, target, mapping)) return unknown()
      if (prepared.request.method === 'DELETE') return mapping ? { state: 'confirmed', mapping: { ...mapping } } : unknown()
      const messageId = feishuIdentity(data.message_id)
      if (data.chat_id !== target.externalConversationId || data.msg_type !== undefined && data.msg_type !== 'post') return unknown()
      const body = object(data.body)
      if (body?.content !== undefined && !samePost(body.content, requestText(prepared)!)) return unknown()
      if (mapping) return { state: 'confirmed', mapping: { ...mapping } }
      const threadId = data.thread_id === undefined ? undefined : feishuIdentity(data.thread_id)
      return { state: 'confirmed', mapping: { messageId, ...(threadId === undefined ? {} : { threadId }) } }
    } catch { return unknown() }
  }
  async inspect(prepared: PreparedPublication, target: PublicationTarget, credential: string, signal: AbortSignal, mapping?: Readonly<PublicationMapping>): Promise<PublicationReceipt | null> {
    // No supported lookup by uuid exists. A missing create ID, including after dedup expiry, stays unknown.
    if (!mapping || !this.valid(prepared, target, mapping)) return null
    try {
      let status: number | undefined
      const response = await this.clients.withClient(target, credential, client => client.request<unknown>({ url: `${path}/${encodeURIComponent(mapping.messageId)}`, method: 'GET', params: { user_id_type: 'open_id' }, validateStatus: value => { status = value; return true }, signal }), signal)
      const result = object(response), items = object(result?.data)?.items
      if (result?.code !== 0 || status !== undefined && (status < 200 || status >= 300) || !Array.isArray(items)) return null
      const matches = items.map(object).filter(item => item?.message_id === mapping.messageId)
      if (matches.length !== 1) return null
      const original = matches[0]!
      if (original.deleted !== undefined && typeof original.deleted !== 'boolean' || original.chat_id !== target.externalConversationId || !ownSender(original.sender, target.application) || original.thread_id !== undefined && original.thread_id !== mapping.threadId) return null
      if (prepared.request.method === 'DELETE') return original.deleted === true ? { state: 'confirmed', mapping: { ...mapping } } : null
      return original.deleted !== true && original.msg_type === 'post' && samePost(object(original.body)?.content, requestText(prepared)!) ? { state: 'confirmed', mapping: { ...mapping } } : null
    } catch { return null }
  }
}
