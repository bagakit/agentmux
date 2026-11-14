import { AgentMuxError } from '@agentmux/core'
import { parseConnectionApiRequest, type ConnectionApiRequest } from '@agentmux/core/connections'
import type { ConnectionApiAdapter } from '../../connection-api-adapter.js'
import type { TelegramClient } from './client.js'

export const TELEGRAM_API_DESCRIPTION: ConnectionApiAdapter['description'] = {
  documentationUrl: 'https://core.telegram.org/bots/api', requestFormats: ['json'], responseFormats: ['json']
}
export function validateTelegramApiRequest(value: ConnectionApiRequest): void {
  const input = parseConnectionApiRequest(value)
  if (input.method !== 'POST' || !/^\/[a-z][a-zA-Z0-9]*$/u.test(input.path) || input.files?.length || input.query || /^\/(?:getUpdates|getWebhookInfo|setWebhook|deleteWebhook|logOut|close|getManagedBotToken|replaceManagedBotToken)$/iu.test(input.path))
    throw new AgentMuxError('Telegram credential and receiver lifecycle operations belong to their original Host owners. This native business format is unavailable.', 'CONNECTION_API_ENDPOINT_UNAVAILABLE')
}
export function createTelegramApi(client: TelegramClient): ConnectionApiAdapter {
  return { description: TELEGRAM_API_DESCRIPTION, validate: validateTelegramApiRequest,
    async request(config, credential, request, context) {
      validateTelegramApiRequest(request); context.protect(credential); await client.identity(config, credential)
      const result = await client.call(credential, request.path.slice(1), request.body)
      return { status: result.status, body: { format: 'json', value: result.data as import('@agentmux/core/connections').ConnectionApiJson } }
    } }
}
