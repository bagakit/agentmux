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
    }, 0)
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
        receiptId: 'receipt-permission-1',
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
      receiptId: 'receipt-permission-1',
      eventName: 'PermissionRequest'
    })
  })

  it('acknowledges a bound hook only after owner persistence completes', async () => {
    let releaseObservation!: () => void
    let observationStarted!: () => void
    const release = new Promise<void>((resolve) => { releaseObservation = resolve })
    const started = new Promise<void>((resolve) => { observationStarted = resolve })
    const server = new AgentHookServer(async () => {
      observationStarted()
      await release
    }, 0)
    servers.push(server)
    await server.start()
    const binding = server.createBinding('semantic-1', 'codex')
    await binding.bindRun('daemon-1')
    let acknowledged = false
    const response = fetch(binding.endpoint.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${binding.endpoint.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ receiptId: 'stop-receipt-1', eventName: 'Stop' })
    }).then((value) => {
      acknowledged = true
      return value
    })
    await started
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(acknowledged).toBe(false)
    releaseObservation()
    expect((await response).status).toBe(204)
  })

  it('drains accepted hook observations before shutdown completes', async () => {
    let releaseObservation!: () => void
    let observationStarted!: () => void
    const release = new Promise<void>((resolve) => { releaseObservation = resolve })
    const started = new Promise<void>((resolve) => { observationStarted = resolve })
    const server = new AgentHookServer(async () => {
      observationStarted()
      await release
    }, 0)
    servers.push(server)
    await server.start()
    const binding = server.createBinding('semantic-1', 'codex')
    await binding.bindRun('daemon-1')
    const response = fetch(binding.endpoint.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${binding.endpoint.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ receiptId: 'stop-receipt-drain', eventName: 'Stop' })
    })
    await started
    let stopped = false
    const shutdown = server.stop().then(() => { stopped = true })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(stopped).toBe(false)
    releaseObservation()
    expect((await response).status).toBe(204)
    await shutdown
    expect(stopped).toBe(true)
  })

  it('returns a retryable failure when bound owner persistence fails', async () => {
    let attempts = 0
    const server = new AgentHookServer(() => {
      attempts += 1
      if (attempts === 1) throw new Error('store unavailable')
    }, 0)
    servers.push(server)
    await server.start()
    const binding = server.createBinding('semantic-1', 'codex')
    await binding.bindRun('daemon-1')
    const request = () => fetch(binding.endpoint.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${binding.endpoint.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ receiptId: 'stable-stop-receipt', eventName: 'Stop' })
    })
    expect((await request()).status).toBe(503)
    expect((await request()).status).toBe(204)
    expect(attempts).toBe(2)
  })

  it('rejects requests without the bearer token', async () => {
    const server = new AgentHookServer(() => {}, 0)
    servers.push(server)
    const endpoint = await server.start()
    server.createBinding('semantic-1', 'claude')
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        receiptId: 'receipt-session-1',
        eventName: 'SessionStart'
      })
    })
    expect(response.status).toBe(403)
  })
})
