import { afterEach, describe, expect, it } from 'vitest'
import { AgentHookServer } from '../src/hook-server.js'
import type { NativeHookEnvelope } from '../src/types.js'

const servers: AgentHookServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.stop()))
})

describe('AgentHookServer', () => {
  it('serializes concurrent starts so a losing bind cannot orphan the healthy listener', async () => {
    const server = new AgentHookServer(() => {}, 0)
    servers.push(server)
    const [first, second] = await Promise.all([server.start(), server.start()])
    expect(first).toEqual(second)
    expect(server.isRunning()).toBe(true)
  })

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
      providerId: 'claude',
      receiptId: 'receipt-permission-1',
      eventName: 'PermissionRequest'
    })
    // payload 单独钉，且用 toEqual 不用上面那个 toMatchObject：整个事件的**正文**都在这里——
    // tool_name、tool_input、session_id、用量，下游全靠它。而 toMatchObject 看不见一个**缺失**的
    // 键，所以把那句 `...(payload === undefined ? {} : { payload })` 改成永远不带 payload，
    // 这个文件 13 条照旧全绿（实测）。正文是承重的，得有人按取值质询它。
    expect(events[0]!.payload).toEqual({ tool_name: 'Bash', tool_input: { command: 'pnpm test' } })
  })

  it('不带 payload 的事件不凭空造一个空正文', async () => {
    // 上面那条钉住"有正文时要带过来"，这条钉住另一侧：缺席是一等公民的事实。把那句改成无条件
    // `{ payload: event.payload }`，正文就会变成一个 `undefined` 键——下游读 payload 的地方从
    // "这个事件没有正文"变成"正文是 undefined"，是两件不同的事。
    const events: NativeHookEnvelope[] = []
    const server = new AgentHookServer((event) => {
      events.push(event)
    }, 0)
    servers.push(server)
    await server.start()
    const binding = server.createBinding('semantic-2', 'claude')
    const response = await fetch(binding.endpoint.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${binding.endpoint.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ receiptId: 'receipt-bare-1', eventName: 'Stop' })
    })
    expect(response.status).toBe(204)
    await binding.bindRun('daemon-2')
    expect(events).toHaveLength(1)
    expect(Object.hasOwn(events[0]!, 'payload')).toBe(false)
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

  it('keeps a closing binding visible to server drain ownership', async () => {
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
    const binding = server.createBinding('semantic-close-drain', 'codex')
    await binding.bindRun('run-close-drain')
    const response = fetch(binding.endpoint.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${binding.endpoint.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ receiptId: 'close-drain-receipt' })
    })
    await started
    let stopped = false
    const closing = binding.close()
    const stopping = server.stop().then(() => { stopped = true })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(stopped).toBe(false)

    releaseObservation()
    expect((await response).status).toBe(204)
    await Promise.all([closing, stopping])
    expect(stopped).toBe(true)
  })

  it('bounds shutdown when an accepted owner delivery never settles', async () => {
    let observationStarted!: () => void
    const started = new Promise<void>((resolve) => { observationStarted = resolve })
    let aborted = false
    const server = new AgentHookServer(async (_event, signal) => {
      observationStarted()
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true
          reject(signal.reason)
        }, { once: true })
      })
    }, 0)
    servers.push(server)
    await server.start()
    const binding = server.createBinding('semantic-timeout', 'codex')
    await binding.bindRun('run-timeout')
    const response = fetch(binding.endpoint.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${binding.endpoint.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ receiptId: 'timeout-receipt', eventName: 'Stop' })
    })
    await started

    const before = Date.now()
    await server.stop()
    expect(Date.now() - before).toBeLessThan(3_000)
    expect((await response).status).toBe(503)
    expect(aborted).toBe(true)
  })

  it('queues every pre-bind event before accepting bound delivery', async () => {
    let releaseFirst!: () => void
    let firstStarted!: () => void
    const release = new Promise<void>((resolve) => { releaseFirst = resolve })
    const started = new Promise<void>((resolve) => { firstStarted = resolve })
    const receipts: string[] = []
    const server = new AgentHookServer(async (event) => {
      receipts.push(event.receiptId)
      if (event.receiptId === 'before-0') {
        firstStarted()
        await release
      }
    }, 0)
    servers.push(server)
    await server.start()
    const binding = server.createBinding('semantic-order', 'codex')
    const request = async (receiptId: string) => await fetch(binding.endpoint.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${binding.endpoint.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ receiptId })
    })
    expect((await request('before-0')).status).toBe(204)
    expect((await request('before-1')).status).toBe(204)

    const bind = binding.bindRun('run-order')
    await started
    const live = request('live')
    releaseFirst()

    await bind
    expect((await live).status).toBe(204)
    expect(receipts).toEqual(['before-0', 'before-1', 'live'])
  })

  it('keeps the same token retryable after an abort-aware delivery timeout', async () => {
    let attempts = 0
    const server = new AgentHookServer(async (_event, signal) => {
      attempts += 1
      if (attempts !== 1) return
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }, 0)
    servers.push(server)
    await server.start()
    const binding = server.createBinding('semantic-retry', 'codex')
    await binding.bindRun('run-retry')
    const request = async () => await fetch(binding.endpoint.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${binding.endpoint.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ receiptId: 'retry-receipt', eventName: 'Stop' })
    })

    expect((await request()).status).toBe(503)
    expect((await request()).status).toBe(204)
    expect(attempts).toBe(2)
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

  it('rejects oversized bodies before parsing an envelope', async () => {
    const server = new AgentHookServer(() => {}, 0)
    servers.push(server)
    await server.start()
    const binding = server.createBinding('semantic-oversized', 'codex')
    const response = await fetch(binding.endpoint.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${binding.endpoint.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ receiptId: 'oversized', payload: { value: 'x'.repeat(128 * 1024) } })
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_hook_envelope' })
  })

  it('caps unbound events and bound delivery work independently', async () => {
    let releaseObservation!: () => void
    let observationStarted!: () => void
    const release = new Promise<void>((resolve) => { releaseObservation = resolve })
    const started = new Promise<void>((resolve) => { observationStarted = resolve })
    const events: NativeHookEnvelope[] = []
    const server = new AgentHookServer(async (event) => {
      events.push(event)
      observationStarted()
      await release
    }, 0)
    servers.push(server)
    await server.start()
    const binding = server.createBinding('semantic-bounded', 'codex')
    const request = (receiptId: string) => fetch(binding.endpoint.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${binding.endpoint.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ receiptId, eventName: 'Stop' })
    })

    for (let index = 0; index < 8; index += 1) {
      expect((await request(`unbound-${index}`)).status).toBe(204)
    }
    expect((await request('unbound-overflow')).status).toBe(429)
    const bind = binding.bindRun('run-bounded')
    await started
    releaseObservation()
    await bind
    expect(events).toHaveLength(8)

    let releaseFlood!: () => void
    let floodStarted!: () => void
    const floodRelease = new Promise<void>((resolve) => { releaseFlood = resolve })
    const floodStart = new Promise<void>((resolve) => { floodStarted = resolve })
    const floodServer = new AgentHookServer(async () => {
      floodStarted()
      await floodRelease
    }, 0)
    servers.push(floodServer)
    await floodServer.start()
    const floodBinding = floodServer.createBinding('semantic-flood', 'claude')
    await floodBinding.bindRun('run-flood')
    const flood = Array.from({ length: 9 }, (_, index) => fetch(floodBinding.endpoint.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${floodBinding.endpoint.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ receiptId: `flood-${index}` })
    }))
    await floodStart
    await new Promise((resolve) => setTimeout(resolve, 20))
    releaseFlood()
    expect((await Promise.all(flood)).map((response) => response.status).sort()).toEqual([
      204, 204, 204, 204, 204, 204, 204, 204, 429
    ])
  })

  it('caps bindings and keeps bearer tokens scoped to one binding', async () => {
    const events: NativeHookEnvelope[] = []
    const server = new AgentHookServer((event) => { events.push(event) }, 0)
    servers.push(server)
    await server.start()
    const bindings = Array.from({ length: 256 }, (_, index) => (
      server.createBinding(`semantic-${index}`, index % 2 === 0 ? 'codex' : 'claude')
    ))
    expect(() => server.createBinding('semantic-overflow', 'pi')).toThrowError(
      expect.objectContaining({ code: 'HOOK_BINDING_LIMIT' })
    )

    await Promise.all(bindings.slice(0, 2).map(async (binding, index) => {
      await binding.bindRun(`run-${index}`)
      const response = await fetch(binding.endpoint.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${binding.endpoint.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ receiptId: `scoped-${index}` })
      })
      expect(response.status).toBe(204)
    }))
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentSessionId: 'semantic-0', runId: 'run-0', receiptId: 'scoped-0' }),
      expect.objectContaining({ agentSessionId: 'semantic-1', runId: 'run-1', receiptId: 'scoped-1' })
    ]))
    expect(JSON.stringify(events)).not.toContain(bindings[0]!.endpoint.token)
  })

  it('does not derive a bearer token from the stable binding identity', async () => {
    const server = new AgentHookServer(() => {}, 0)
    servers.push(server)
    await server.start()
    const bindingId = 'a'.repeat(43)
    const first = server.createBinding('semantic-secret', 'codex', bindingId)
    const firstToken = first.endpoint.token
    await first.close()
    const second = server.createBinding('semantic-secret', 'codex', bindingId)

    expect(firstToken).not.toBe(second.endpoint.token)
    expect(firstToken).not.toBe(bindingId)
  })
})
