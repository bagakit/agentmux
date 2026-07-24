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
    await server.start()
    const binding = server.createBinding('semantic-1', 'claude')
    const response = await fetch(binding.endpoint.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${binding.endpoint.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        eventName: 'PermissionRequest',
        payload: { tool_name: 'Bash', tool_input: { command: 'pnpm test' } }
      })
    })
    expect(response.status).toBe(204)
    expect(events).toHaveLength(0)
    await binding.bindRun('daemon-1')
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
    server.createBinding('semantic-1', 'claude')
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        eventName: 'SessionStart'
      })
    })
    expect(response.status).toBe(403)
  })
})
