import { createServer, type ServerResponse } from 'node:http'
import type { TelegramMessage, TelegramUpdate } from '../../src/adapters/telegram/protocol.js'

export const telegramConfig = { connectionId: 'telegram-connection', adapterId: 'telegram', application: { domain: 'telegram.org', appId: '100' }, label: 'Telegram bot', enabled: true, credentialRef: 'telegram-credential' }
export const telegramCredential = '100:fixture-token'
/** Actual HTTP Bot API wire shape; only the remote service is controlled. */
export async function telegramTransport() {
  const updates: TelegramUpdate[] = [], calls: Array<{ method: string; body: Record<string, any> }> = [], messages = new Map<string, TelegramMessage>()
  const updateOwners = new Map<number, number>()
  const batchBytes: number[] = []
  const waiting = new Map<ServerResponse, () => void>()
  let updateId = 10, messageId = 700, changedBotId: number | undefined, webhook = false, loseSend = false, identityStatus = 200, pollsPaused = false
  const bot = (nativeBotId = 100) => ({ id: changedBotId ?? nativeBotId, is_bot: true, first_name: 'Original Telegram bot', username: 'original_bot', can_read_all_group_messages: true })
  const reply = (response: ServerResponse, status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const path = new URL(request.url!, 'http://native').pathname, method = path.split('/').at(-1)!, body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    const nativeBotId = Number(/^\/bot([0-9]+):/u.exec(path)?.[1])
    calls.push({ method, body })
    if (method === 'getMe' && identityStatus !== 200) return reply(response, identityStatus, { ok: false, error_code: identityStatus })
    if (method === 'getMe') return reply(response, 200, { ok: true, result: bot(nativeBotId) })
    if (method === 'getUpdates') {
      if (webhook) return reply(response, 409, { ok: false, error_code: 409, description: 'Webhook is active' })
      const flush = () => {
        if (pollsPaused) return
        if (response.destroyed || response.writableEnded) { waiting.delete(response); return }
        const result = updates.filter(update => updateOwners.get(update.update_id) === nativeBotId && (body.offset === undefined || update.update_id >= body.offset)).slice(0, 100)
        if (!response.destroyed) { const payload = { ok: true, result }; batchBytes.push(Buffer.byteLength(JSON.stringify(payload))); reply(response, 200, payload) }
        waiting.delete(response)
      }
      waiting.set(response, flush)
      const current = updates.some(update => updateOwners.get(update.update_id) === nativeBotId && (body.offset === undefined || update.update_id >= body.offset))
      if (current || body.timeout === 0) return flush()
      const timer = setTimeout(flush, 100); timer.unref(); waiting.set(response, flush)
      response.once('close', () => { clearTimeout(timer); waiting.delete(response) })
      return
    }
    if (method === 'getChat') return reply(response, 200, { ok: true, result: { id: Number(body.chat_id), type: 'supergroup', title: 'Original Telegram group' } })
    if (method === 'getManagedBotToken' || method === 'replaceManagedBotToken') return reply(response, 200, { ok: true, result: '987:synthetic-managed-bot-credential' })
    if (method === 'createChatInviteLink') return reply(response, 200, { ok: true, result: { invite_link: 'https://t.me/+original-invite', expire_date: body.expire_date } })
    const chatId = String(body.chat_id), originalKey = chatId + ':' + body.message_id
    if (method === 'deleteMessage') {
      if (!messages.delete(originalKey)) return reply(response, 400, { ok: false, error_code: 400 })
      return reply(response, 200, { ok: true, result: true })
    }
    if (method === 'sendMessage' || method === 'editMessageText') {
      if (typeof body.text !== 'string' || !body.text.length || body.text.length > 4096) return reply(response, 400, { ok: false, error_code: 400 })
      const original = messages.get(originalKey)
      if (method === 'editMessageText' && !original) return reply(response, 400, { ok: false, error_code: 400 })
      const result: TelegramMessage = { ...(original ?? {}), message_id: original?.message_id ?? ++messageId, chat: { id: Number(chatId), type: 'supergroup' }, from: bot(nativeBotId), date: Math.floor(Date.now() / 1000), text: body.text,
        ...(body.message_thread_id === undefined ? {} : { message_thread_id: body.message_thread_id }) }
      messages.set(chatId + ':' + result.message_id, result)
      if (loseSend && method === 'sendMessage') { loseSend = false; request.socket.destroy(); return }
      return reply(response, 200, { ok: true, result })
    }
    return reply(response, 404, { ok: false, error_code: 404 })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return { origin, calls, updates, messages, batchBytes,
    message(text = 'Original Telegram input', options: { chatId?: number; chatType?: 'private' | 'supergroup'; messageId?: number; updateId?: number; mention?: boolean; unsupported?: boolean; actorId?: number; botId?: number } = {}) {
      const message: TelegramMessage = { message_id: options.messageId ?? ++messageId, chat: { id: options.chatId ?? -300, type: options.chatType ?? 'supergroup' }, from: { id: options.actorId ?? 400, is_bot: false, first_name: 'Original person' },
        date: Math.floor(Date.now() / 1000), text: options.mention === false ? text : '@original_bot ' + text, entities: options.mention === false ? [] : [{ type: 'mention', offset: 0, length: 13 }], ...(options.unsupported ? { photo: [{ file_id: 'native-photo' }] } : {}) }
      const update: TelegramUpdate = { update_id: options.updateId ?? ++updateId, message }; updates.push(update); updateOwners.set(update.update_id, options.botId ?? 100)
      for (const flush of [...waiting.values()]) flush()
      return update
    },
    replay(update: TelegramUpdate) { updates.push(structuredClone(update)); for (const flush of [...waiting.values()]) flush() },
    pausePolls() { pollsPaused = true },
    resumePolls() { pollsPaused = false; for (const flush of [...waiting.values()]) flush() },
    identityStatus(status: number) { identityStatus = status },
    webhook(active: boolean) { webhook = active }, changeBot(id: number) { changedBotId = id }, loseNextSend() { loseSend = true },
    async close() { for (const response of waiting.keys()) response.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  }
}
