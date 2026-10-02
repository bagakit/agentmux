// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createNativePrivateAccess, type NativePrivateTransportPlugin } from '../src/platform/native/private-transport'
import { exportNativeWorkfaceFile } from '../src/platform/native/workface-file'
import { emptyDeviceWorkface } from '../src/recovery/device-workface'

const ORIGIN = 'https://192.168.1.20:9443'
function fixture() {
  const plugin = {
    begin: vi.fn<NativePrivateTransportPlugin['begin']>(async () => ({ state: 'waiting' as const, hostId: 'host-original', deviceId: 'device-original', confirmationCode: '123456', expiresAt: 1 })),
    claim: vi.fn<NativePrivateTransportPlugin['claim']>(async () => ({ state: 'waiting' as const, hostId: 'host-original' })),
    open: vi.fn<NativePrivateTransportPlugin['open']>(async () => ({ status: 200, headers: { 'content-type': 'text/event-stream' } })),
    read: vi.fn<NativePrivateTransportPlugin['read']>(async () => ({ done: true })),
    cancel: vi.fn<NativePrivateTransportPlugin['cancel']>(async () => {})
  }
  return { plugin, access: createNativePrivateAccess({ plugin }), fetch: createNativePrivateAccess({ plugin }).fetchForHost(ORIGIN, 'host-original') }
}
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
const outcome = (promise: Promise<unknown>) => promise.then(value => value, (error: unknown) => error)

describe('native private byte adapter preparation (not OS/device proof)', () => {
  it('reads only on public Response demand and retains ordered bytes across UTF-8/SSE boundaries', async () => {
    const f = fixture(), original = new TextEncoder().encode('event: progress\ndata: {"text":"你好🦀"}\n\n')
    f.plugin.read.mockResolvedValueOnce({ done: false, data: base64(original.subarray(0, 37)) })
      .mockResolvedValueOnce({ done: false, data: base64(original.subarray(37)) }).mockResolvedValueOnce({ done: true })
    const response = await f.fetch(`${ORIGIN}/`, { method: 'POST', body: '{"operationId":"original"}' })
    expect(f.plugin.read).not.toHaveBeenCalled()
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(original)
    expect(f.plugin.read).toHaveBeenCalledTimes(3)
    expect(new Set(f.plugin.read.mock.calls.map(([input]) => input.requestId)).size).toBe(1)
    expect(f.plugin.cancel).not.toHaveBeenCalled()
  })
  it('keeps the exact common request body and headers while credentials remain outside its bridge DTO', async () => {
    const f = fixture(), body = '{"method":"runtime.invoke","params":{"operationId":"keep-original","prompt":"汉字"}}'
    const response = await f.fetch(`${ORIGIN}/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    const sent = f.plugin.open.mock.calls[0]![0]
    expect(sent.origin).toBe(ORIGIN); expect(sent.hostId).toBe('host-original')
    expect(Buffer.from(sent.body!, 'base64').toString('utf8')).toBe(body)
    expect(sent.headers).toEqual({ 'content-type': 'application/json' })
    expect(Object.keys(sent).sort()).toEqual(['body', 'headers', 'hostId', 'method', 'origin', 'path', 'requestId'])
    await response.body!.cancel()
  })
  it('refuses cross-origin, secret admission and caller-owned authentication before sending', async () => {
    const f = fixture()
    const anotherMac = await outcome(f.fetch('https://192.168.1.21:9443/'))
    expect(anotherMac).toBeInstanceOf(Error); expect((anotherMac as Error).message).toContain('另一 Mac')
    await expect(f.fetch(`${ORIGIN}/_agentmux/device`, { method: 'POST', body: '{}' })).rejects.toThrow('系统秘密通道')
    await expect(f.fetch(`${ORIGIN}/_agentmux/device/claim`, { method: 'POST', body: '{}' })).rejects.toThrow('系统秘密通道')
    await expect(f.fetch(`${ORIGIN}/_agentmux/%64evice/claim`, { method: 'POST', body: '{}' })).rejects.toThrow('系统秘密通道')
    await expect(f.fetch(`${ORIGIN}/prefix/%2e%2e/_agentmux/device/claim`, { method: 'POST', body: '{}' })).rejects.toThrow('系统秘密通道')
    for (const header of ['Authorization', 'Cookie', 'Origin', 'Sec-Fetch-Site', 'X-AgentMux-Transport']) {
      await expect(f.fetch(`${ORIGIN}/`, { headers: { [header]: 'untrusted' } })).rejects.toThrow('认证头')
    }
    expect(f.plugin.open).not.toHaveBeenCalled()
  })
  it('cancels a late admitted native request without exposing a response or reading its body', async () => {
    const f = fixture(), controller = new AbortController()
    let ready!: (value: { status: number; headers: Record<string, string> }) => void
    f.plugin.open.mockImplementationOnce(() => new Promise(resolve => { ready = resolve }))
    const pending = f.fetch(`${ORIGIN}/`, { signal: controller.signal })
    await vi.waitFor(() => expect(f.plugin.open).toHaveBeenCalledOnce())
    const result = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort(); ready({ status: 200, headers: {} }); await result
    expect(f.plugin.read).not.toHaveBeenCalled()
    const id = f.plugin.open.mock.calls[0]![0].requestId
    expect(f.plugin.cancel.mock.calls.every(([input]) => input.requestId === id)).toBe(true)
  })
  it('fences a late stream chunk after cancellation and leaves another active reader usable', async () => {
    const f = fixture(), controller = new AbortController()
    let chunk!: (value: { done: boolean; data?: string }) => void
    f.plugin.read.mockImplementationOnce(() => new Promise(resolve => { chunk = resolve }))
    const first = await f.fetch(`${ORIGIN}/`, { signal: controller.signal }), second = await f.fetch(`${ORIGIN}/`)
    const reader = first.body!.getReader(), reading = reader.read()
    await vi.waitFor(() => expect(f.plugin.read).toHaveBeenCalledOnce())
    const result = expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort(); chunk({ done: false, data: base64(Uint8Array.of(120)) }); await result
    f.plugin.read.mockResolvedValueOnce({ done: false, data: base64(Uint8Array.of(121)) }).mockResolvedValueOnce({ done: true })
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(Uint8Array.of(121))
    expect(f.plugin.cancel).toHaveBeenCalledOnce()
    expect(f.plugin.cancel.mock.calls.every(([input]) => input.requestId === f.plugin.open.mock.calls[0]![0].requestId)).toBe(true)
  })
  it('fails only the malformed transport read and releases its native lease', async () => {
    const f = fixture()
    f.plugin.read.mockResolvedValueOnce({ done: false, data: base64(new Uint8Array(65537)) })
    const response = await f.fetch(`${ORIGIN}/`)
    const invalidRead = await outcome(response.arrayBuffer())
    expect(invalidRead).toBeInstanceOf(Error); expect((invalidRead as Error).message).toContain('原生响应片段')
    expect(f.plugin.cancel).toHaveBeenCalledOnce()
  })
  it('uses native-only admission methods and public identity/status byte requests', async () => {
    const f = fixture()
    const info = await f.access.info(ORIGIN), status = await f.access.status(ORIGIN, 'host-original')
    expect(f.plugin.open.mock.calls.map(([v]) => ({ path: v.path, hostId: v.hostId }))).toEqual([
      { path: '/_agentmux/device', hostId: undefined }, { path: '/_agentmux/device/status', hostId: 'host-original' }
    ])
    expect(await f.access.begin(ORIGIN, 'host-original', 'short-invitation', 'phone')).toEqual({
      state: 'waiting', hostId: 'host-original', deviceId: 'device-original', confirmationCode: '123456', expiresAt: 1
    })
    expect(await f.access.claim(ORIGIN, 'host-original')).toEqual({ state: 'waiting', hostId: 'host-original' })
    expect(Object.keys(f.plugin.claim.mock.calls[0]![0]).sort()).toEqual(['hostId', 'origin', 'requestId'])
    f.plugin.open.mockRejectedValueOnce(Object.assign(new Error('No saved device authorization'), { code: 'NATIVE_DEVICE_UNAPPROVED' }))
    await expect(f.access.status(ORIGIN, 'host-original')).rejects.toMatchObject({ code: 'NATIVE_DEVICE_UNAPPROVED' })
    expect(f.plugin.begin).toHaveBeenCalledOnce()
    await info.body!.cancel(); await status.body!.cancel()
  })
  it('does not treat a native storage failure as approval or automatically repeat the one-time claim', async () => {
    const f = fixture()
    f.plugin.claim.mockRejectedValueOnce(Object.assign(new Error('System storage unconfirmed'), { code: 'NATIVE_SECRET_STORE_UNCONFIRMED' }))
    await expect(f.access.claim(ORIGIN, 'host-original')).rejects.toMatchObject({ code: 'NATIVE_SECRET_STORE_UNCONFIRMED' })
    expect(f.plugin.claim).toHaveBeenCalledOnce()
    expect(f.plugin.open).not.toHaveBeenCalled()
    f.plugin.claim.mockRejectedValueOnce(Object.assign(new Error('One-time claim result unknown'), { code: 'NATIVE_CLAIM_UNCONFIRMED' }))
    await expect(f.access.claim(ORIGIN, 'host-original')).rejects.toMatchObject({ code: 'NATIVE_CLAIM_UNCONFIRMED' })
    expect(f.plugin.claim).toHaveBeenCalledTimes(2)
    expect(f.plugin.open).not.toHaveBeenCalled()
  })
})

describe('public native workface file port preparation', () => {
  const bytes = JSON.stringify({ schema: 'agentmux.mobile-workface.v1', workface: emptyDeviceWorkface() })
  it('passes only a validated public schema and fixed filename to the actual native save port', async () => {
    const save = vi.fn(async () => {})
    await exportNativeWorkfaceFile('agentmux-workface.json', bytes, { save })
    expect(save).toHaveBeenCalledExactlyOnceWith({ filename: 'agentmux-workface.json', bytes })
    await expect(exportNativeWorkfaceFile('../private.json', bytes, { save })).rejects.toThrow('agentmux-workface.json')
    const privateFields = await outcome(exportNativeWorkfaceFile('agentmux-workface.json', JSON.stringify({ schema: 'agentmux.mobile-workface.v1', workface: { ...emptyDeviceWorkface(), credential: 'forbidden' } }), { save }))
    expect(privateFields).toBeInstanceOf(Error); expect((privateFields as Error).message).toContain('完整核实')
    expect(save).toHaveBeenCalledOnce()
  })
  it('retains an unsuccessful system picker/write result as unsaved', async () => {
    const save = vi.fn(async () => { throw new Error('Picker cancelled; not saved') })
    const unsaved = await outcome(exportNativeWorkfaceFile('agentmux-workface.json', bytes, { save }))
    expect(unsaved).toBeInstanceOf(Error); expect((unsaved as Error).message).toContain('not saved')
  })
})
