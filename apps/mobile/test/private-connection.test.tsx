import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { PrivateConnection, type NativePrivateAdmission } from '../src/connection/private-connection'
import { MobileConnectionRoot } from '../src/connection/MobileConnectionRoot'
import { PrivateConnectionPanel } from '../src/connection/PrivateConnectionPanel'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, deferred, editor, fixture, mount, mounted } from './conversation-fixture'

const origin = 'https://192.168.1.20:7443'
const hostId = 'host-original'
const device = { deviceId: 'device-original', name: 'iPhone', createdAt: 1 }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' }
})
const controllers: PrivateConnection[] = []
function controller(options: ConstructorParameters<typeof PrivateConnection>[0] = { native: false }) {
  const value = new PrivateConnection(options); controllers.push(value); return value
}
function approvedFetch() {
  return vi.fn<typeof fetch>(async url => String(url).endsWith('/status') ? json({ hostId, device }) : json({ hostId }))
}
function sdkFixture() {
  const f = fixture()
  Object.assign(f.client, { dispose: vi.fn().mockResolvedValue(undefined) })
  return f
}
beforeEach(() => {
  window.happyDOM.setURL(`${origin}/`)
  localStorage.clear()
  getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
})
afterEach(async () => {
  for (const value of controllers.splice(0)) value.stop()
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

describe('Browser device admission and actual application connection caller', () => {
  it('refuses native or cross-origin cookie authentication without sending credentials or inventing a client', async () => {
    const fetch = vi.fn(), factory = vi.fn(); vi.stubGlobal('fetch', fetch)
    const browser = controller({ native: false, connectClient: factory })
    await browser.resume('https://192.168.1.21:7443')
    expect(browser.snapshot().connection.message).toContain('当前页面不能代替另一地址')
    const native = controller({ native: true, connectClient: factory })
    await native.resume(origin)
    expect(native.snapshot().connection.message).toContain('原生设备的安全授权通道尚未可用')
    expect(fetch).not.toHaveBeenCalled(); expect(factory).not.toHaveBeenCalled()
    expect(browser.snapshot().client).toBeNull(); expect(native.snapshot().client).toBeNull()
  })

  it('uses only same-origin HttpOnly admission and never equates approved device with an unavailable common SDK', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ hostId })).mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json({ state: 'waiting', hostId, deviceId: device.deviceId, confirmationCode: '123456', expiresAt: Date.now() + 60_000 }, 201))
      .mockResolvedValueOnce(json({ state: 'waiting', hostId }, 202))
      .mockResolvedValueOnce(json({ state: 'approved', hostId, device }))
    vi.stubGlobal('fetch', fetch)
    const write = vi.spyOn(localStorage, 'setItem'), value = controller()
    await value.resume(origin); expect(value.snapshot().phase).toBe('needs-approval')
    await value.begin(' short-invitation ', ' iPhone ')
    expect(value.snapshot().phase).toBe('waiting'); expect(value.snapshot().confirmationCode).toBe('123456')
    await value.claim(); expect(value.snapshot().connection.state).toBe('unavailable')
    await value.claim()
    expect(value.snapshot()).toMatchObject({ phase: 'authorized', device, client: null, confirmationCode: null,
      connection: { state: 'unavailable' } })
    expect(value.snapshot().connection.message).toContain('会话连接尚未建立')
    for (const [url, init] of fetch.mock.calls) {
      expect(String(url)).toMatch(new RegExp(`^${origin}/_agentmux/device`))
      expect(String(url)).not.toContain('short-invitation')
      expect(init).toMatchObject({ credentials: 'same-origin', redirect: 'error', cache: 'no-store' })
      expect(init?.headers ?? {}).not.toHaveProperty('Authorization')
    }
    expect(JSON.parse(String(fetch.mock.calls[2]![1]?.body))).toEqual({ hostId, invitation: 'short-invitation', name: 'iPhone' })
    expect(write).not.toHaveBeenCalled()
  })

  it('waits for an actual injected SDK factory and keeps its last projection when transport or original Host verification fails', async () => {
    vi.stubGlobal('fetch', approvedFetch())
    const pending = deferred<AgentMuxHostedClient>(), f = sdkFixture(), factory = vi.fn().mockReturnValue(pending.promise)
    const value = controller({ native: false, connectClient: factory })
    const attempt = value.resume(origin)
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce())
    expect(value.snapshot()).toMatchObject({ phase: 'authorized', client: null, connection: { state: 'unavailable' } })
    pending.resolve(f.client); await attempt
    expect(value.snapshot()).toMatchObject({ client: f.client, connection: { state: 'connected' } })
    f.emit({ type: 'connection-state', state: 'lost', reason: 'Fixture transport closed' })
    expect(value.snapshot().connection.state).toBe('disconnected')
    expect(value.snapshot().client).toBe(f.client)
    f.emit({ type: 'connection-state', state: 'restored' })
    expect(value.snapshot().connection.state).toBe('connected')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('TLS trust or connection failed')))
    await value.resume(origin)
    expect(value.snapshot().client).toBe(f.client); expect(value.snapshot().connection.state).toBe('disconnected')
    expect(f.client.dispose).not.toHaveBeenCalled()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ hostId: 'another-host' })))
    await value.resume(origin)
    expect(value.snapshot().hostId).toBe(hostId); expect(value.snapshot().client).toBe(f.client)
    expect(factory).toHaveBeenCalledOnce(); expect(f.submit).not.toHaveBeenCalled()
  })

  it('disposes only a superseded consumer and refuses secret-bearing or stale approval responses', async () => {
    vi.stubGlobal('fetch', approvedFetch())
    const older = deferred<AgentMuxHostedClient>(), a = sdkFixture(), b = sdkFixture()
    const factory = vi.fn().mockReturnValueOnce(older.promise).mockResolvedValueOnce(b.client)
    const value = controller({ native: false, connectClient: factory })
    const first = value.resume(origin)
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce())
    await value.resume(origin); expect(value.snapshot().client).toBe(b.client)
    older.resolve(a.client); await first
    expect(a.client.dispose).toHaveBeenCalledOnce(); expect(value.snapshot().client).toBe(b.client)
    expect(b.client.dispose).not.toHaveBeenCalled()
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(json({ hostId }))
      .mockResolvedValueOnce(json({ hostId, device, credential: 'must-never-reach-renderer' })))
    await value.resume(origin)
    expect(value.snapshot().connection.state).toBe('disconnected'); expect(value.snapshot().client).toBe(b.client)
    expect(factory).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(value.snapshot())).not.toContain('must-never-reach-renderer')
  })

  it('the mounted product attempts real address admission despite failed navigation storage and reports device approval separately', async () => {
    const fetch = approvedFetch(); vi.stubGlobal('fetch', fetch)
    const overlay = document.createElement('div'); document.body.append(overlay)
    const view = await mount(<MobileConnectionRoot platform={createBrowserPlatform({ overlayContainer: () => overlay })} native={false} />)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(view.element.querySelector('[data-connection="connected"]')).toBeNull()
    await click(button(view.element, '设置连接'))
    expect(overlay.textContent).toContain('设备授权已确认；会话连接仍待核实')
    expect(overlay.textContent).not.toContain('仅静态记录')
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('actual device storage unavailable') })
    const input = overlay.querySelector<HTMLInputElement>('#mobile-host-address')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, origin)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(button(overlay, '保存地址'))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4))
    expect(write).toHaveBeenCalled(); expect(view.element.textContent).toContain('仅临时采用')
    expect(view.element.textContent).not.toContain('地址已保存在'); expect(overlay.textContent).toContain('设备授权已确认')
    expect(view.element.querySelector('[data-connection="connected"]')).toBeNull()
    expect(overlay.textContent).toContain('身份仅在当前设备内存中保全')
  })

  it('the mounted caller refuses a different durable Host before calling any SDK and preserves the original draft and reference', async () => {
    const owner = getDeviceWorkface(), original = emptyDeviceWorkface()
    original.host = { origin, hostId: 'durable-original-host' }; original.selectedSessionId = 'session-original'
    original.conversation.drafts = [[JSON.stringify(['draft', 'session-original']), '原工作面草稿']]
    owner.replaceBackup(original)
    vi.stubGlobal('fetch', approvedFetch())
    const factory = vi.fn(), view = await mount(<MobileConnectionRoot platform={createBrowserPlatform()} native={false} connectClient={factory} />)
    await vi.waitFor(() => expect(view.element.textContent).toContain('原 Host 身份无法确认一致'))
    expect(factory).not.toHaveBeenCalled()
    expect(owner.snapshot().record).toEqual(original)
    expect(editor(view.element).textContent).toBe('原工作面草稿')
    expect(view.element.querySelector('[data-agent-session-id]')?.getAttribute('data-agent-session-id')).toBe('session-original')
    expect(button(view.element, 'Send').disabled).toBe(true)
  })

  it('a native consumer uses only its OS admission and raw fetch ports, not browser cookie or JS credentials', async () => {
    const browserFetch = vi.fn(); vi.stubGlobal('fetch', browserFetch)
    const rawFetch = vi.fn<typeof fetch>(), f = sdkFixture(), factory = vi.fn().mockResolvedValue(f.client)
    const nativeAccess: NativePrivateAdmission = {
      info: vi.fn().mockImplementation(async () => json({ hostId })),
      status: vi.fn().mockResolvedValueOnce(json({}, 401)).mockImplementation(async () => json({ hostId, device })),
      begin: vi.fn().mockResolvedValue({ state: 'waiting', hostId, deviceId: device.deviceId,
        confirmationCode: '654321', expiresAt: Date.now() + 60_000 }),
      claim: vi.fn().mockResolvedValue({ state: 'approved', hostId, device }), fetchForHost: vi.fn().mockReturnValue(rawFetch)
    }
    const value = controller({ native: true, nativeAccess, connectClient: factory })
    await value.resume(origin); await value.begin('short-invitation', 'iPhone'); await value.claim()
    expect(nativeAccess.begin).toHaveBeenCalledWith(origin, hostId, 'short-invitation', 'iPhone', expect.any(AbortSignal))
    expect(factory).toHaveBeenCalledWith({ origin, hostId, signal: expect.any(AbortSignal), fetch: rawFetch })
    expect(value.snapshot()).toMatchObject({ phase: 'connected', device, client: f.client, connection: { state: 'connected' } })
    expect(browserFetch).not.toHaveBeenCalled(); expect(rawFetch).not.toHaveBeenCalled()
    expect(JSON.stringify(value.snapshot())).not.toContain('short-invitation')
    value.stop()
    const saved = emptyDeviceWorkface()
    saved.host = { origin, hostId }; saved.hostUrl = 'https://192.168.1.21:7443'
    getDeviceWorkface().replaceBackup(saved)
    const view = await mount(<MobileConnectionRoot platform={createBrowserPlatform()} native={true}
      nativeAccess={nativeAccess} connectClient={factory} />)
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2))
    expect(nativeAccess.info).toHaveBeenLastCalledWith(origin, expect.any(AbortSignal))
    expect(view.element.querySelector('[data-connection="connected"]')).not.toBeNull()
    expect(getDeviceWorkface().snapshot().record.host).toEqual({ origin, hostId })
    expect(browserFetch).not.toHaveBeenCalled()
  })

  it('shows the native local-save recovery action and refuses another claim after an unknown one-time result', async () => {
    const waiting = { state: 'waiting', hostId, deviceId: device.deviceId, confirmationCode: '654321', expiresAt: Date.now() + 60_000 }
    const claim = vi.fn().mockRejectedValueOnce({ code: 'NATIVE_SECRET_STORE_UNCONFIRMED' })
      .mockResolvedValueOnce({ state: 'approved', hostId, device }).mockRejectedValueOnce({ code: 'NATIVE_CLAIM_UNCONFIRMED' })
    const access: NativePrivateAdmission = { info: vi.fn().mockImplementation(async () => json({ hostId })),
      status: vi.fn().mockImplementation(async () => json({}, 401)), begin: vi.fn().mockResolvedValue(waiting),
      claim, fetchForHost: vi.fn() }
    const value = controller({ native: true, nativeAccess: access })
    await value.resume(origin); await value.begin('first-invitation', 'iPhone'); await value.claim()
    expect(value.snapshot()).toMatchObject({ phase: 'waiting', nativeRecovery: 'save-secret', confirmationCode: '654321', client: null })
    expect(value.snapshot().connection.message).toContain('不会重新提交一次授权领取')
    const view = await mount(<PrivateConnectionPanel controller={value} snapshot={value.snapshot()} native />)
    expect([...view.element.querySelectorAll('button')].map(value => value.textContent)).not.toContain('检查 Mac 批准')
    await click(button(view.element, '解锁后重试系统保存'))
    expect(claim).toHaveBeenCalledTimes(2)
    expect(value.snapshot()).toMatchObject({ phase: 'authorized', nativeRecovery: null, client: null, connection: { state: 'unavailable' } })
    await value.begin('fresh-invitation', 'iPhone'); await value.claim()
    expect(value.snapshot()).toMatchObject({ phase: 'needs-approval', nativeRecovery: 'new-invitation', confirmationCode: null })
    await value.claim(); expect(claim).toHaveBeenCalledTimes(3)
    await view.render(<PrivateConnectionPanel controller={value} snapshot={value.snapshot()} native />)
    expect(view.element.querySelector('#mobile-device-invitation')).not.toBeNull()
    expect([...view.element.querySelectorAll('button')].map(value => value.textContent)).not.toContain('检查 Mac 批准')
    expect(value.snapshot().connection.message).toContain('在 Mac 生成新邀请')
    vi.mocked(access.status).mockRejectedValueOnce({ code: 'NATIVE_SECRET_STORE_UNCONFIRMED' })
    await value.resume(origin)
    expect(value.snapshot().nativeRecovery).toBe('unlock-resume')
    await view.render(<PrivateConnectionPanel controller={value} snapshot={value.snapshot()} native />)
    await click(button(view.element, '解锁后核对授权'))
    expect(value.snapshot().phase).toBe('needs-approval'); expect(claim).toHaveBeenCalledTimes(3)
    vi.mocked(access.status).mockRejectedValueOnce({ code: 'NATIVE_DEVICE_UNAPPROVED' })
    await value.resume(origin)
    expect(value.snapshot()).toMatchObject({ phase: 'needs-approval', nativeRecovery: null })
    expect(value.snapshot().connection.message).toContain('尚无已批准的系统设备凭证')
  })
})
