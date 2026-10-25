import { createServer } from 'node:http'
import { vi } from 'vitest'
import { defaultHttpInstance, type HttpInstance } from '@larksuiteoapi/node-sdk'
import { feishuConfig } from './feishu.js'

/** Real SDK serialization and loopback HTTP; only the platform transport is controlled. */
export async function feishuMediaPlatform() {
  const controls: { missingUploadKey?: boolean; unknownImageMessage?: boolean; rejectImageMessage?: boolean; beforeUpload?: ((bytes: Buffer, index: number) => Promise<void>) | undefined;
    beforeMessageRead?: () => Promise<void>; rejectCardCreate?: boolean; unknownCardCreate?: boolean; beforeCardCreate?: () => Promise<void>;
    beforeCardUpdate?: (sequence: number, element: boolean) => Promise<void>; unknownPortrait?: boolean; unknownCardBody?: boolean; deferCardBody?: Promise<void> } = {}
  const uploads: Buffer[] = [], calls: Array<{ method: string; path: string; body: unknown }> = [], messages = new Map<string, Record<string, unknown>>()
  const cards = new Map<string, { content: Record<string, unknown>; sequence: number }>(), messageCards = new Map<string, string>()
  const pendingCardBodies: Promise<void>[] = []
  const replaceElement = (value: unknown, id: string, next: Record<string, unknown>): boolean => {
    if (!value || typeof value !== 'object') return false
    for (const [key, child] of Object.entries(value)) {
      if (child && typeof child === 'object' && (child as Record<string, unknown>).element_id === id) { (value as Record<string, unknown>)[key] = next; return true }
      if (replaceElement(child, id, next)) return true
    }
    return false
  }
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const bytes = Buffer.concat(chunks), path = new URL(request.url!, 'http://loopback').pathname
      let result: unknown
      if (path.includes('/auth/v3/')) result = { code: 0, tenant_access_token: 'fixture-image-access', expire: 3600 }
      else if (path.endsWith('/callback/ws/endpoint')) result = { code: 0, data: { URL: 'wss://msg-frontier.feishu.cn/ws/v2?device_id=original&service_id=1', ClientConfig: { PingInterval: 30, ReconnectCount: 0, ReconnectInterval: 1, ReconnectNonce: 0 } } }
      else if (path.endsWith('/bot/v3/info')) result = { code: 0, bot: { open_id: 'original-bot-open-id' } }
      else if (path === '/open-apis/im/v1/images') {
        const boundary = /boundary=([^;]+)/u.exec(String(request.headers['content-type']))?.[1]
        if (!boundary) throw new Error('Official SDK multipart boundary required')
        const field = bytes.indexOf('name="image"'), start = bytes.indexOf('\r\n\r\n', field) + 4, end = bytes.indexOf('\r\n--' + boundary, start)
        if (field < 0 || start < 4 || end < start || !bytes.includes(Buffer.from('name="image_type"\r\n\r\nmessage'))) throw new Error('Original multipart image fields required')
        uploads.push(bytes.subarray(start, end)); const index = uploads.length; await controls.beforeUpload?.(uploads[index - 1]!, index)
        result = { code: 0, data: controls.missingUploadKey ? {} : { image_key: 'original-image-key-' + index } }
      } else if (path.startsWith('/open-apis/cardkit/v1/cards')) {
        const body = JSON.parse(bytes.toString('utf8')), pieces = path.split('/'), id = pieces[5], element = pieces[6] === 'elements'
        calls.push({ method: request.method!, path, body })
        if (request.method === 'POST') {
          await controls.beforeCardCreate?.()
          const card = JSON.parse(body.data)
          if (controls.rejectCardCreate) result = { code: 300311 }
          else if (body.type !== 'card_json' || card.schema !== '2.0') result = { code: 10002 }
          else { const cardId = String(cards.size + 1); cards.set(cardId, { content: card, sequence: 0 }); result = controls.unknownCardCreate ? { code: 230049 } : { code: 0, data: { card_id: cardId } } }
        } else {
          await controls.beforeCardUpdate?.(body.sequence, element)
          const apply = () => {
            const card = id ? cards.get(id) : undefined
            if (!card) return { code: 200740 }
            if (!Number.isSafeInteger(body.sequence) || body.sequence <= card.sequence) return { code: 300317 }
            const next = JSON.parse(element ? body.element : body.card.data)
            if (element ? !replaceElement(card.content, pieces[7]!, next) : body.card.type !== 'card_json' || next.schema !== '2.0') return { code: 10002 }
            if (!element) card.content = next
            card.sequence = body.sequence
            for (const [messageId, cardId] of messageCards) if (cardId === id) messages.get(messageId)!.body = { content: JSON.stringify(card.content) }
            return element && controls.unknownPortrait || !element && controls.unknownCardBody ? { code: 230049 } : { code: 0, data: {} }
          }
          if (!element && controls.deferCardBody) { pendingCardBodies.push(controls.deferCardBody.then(() => { apply() })); result = { code: 230049 } }
          else result = apply()
        }
      } else {
        const id = path.split('/').at(-1)!, original = messages.get(id), body = bytes.length ? JSON.parse(bytes.toString('utf8')) : undefined
        calls.push({ method: request.method!, path, body })
        if (request.method === 'GET') { await controls.beforeMessageRead?.(); result = { code: 0, data: { items: original ? [original] : [] } } }
        else if (request.method === 'DELETE') { if (original) original.deleted = true; result = { code: 0, data: {} } }
        else {
          const messageId = request.method === 'POST' ? 'original-message-' + (messages.size + 1) : id
          const content = JSON.parse(body.content), entity = content.type === 'card' ? content.data.card_id : undefined
          if (entity) { if (!cards.has(entity) || [...messageCards.values()].includes(entity)) throw Error('A native entity must exist and be sent only once'); messageCards.set(messageId, entity) }
          const message = { message_id: messageId, chat_id: body.receive_id ?? original?.chat_id, msg_type: body.msg_type ?? original?.msg_type,
            sender: { sender_type: 'app', id_type: 'app_id', id: feishuConfig.application.appId }, deleted: false, body: { content: JSON.stringify(entity ? cards.get(entity)!.content : body.msg_type === 'interactive' || original?.msg_type === 'interactive' ? content : content.zh_cn) } }
          if (!controls.rejectImageMessage || !body.content.includes('img_key')) messages.set(messageId, message)
          result = body.content.includes('img_key') && controls.rejectImageMessage ? { code: 230025 } : controls.unknownImageMessage && body.content.includes('img_key') ? { code: 230049 } : { code: 0, data: message }
        }
      }
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result))
    } catch { response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ code: 230001 })) }
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const close = async () => { server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())) }
  const port = (server.address() as { port: number }).port, request = defaultHttpInstance.request.bind(defaultHttpInstance) as HttpInstance['request']
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(options => {
    const url = new URL(options.url!)
    if (!['https://open.feishu.cn', 'https://open.larksuite.com'].includes(url.origin)) throw new Error('Original official SDK endpoint required')
    const { params, ...original } = options
    if (params !== undefined && (params === null || typeof params !== 'object')) throw new Error('Original SDK query parameters must be a record')
    const forwarded = { ...original, ...(params === undefined ? {} : { params }), url: `http://127.0.0.1:${port}${url.pathname}${url.search}`, proxy: false, adapter: 'http' }
    return request(forwarded)
  })
  return { uploads, calls, messages, cards, pendingCardBodies, controls, close }
}

