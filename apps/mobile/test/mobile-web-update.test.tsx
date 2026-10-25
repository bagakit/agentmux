import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMuxClientEvent } from '@agentmux/core'
import type { MobileAssetsInspection, MobileAssetsLoadedReceipt } from '@agentmux/core/mobile-web'
import { MobileConnectionRoot } from '../src/connection/MobileConnectionRoot'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, deferred, fixture, mount, mounted } from './conversation-fixture'

const relay = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock('@agentmux/core/relay-hosted', async original => ({ ...await original<object>(), connectRelayHostedClient: relay.connect }))
vi.mock('../src/connection/relay-identity', () => ({ deviceRelayIdentity: async () => ({ publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) }), existingDeviceRelayIdentity: async () => ({ publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) }) }))

const offer = { v: 2 as const, serverId: 'original-host', daemonPublicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', relay: { endpoint: '127.0.0.1:1', useTls: false } }
const digest = (digit: string) => 'sha256:' + digit.repeat(64)
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const updateNotice = (element: ParentNode) => element.querySelector<HTMLElement>('.mobile-web-update-notice:not([hidden])')
const connection = (state: 'lost' | 'restored'): Extract<AgentMuxClientEvent, { type: 'connection-state' }> => ({
  type: 'connection-state', state, observationOrigin: { kind: 'runtime-connection', boundary: 'consumer-core' }, evidence: { source: 'agentmux', observedAt: 100 }
})

function product() {
  const f = fixture()
  let loaded: MobileAssetsLoadedReceipt | null = null
  let active = { buildId: 'new-build', digest: digest('b'), bytes: 100, fileCount: 2, revision: 2 }
  let inspectOverride: ((value: MobileAssetsInspection) => MobileAssetsInspection | Promise<MobileAssetsInspection>) | null = null
  let accepted = true
  const rpc = vi.fn(async (method: string, input: any): Promise<any> => {
    if (method === 'app.mobile.assets.loaded') {
      loaded = { ...input, hostId: 'original-host', producer: { devicePrincipalId: 'original-device', documentId: input.documentId }, hostInstanceId: 'original-host-instance', receivedAt: 200, accepted, reason: accepted ? null : 'capacity' }
      return loaded
    }
    if (method === 'app.mobile.assets.inspect') {
      if (!loaded) throw Error('Original page receipt required')
      const result: MobileAssetsInspection = { hostId: loaded.hostId, hostInstanceId: loaded.hostInstanceId, active, retained: [], retention: 'active-and-previous', operation: null,
        clients: [loaded], client: { target: loaded.producer, availability: 'found', loaded, namespace: 'retained' },
        coverage: { lifetime: 'current-host-instance', operationsRetained: 0, operationsEvicted: 0, loadedRetained: 1, loadedRejected: 0 }, observedAt: 300 }
      return inspectOverride ? inspectOverride(result) : result
    }
    if (method === 'app.mobile.report') return { hostId: 'original-host', producer: { devicePrincipalId: 'original-device', documentId: input.documentId }, accepted: true, logId: null, recordRef: null, persistence: 'unconfirmed' }
    if (method === 'space.ls' || method === 'space.inspect') return { catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [], agentPresentation: [] } }
    if (method === 'goal.ls') return { goals: [], unavailable: [] }
    return { agents: [], workspaces: [], projects: [], executors: [], unavailable: [] }
  })
  f.client.forwardRpc = rpc
  Object.assign(f.client, { connect: vi.fn(async () => {}), dispose: vi.fn(async () => {}) })
  relay.connect.mockResolvedValue(f.client)
  return { ...f, rpc, get loaded() { return loaded }, setAccepted(value: boolean) { accepted = value }, setActive(value: typeof active) { active = value }, setInspect(value: typeof inspectOverride) { inspectOverride = value }, inspections: () => rpc.mock.calls.filter(([method]) => method === 'app.mobile.assets.inspect') }
}
async function openProduct(f: ReturnType<typeof product>) {
  const view = await mount(<MobileConnectionRoot platform={createBrowserPlatform()} native={false} offer={offer} />)
  await act(async () => { await settle() })
  expect(f.inspections().length).toBeGreaterThan(0)
  return view
}
beforeEach(async () => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/mobile/reviewed-page-build/' + 'a'.repeat(64) + '/index.html')
  await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
  await getDeviceWorkface().updateNavigation({ selectedSessionId: 'session-original', hostUrl: '', panel: 'conversation' })
})
afterEach(async () => {
  for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); relay.connect.mockReset()
})

describe('mobile update through the actual connection root and App', () => {
  for (const version of ['current', 'unknown'] as const) it(`reopens ${version} version through the original safety owner without a diagnostic gate`, async () => {
    const f = product()
    if (version === 'current') f.setActive({ buildId: 'reviewed-page-build', digest: digest('a'), bytes: 100, fileCount: 2, revision: 1 })
    else f.setInspect(() => { throw new Error('Version observation unavailable') })
    const navigate = vi.spyOn(location, 'assign').mockImplementation(() => {})
    const fetchEntry = vi.fn(async () => ({ ok: true, url: location.origin + '/mobile/reviewed-page-build/' + 'a'.repeat(64) + '/index.html' }) as Response)
    vi.stubGlobal('fetch', fetchEntry)
    const view = await openProduct(f)
    await click(button(view.element, '手机设置与连接'))
    expect(document.body.textContent).toContain(version === 'current' ? '已是当前版本' : '版本尚未确认')
    const reopen = button(document.body, '重新打开网页')
    expect(reopen.disabled).toBe(false)
    await click(reopen)
    await vi.waitFor(() => expect(navigate.mock.calls, document.querySelector('.mobile-web-update-settings')?.textContent).toHaveLength(1))
    expect(fetchEntry).toHaveBeenCalledOnce()
    expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('session-original')
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('closes settings without allowing its unfinished reopening intent to navigate later', async () => {
    const f = product(), waiting = deferred<Response>()
    const fetchEntry = vi.fn(() => waiting.promise), navigate = vi.spyOn(location, 'assign').mockImplementation(() => {})
    vi.stubGlobal('fetch', fetchEntry)
    const view = await openProduct(f)
    await click(button(view.element, '手机设置与连接'))
    await click(button(document.body, '载入最新版'))
    await vi.waitFor(() => expect(fetchEntry).toHaveBeenCalledOnce())
    await click(button(document.body, '关闭面板'))
    await act(async () => waiting.resolve({ ok: true, url: location.origin + '/mobile/reviewed-page-build/' + 'a'.repeat(64) + '/index.html' } as Response))
    expect(navigate).not.toHaveBeenCalled()
    expect(document.querySelector('.mobile-web-update-settings')).toBeNull()
    expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('session-original')
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('proactively offers a confirmed new release, can dismiss it and reopen the fixed settings entry', async () => {
    const f = product(), view = await openProduct(f)
    expect(updateNotice(view.element)?.textContent).toContain('网页有新版本')
    expect(f.inspections()[0]![1]).toEqual({ hostId: 'original-host', client: { devicePrincipalId: 'original-device', documentId: f.loaded!.producer.documentId } })
    const notice = updateNotice(view.element)!
    await click(button(notice, '前往更新'))
    expect(document.body.textContent).toContain('网页更新')
    expect(button(document.body, '载入最新版')).toBeDefined()
    await click(button(document.body, '关闭面板'))
    await click(notice.querySelector('[aria-label="收起提醒"]')!)
    expect(updateNotice(view.element)).toBeNull()
    await click(button(view.element, '手机设置与连接'))
    expect(document.body.textContent).toContain('网页更新')
    expect(button(document.body, '检查更新')).toBeDefined()
    expect(button(document.body, '载入最新版')).toBeDefined()
    expect(f.submit).not.toHaveBeenCalled()
  })
  it('shows a different confirmed version after dismissing the previous one', async () => {
    const f = product(), view = await openProduct(f)
    const notice = updateNotice(view.element)!
    await click(notice.querySelector('[aria-label="收起提醒"]')!)
    f.setActive({ buildId: 'third-build', digest: digest('c'), bytes: 100, fileCount: 2, revision: 3 })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await settle() })
    await vi.waitFor(() => expect(updateNotice(view.element)?.textContent).toContain('网页有新版本'))
  })
  it('does not infer an update from a mismatched original Host, document or occurrence', async () => {
    for (const mismatch of ['host', 'instance', 'device', 'document', 'occurrence', 'loaded-build', 'loaded-digest', 'loaded-accepted', 'missing-active'] as const) {
      const f = product()
      f.setInspect(value => {
        const out = structuredClone(value)
        if (mismatch === 'host') out.hostId = 'other-host'
        if (mismatch === 'instance') out.hostInstanceId = 'other-instance'
        if (mismatch === 'device') out.client!.target.devicePrincipalId = 'other-device'
        if (mismatch === 'document') out.client!.target.documentId = 'other-document'
        if (mismatch === 'occurrence') out.client!.loaded!.occurrenceId = 'other-occurrence'
        if (mismatch === 'loaded-build') out.client!.loaded!.buildId = 'different-page-build'
        if (mismatch === 'loaded-digest') out.client!.loaded!.namespaceDigest = digest('f')
        if (mismatch === 'loaded-accepted') out.client!.loaded!.accepted = false
        if (mismatch === 'missing-active') out.active = null
        return out
      })
      const view = await openProduct(f)
      expect(updateNotice(view.element), mismatch).toBeNull()
      const old = mounted.splice(mounted.findIndex(value => value.element === view.element), 1)[0]!
      await act(async () => old.root.unmount()); old.element.remove()
    }
  })
  it('detects digest changes even when the build id is unchanged', async () => {
    const f = product(); f.setActive({ buildId: 'reviewed-page-build', digest: digest('b'), bytes: 100, fileCount: 2, revision: 2 })
    const view = await openProduct(f)
    expect(updateNotice(view.element)?.textContent).toContain('网页有新版本')
  })
  it('does not query or announce an update when the original page receipt was not accepted', async () => {
    const f = product(); f.setAccepted(false)
    const view = await mount(<MobileConnectionRoot platform={createBrowserPlatform()} native={false} offer={offer} />)
    await act(async () => { await settle() })
    expect(f.loaded?.accepted).toBe(false)
    expect(f.inspections()).toHaveLength(0)
    expect(updateNotice(view.element)).toBeNull()
  })
  it('leaves current, unavailable, and disconnected observations unknown without forcing navigation', async () => {
    const f = product(); f.setActive({ buildId: 'reviewed-page-build', digest: digest('a'), bytes: 100, fileCount: 2, revision: 1 })
    const view = await openProduct(f)
    expect(updateNotice(view.element)).toBeNull()
    f.setInspect(() => { throw Error('Original query unavailable') })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await settle() })
    expect(updateNotice(view.element)).toBeNull()
    await act(async () => { f.emit(connection('lost')); await settle() })
    expect(updateNotice(view.element)).toBeNull()
    expect(f.submit).not.toHaveBeenCalled()
    expect(location.pathname).toContain('/mobile/reviewed-page-build/')
  })
  it('rejects an old connection response and checks the reconnected original Host after that IO completes', async () => {
    const f = product(), pending = deferred<MobileAssetsInspection>()
    let previous: MobileAssetsInspection | null = null
    f.setInspect(value => { previous = value; return pending.promise })
    const view = await openProduct(f)
    await act(async () => { f.emit(connection('lost')); f.emit(connection('restored')); await settle() })
    expect(f.inspections()).toHaveLength(1)
    f.setInspect(null)
    f.setActive({ buildId: 'reviewed-page-build', digest: digest('a'), bytes: 100, fileCount: 2, revision: 3 })
    pending.resolve(previous!)
    await act(async () => { await settle() })
    expect(f.inspections()).toHaveLength(2)
    expect(updateNotice(view.element)).toBeNull()
  })
  it('coalesces concurrent checks, pauses periodic reads in background and checks again on foreground', async () => {
    vi.useFakeTimers()
    const f = product(), pending = deferred<MobileAssetsInspection>()
    f.setInspect(() => pending.promise)
    const view = await openProduct(f)
    const count = f.inspections().length
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      document.dispatchEvent(new Event('visibilitychange'))
      f.emit(connection('lost')); f.emit(connection('restored'))
      await settle()
    })
    expect(f.inspections()).toHaveLength(count)
    const loaded = f.loaded!
    f.setInspect(null)
    pending.resolve({ hostId: loaded.hostId, hostInstanceId: loaded.hostInstanceId,
      active: { buildId: 'new-build', digest: digest('b'), bytes: 100, fileCount: 2, revision: 2 }, retained: [], retention: 'active-and-previous', operation: null,
      clients: [loaded], client: { target: loaded.producer, availability: 'found', loaded, namespace: 'retained' },
      coverage: { lifetime: 'current-host-instance', operationsRetained: 0, operationsEvicted: 0, loadedRetained: 1, loadedRejected: 0 }, observedAt: 300 })
    await act(async () => { await settle() })
    const foregroundCount = f.inspections().length
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(180000) })
    const hiddenCount = f.inspections().length
    expect(hiddenCount).toBe(foregroundCount)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await settle() })
    expect(f.inspections()).toHaveLength(hiddenCount + 1)
    expect(updateNotice(view.element)?.textContent).toContain('网页有新版本')
  })
})
