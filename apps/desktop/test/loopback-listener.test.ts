import { afterEach, describe, expect, it } from 'vitest'
import type { ServerResponse } from 'node:http'
import { LoopbackListener } from '../src/main/loopback-listener'

const listeners: LoopbackListener[] = []
afterEach(async () => { await Promise.all(listeners.splice(0).map(listener => listener.close())) })
const unavailable = () => new Error('listener unavailable')
function listener(handle: (response: ServerResponse) => void = response => response.end('ok')): LoopbackListener {
  const created = new LoopbackListener((_request, response) => handle(response), unavailable)
  listeners.push(created)
  return created
}

describe('loopback listener', () => {
  it('binds only the IPv4 loopback address and shares one port across concurrent starts', async () => {
    const shared = listener()
    expect(shared.host).toBeNull()
    const [first, second] = await Promise.all([shared.start(), shared.start()])
    expect(new URL(first).hostname).toBe('127.0.0.1')
    expect(second).toBe(first)
    expect(shared.host).toBe(new URL(first).host)
    expect(await (await fetch(first)).text()).toBe('ok')
  })

  it('never starts again once closed', async () => {
    const closed = listener()
    await closed.close()
    await expect(closed.start()).rejects.toThrow('listener unavailable')
    expect(closed.host).toBeNull()
  })

  it('a close during startup leaves nothing listening', async () => {
    const racing = listener()
    const starting = racing.start()
    await racing.close()
    await expect(starting).rejects.toThrow('listener unavailable')
    expect(racing.host).toBeNull()
  })

  it('a close ends replies that are still open instead of waiting for them', async () => {
    let arrived!: () => void
    const held = new Promise<void>(resolve => { arrived = resolve })
    const holding = listener(() => arrived())
    const origin = await holding.start()
    const request = fetch(origin).then(() => 'answered', () => 'ended')
    await held
    const closing = holding.close().then(() => 'closed')
    expect(await Promise.race([closing, new Promise(resolve => setTimeout(resolve, 1_000, 'still waiting'))])).toBe('closed')
    expect(await request).toBe('ended')
    await expect(fetch(origin)).rejects.toThrow()
  })
})
