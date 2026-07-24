import { afterEach, describe, expect, it } from 'vitest'
import { AgentHookServer } from '../src/hook-server.js'
import type { NativeHookEnvelope } from '../src/types.js'

const servers: AgentHookServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.stop()))
})

describe('AgentHookServer', () => {
  it('accepts authenticated loopback events without interpreting provider semantics', async () => {
    const events: NativeHookEnvelope[] = []
    const server = new AgentHookServer((event) => {
      events.push(event)
    })
    servers.push(server)
    const endpoint = await server.start()
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${endpoint.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        agentSessionId: 'semantic-1',
        runId: 'daemon-1',
        agentId: 'claude',
        eventName: 'PermissionRequest',
        payload: { tool_name: 'Bash', tool_input: { command: 'pnpm test' } }
      })
    })
    expect(response.status).toBe(204)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      agentSessionId: 'semantic-1',
      runId: 'daemon-1',
      agentId: 'claude',
      eventName: 'PermissionRequest'
    })
  })

  it('rejects requests without the bearer token', async () => {
    const server = new AgentHookServer(() => {})
    servers.push(server)
    const endpoint = await server.start()
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentSessionId: 'semantic-1',
        runId: 'daemon-1',
        agentId: 'claude'
      })
    })
    expect(response.status).toBe(403)
  })
})
