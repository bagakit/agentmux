import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { registerDeviceManagementIpc } from '../src/main/device-management-ipc'
import { assertSenderTrusted, senderTrust } from '../src/main/ipc-sender-trust'

function fixture() {
  const sender = {}, stranger = {}, handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>>()
  const call = vi.fn().mockImplementation(async (_method, input) => ({ original: input })), dispose = vi.fn().mockResolvedValue(undefined)
  const connect = vi.fn().mockResolvedValue({ call, dispose })
  const guard = vi.fn((event: IpcMainInvokeEvent) => assertSenderTrusted(senderTrust('sessions:observeHistory', event.sender, sender)))
  registerDeviceManagementIpc({ handleWithEvent: (channel, handler) => handlers.set(channel, handler),
    assertTrusted: (_channel, event) => guard(event), socketPath: _hygiene_fixturePath("original/runtime/agentmux.sock"), connect: connect as never })
  return { sender, stranger, handlers, call, dispose, connect, guard,
    invoke: (channel: string, input: unknown, source = sender) => handlers.get(channel)!({ sender: source } as IpcMainInvokeEvent, input) }
}
const failure = (promise: Promise<unknown>) => promise.catch(error => error)

describe('Narrow registered trusted Desktop device IPC leaf', () => {
  it('registers only five fixed public calls and uses the original local Unix service with no principal assertion', async () => {
    const f = fixture()
    expect([...f.handlers.keys()]).toEqual(['deviceManagement:ls', 'deviceManagement:invite', 'deviceManagement:approve', 'deviceManagement:reject', 'deviceManagement:revoke'])
    const cases = [['ls', {}], ['invite', {}], ['approve', { deviceId: 'original-device', confirmationCode: '123456' }],
      ['reject', { deviceId: 'original-device' }], ['revoke', { deviceId: 'original-device' }]] as const
    for (const [method, input] of cases) {
      expect(await f.invoke(`deviceManagement:${method}`, input)).toEqual({ original: input })
      expect(f.call).toHaveBeenLastCalledWith(`device.${method}`, input)
      expect(f.connect).toHaveBeenLastCalledWith({ endpoint: { transport: 'unix', path: _hygiene_fixturePath("original/runtime/agentmux.sock") } })
    }
    expect(f.guard).toHaveBeenCalledTimes(5); expect(f.dispose).toHaveBeenCalledTimes(5)
    expect(f.handlers.has('deviceManagement:call')).toBe(false)
  })

  it('refuses an untrusted renderer before creating any service reader or confirmation request', async () => {
    const f = fixture()
    for (const channel of f.handlers.keys()) expect(await failure(f.invoke(channel, {}, f.stranger))).toBeInstanceOf(Error)
    expect(f.connect).not.toHaveBeenCalled(); expect(f.call).not.toHaveBeenCalled(); expect(f.dispose).not.toHaveBeenCalled()
  })

  it('passes strict validation to the original dispatcher, preserves its error and disposes only this reader without retry', async () => {
    const f = fixture(), error = Object.assign(new Error('Original public invalid parameters'), { code: 'INVALID_CONTROL_REQUEST' })
    f.call.mockRejectedValue(error)
    const original = { deviceId: 'target', confirmationCode: '123456', confirmed: true, principal: { kind: 'user' } }
    expect(await failure(f.invoke('deviceManagement:approve', original))).toBe(error)
    expect(f.call).toHaveBeenCalledWith('device.approve', original)
    expect(f.call.mock.calls[0]![1]).toBe(original)
    expect(f.call).toHaveBeenCalledOnce(); expect(f.connect).toHaveBeenCalledOnce(); expect(f.dispose).toHaveBeenCalledOnce()
  })
})
