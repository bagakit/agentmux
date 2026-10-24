import { AgentMuxError } from '@agentmux/core'
import { parseConnectionApiRequest, type ConnectionApiDescription, type ConnectionApiRequest } from '@agentmux/core/connections'
import type { ConnectionApiAdapter } from '../../connection-api-adapter.js'
import type { DiscordClients } from './client.js'

const unavailable = (): never => { throw new AgentMuxError('This native Discord path or request format is unavailable.', 'CONNECTION_API_ENDPOINT_UNAVAILABLE') }
export const DISCORD_API_DESCRIPTION: ConnectionApiDescription = { documentationUrl: 'https://discord.com/developers/docs/reference', requestFormats: ['json', 'multipart'], responseFormats: ['json', 'empty'] }
export function validateDiscordApiRequest(value: ConnectionApiRequest): ConnectionApiRequest {
  const input = parseConnectionApiRequest(value)
  if (/^\/(?:api|auth|oauth2|webhooks)(?:\/|$)/iu.test(input.path) ||
      /^\/(?:channels|guilds)\/[^/]+\/webhooks(?:\/|$)/iu.test(input.path) ||
      /^\/applications\/[^/]+\/(?:bot|tokens|credentials|secrets)(?:\/|$)/iu.test(input.path) ||
      /^\/users\/@me\/(?:connections|applications|mfa|sessions|settings|billing|devices)(?:\/|$)/iu.test(input.path)) return unavailable()
  const body = input.body
  if (input.path.toLowerCase() === '/users/@me' && (input.method !== 'GET' && input.method !== 'PATCH' ||
      body && typeof body === 'object' && !Array.isArray(body) && ['password', 'email', 'token', 'new_password'].some(key => Object.hasOwn(body, key)))) return unavailable()
  if (input.method === 'GET' && (input.body !== undefined || input.files?.length)) return unavailable()
  return input
}

export function createDiscordApi(clients: DiscordClients): ConnectionApiAdapter {
  return {
    description: DISCORD_API_DESCRIPTION,
    validate(value) { validateDiscordApiRequest(value) },
    async request(config, credential, value, context) { return await clients.requestApi(config, credential, validateDiscordApiRequest(value), context.protect) }
  }
}
