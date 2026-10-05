import { fileURLToPath } from 'node:url'
import { rm } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { bridge, owningBridge } from './helpers/first-execution-ipc-bridge.js'
import { ToolkitOwner } from '../src/main/toolkit-owner.js'

let fixture: Awaited<ReturnType<typeof owningBridge>> | undefined
afterEach(async () => {
  try { await fixture?.dispose() }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error
    await rm(bridge.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  } finally { fixture = undefined; vi.restoreAllMocks() }
})
async function setup() {
  fixture = await owningBridge()
  const { app } = await import('electron')
  vi.spyOn(app, 'getAppPath').mockReturnValue(fileURLToPath(new URL('../', import.meta.url)))
  const sender = Object.assign(fixture.sender, { mainFrame: {} })
  const execute = vi.spyOn(ToolkitOwner.prototype, 'execute')
  const subscribe = vi.spyOn(ToolkitOwner.prototype, 'subscribe')
  return { sender, execute, subscribe }
}
// Registered Main and real ToolkitOwner are consumed. Electron's IPC carrier is
// controlled; execution effects are deliberately not entered by refused callers.
it('accepts the exact Workbench main frame and consumes the original Toolkit owner', async () => {
  const { sender, execute } = await setup()
  const value = await bridge.handlers.get('toolkit:list')!({ sender, senderFrame: sender.mainFrame })
  expect(value).toMatchObject({ operation: 'toolkit.list', tools: expect.any(Array) })
  expect(execute).toHaveBeenCalledOnce()
})
it.each([
  ['toolkit:run', ['performance']],
  ['toolkit:evaluate', ['performance']],
  ['toolkit:action', ['performance', 'refresh', {}]],
  ['toolkit:stop', ['performance']],
  ['toolkit:add', ['private', {}]],
  ['toolkit:update', ['private', {}]],
  ['toolkit:remove', ['private']],
  ['toolkit:observe', ['performance', 'reader', { evaluateOnDisplay: true }]]
])('refuses a foreign %s caller before executing or subscribing', async (channel, values) => {
  const { sender, execute, subscribe } = await setup()
  const handler = bridge.handlers.get(channel)!
  expect(handler).toBeTypeOf('function')
  for (const event of [
    { sender: {}, senderFrame: sender.mainFrame },
    { sender, senderFrame: {} },
    { sender },
    { sender: undefined, senderFrame: undefined }
  ]) {
    await expect(Promise.resolve().then(() => handler(event, ...values))).rejects.toThrow('original Workbench')
  }
  expect(execute).not.toHaveBeenCalled()
  expect(subscribe).not.toHaveBeenCalled()
})

it('refuses an unavailable main frame even when both frame handles are absent', async () => {
  const { sender, execute, subscribe } = await setup()
  Reflect.set(sender, 'mainFrame', undefined)
  await expect(Promise.resolve().then(() => bridge.handlers.get('toolkit:list')!({ sender }))).rejects.toThrow('original Workbench')
  expect(execute).not.toHaveBeenCalled()
  expect(subscribe).not.toHaveBeenCalled()
})
