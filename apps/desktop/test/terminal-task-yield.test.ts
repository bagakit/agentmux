import { afterEach, expect, it, vi } from 'vitest'

const OriginalMessageChannel = globalThis.MessageChannel
const channels: MessageChannel[] = []
afterEach(() => {
  for (const channel of channels.splice(0)) { channel.port1.close(); channel.port2.close() }
  vi.unstubAllGlobals()
})

async function measuredOwner() {
  vi.resetModules()
  let tasks = 0
  vi.stubGlobal('MessageChannel', class {
    constructor() {
      const channel = new OriginalMessageChannel()
      channel.port1.addEventListener('message', () => { tasks++ })
      channels.push(channel)
      return channel
    }
  })
  const owner = await import('@agentmux/client-ui/terminal/replay')
  return { ...owner, task: () => tasks }
}

it('uses one lazy channel and a separate real task for every FIFO continuation', async () => {
  const owner = await measuredOwner()
  expect(channels).toHaveLength(0)
  const seen: Array<[string, number]> = []
  let nested: Promise<void> | undefined
  const first = owner.yieldTerminalWork().then(() => {
    seen.push(['first', owner.task()])
    queueMicrotask(() => { seen.push(['microtask', owner.task()]) })
    nested = owner.yieldTerminalWork().then(() => { seen.push(['nested', owner.task()]) })
  })
  const second = owner.yieldTerminalWork().then(() => { seen.push(['second', owner.task()]) })
  const third = owner.yieldTerminalWork().then(() => { seen.push(['third', owner.task()]) })
  await Promise.all([first, second, third]); await nested
  expect(seen).toEqual([['first', 1], ['microtask', 1], ['second', 2], ['third', 3], ['nested', 4]])
  expect(channels).toHaveLength(1)
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(owner.task()).toBe(4)
  await owner.yieldTerminalWork()
  expect(owner.task()).toBe(5)
  expect(channels).toHaveLength(1)
})

it('keeps exact replay bytes, parser batch bounds and raw byte cursor through shared tasks', async () => {
  const owner = await measuredOwner()
  const bytes = new TextEncoder().encode('A'.repeat(owner.TERMINAL_REPLAY_BATCH_BYTES) + '中\x1b[31mTAIL')
  const writes: Uint8Array[] = []
  const cursor = await owner.hydrateTerminalReplay([{ dataBytes: bytes, endByte: 17 + bytes.length }],
    async data => { writes.push(data.slice()) })
  expect(Buffer.concat(writes)).toEqual(Buffer.from(bytes))
  expect(writes).toHaveLength(2)
  expect(writes.every(data => data.byteLength <= owner.TERMINAL_REPLAY_BATCH_BYTES)).toBe(true)
  expect(cursor).toBe(17 + bytes.length)
  expect(owner.task()).toBe(2)
  expect(channels).toHaveLength(1)
})
