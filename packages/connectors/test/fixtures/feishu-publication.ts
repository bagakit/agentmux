import { createServer } from 'node:http'
import { defaultHttpInstance, type HttpInstance, type HttpRequestOptions } from '@larksuiteoapi/node-sdk'
import { feishuConfig, botOpenId } from './feishu.js'

export type FeishuHttpCall = { method: string; path: string; query: Record<string, string>; body: string }
export type FeishuHttpResponse = { status: number; body: unknown }
/** Native columns retain ordered text; original-card reads still return exact authored JSON. */
export function feishuCardElements(card: { elements?: any[]; body?: { elements?: any[] } }): any[] {
  const visit = (elements: any[]): any[] => elements.flatMap(element => element.tag === 'column_set'
    ? element.columns.flatMap((column: { elements: any[] }) => visit(column.elements)) : [element])
  return visit(card.elements ?? card.body?.elements ?? [])
}
// The native message reading format is not the authored card JSON. Retain the
// original in the fixture so only an explicit original-card GET can return it.
function receivedMessage(message: Record<string, unknown>): Record<string, unknown> {
  if (message.msg_type !== 'interactive' || !message.body) return message
  const card = JSON.parse((message.body as { content: string }).content)
  const elements = feishuCardElements(card)
  return { ...message, body: { content: JSON.stringify({ title: card.header?.title?.content ?? '', elements: elements.flatMap(element => {
    const text = element.tag === 'div' ? element.text?.content : element.tag === 'markdown' ? element.content : undefined
    return text === undefined ? [] : [[{ tag: 'text', text }]]
  }) }) } }
}
/** Actual SDK/Axios serialization reaches this loopback server; only the remote platform port is substituted. */
export async function feishuPublicationHttp(override?: (call: FeishuHttpCall) => FeishuHttpResponse | undefined) {
  const calls: FeishuHttpCall[] = [], origins: string[] = [], records = new Map<string, Record<string, unknown>>(), uuids = new Map<string, string>()
  let next = 0
  const server = createServer(async (request, response) => {
    try {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const url = new URL(request.url!, 'http://loopback'), call = { method: request.method!, path: url.pathname, query: Object.fromEntries(url.searchParams), body: Buffer.concat(chunks).toString('utf8') }
    calls.push(call)
    let result = override?.(call)
    if (!result) {
      if (call.path.includes('/auth/v3/')) result = { status: 200, body: { code: 0, tenant_access_token: 'fixture-tenant-access', expire: 3600 } }
      else if (call.path.endsWith('/bot/v3/info')) result = { status: 200, body: { code: 0, bot: { open_id: botOpenId } } }
      else if (call.path.endsWith('/callback/ws/endpoint')) result = { status: 200, body: { code: 0, data: { URL: 'wss://msg-frontier.feishu.cn/ws/v2?device_id=original&service_id=1', ClientConfig: { PingInterval: 30, ReconnectCount: 0, ReconnectInterval: 1, ReconnectNonce: 0 } } } }
      else {
        const id = decodeURIComponent(call.path.split('/').at(-1)!), original = records.get(id)
        if (call.method === 'GET') result = original ? { status: 200, body: { code: 0, data: { items: [call.query.card_msg_content_type === 'user_card_content' ? original : receivedMessage(original)] } } } : { status: 404, body: { code: 230050 } }
        else if (call.method === 'DELETE') {
          if (original) { records.set(id, { ...original, deleted: true, body: undefined }); result = { status: 200, body: { code: 0, data: {} } } }
          else result = { status: 404, body: { code: 230050 } }
        } else {
          const body = JSON.parse(call.body), content = JSON.parse(body.content)
          const interactive = body.msg_type === 'interactive' || original?.msg_type === 'interactive'
          const native = interactive ? content : { title: content.zh_cn.title, content: content.zh_cn.content.map((paragraph: Array<{ tag: string; text: string }>) => paragraph.map(node => ({ tag: node.tag, text: node.text, style: [] }))) }
          if (call.method === 'POST') {
            const known = uuids.get(body.uuid)
            if (known) result = { status: 200, body: { code: 0, data: receivedMessage(records.get(known)!) } }
            else {
              const messageId = 'platform-message-' + ++next
              const message = { message_id: messageId, chat_id: body.receive_id, thread_id: 'original-platform-thread', msg_type: body.msg_type, deleted: false,
                sender: { sender_type: 'app', id_type: 'app_id', id: feishuConfig.application.appId }, body: { content: JSON.stringify(native) } }
              records.set(messageId, message); uuids.set(body.uuid, messageId); result = { status: 200, body: { code: 0, data: receivedMessage(message) } }
            }
          } else if ((call.method === 'PUT' || call.method === 'PATCH') && original) {
            const updated: Record<string, unknown> = { ...original, body: { content: JSON.stringify(native) } }; records.set(id, updated)
            const { thread_id: _threadId, ...acknowledged } = updated
            result = { status: 200, body: { code: 0, data: receivedMessage(acknowledged) } }
          } else result = { status: 404, body: { code: 230050 } }
        }
      }
    }
    response.writeHead(result.status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result.body))
    } catch { response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ code: 230001 })) }
  })
  // The controlled platform stays available while the real Core reads a large
  // source-backed resource; its default idle socket expiry is not the scenario.
  server.keepAliveTimeout = 0
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()) })
  // The SDK's response interceptor returns data; retain its own HttpInstance contract at this transport boundary.
  const port = (server.address() as { port: number }).port, request = defaultHttpInstance.request.bind(defaultHttpInstance) as HttpInstance['request']
  const http = Object.create(defaultHttpInstance) as HttpInstance
  http.request = <T, R = T, D = unknown>(input: HttpRequestOptions<D>) => {
    const original = new URL(input.url!)
    if (!['https://open.feishu.cn', 'https://open.larksuite.com'].includes(original.origin)) throw new Error('Unexpected SDK application endpoint')
    origins.push(original.origin)
    const forwarded = { ...input, url: `http://127.0.0.1:${port}${original.pathname}${original.search}`, proxy: false, adapter: 'http' }
    return request<T, R, D>(forwarded)
  }
  return { http, calls, origins, records, messageCalls: () => calls.filter(call => call.path.startsWith('/open-apis/im/v1/messages')),
    async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) } }
}
