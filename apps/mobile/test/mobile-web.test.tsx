import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxClientEvent, AgentMuxRpcResult } from '@agentmux/core'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { MobileAssetsInspection, MobileAssetsLoadedReceipt, MobileWebReportParams, MobileWebReportReceipt } from '@agentmux/core/mobile-web'
import { MobileWebReporter } from '../src/mobile-web/reporter'
import { MobileWebCatalogObservation, useMobileWebObservation, type MobileWebPageObservation } from '../src/mobile-web/use-mobile-web-observation'
import { MobileWebDiagnostics } from '../src/mobile-web/MobileWebDiagnostics'
import { MobileSpatialNavigation } from '../src/navigation/MobileSpatialNavigation'
import { MobileNoticeProvider } from '../src/notices/MobileNotice'
import { MobileConnectionRoot } from '../src/connection/MobileConnectionRoot'
import type { ClientUiPlatform } from '@agentmux/client-ui/platform'

const connectionPort = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock('@agentmux/core/relay-hosted', async original => ({ ...await original<object>(), connectRelayHostedClient: connectionPort.connect }))
vi.mock('../src/connection/relay-identity', () => ({ deviceRelayIdentity: async () => ({ publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) }) }))
vi.mock('../src/MobileApp', () => ({ MobileApp: (props: any) => <div data-connection={props.connection.state} data-document={props.webObservation?.page.documentId}><textarea defaultValue="original root draft" /></div> }))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const page = { documentId: 'original-document', buildId: 'original-build', namespaceDigest: 'sha256:' + 'a'.repeat(64) }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const settle = async () => { for (let index = 0; index < 10; index++) await Promise.resolve() }
const catalog = (ids: string[], issue: unknown = 'private original issue') => ({ spaces: ids.map(spaceId => ({ spaceId, name: 'Original', kind: 'filesystem', issue })) }) as unknown as Pick<AgentMuxRpcResult<'space.ls'>['catalog'], 'spaces'>
function receipt(input: MobileWebReportParams): MobileWebReportReceipt {
  return { hostId: 'original-host', producer: { devicePrincipalId: 'authenticated-device', documentId: input.documentId }, accepted: true, logId: null, recordRef: null, persistence: 'unconfirmed' }
}
function connection(state: 'lost' | 'restored', boundary: 'consumer-core' | 'core-ctxmux' = 'consumer-core'): Extract<AgentMuxClientEvent, { type: 'connection-state' }> {
  return { type: 'connection-state', state, observationOrigin: { kind: 'runtime-connection', boundary }, evidence: { source: 'agentmux', observedAt: 100 } }
}
function source() {
  const listeners = new Set<(event: AgentMuxClientEvent) => void>()
  const rpc = vi.fn(async (method: string, input: any): Promise<any> => {
    if (method === 'app.mobile.report') return receipt(input)
    if (method === 'app.mobile.assets.loaded') return { ...input, hostId: 'original-host', producer: { devicePrincipalId: 'authenticated-device', documentId: input.documentId }, hostInstanceId: 'original-host-instance', receivedAt: 200, accepted: true, reason: null }
    if (method === 'app.mobile.assets.inspect') return inspection(input.client)
    throw new Error('Unconfigured exact source: ' + method)
  })
  const client = { forwardRpc: rpc, onEvent: (listener: (event: AgentMuxClientEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    dispose: vi.fn(), disconnect: vi.fn(), submitAgentPrompt: vi.fn() } as unknown as AgentMuxHostedClient
  return { client, rpc, emit(event: AgentMuxClientEvent) { for (const listener of listeners) listener(event) } }
}
function reporter(client = source()) { const owner = new MobileWebReporter(page); owner.bindClient(client.client); return { owner, ...client } }
function inspection(target = { devicePrincipalId: 'authenticated-device', documentId: page.documentId }): MobileAssetsInspection {
  const loaded: MobileAssetsLoadedReceipt = { ...page, hostId: 'original-host', producer: target, hostInstanceId: 'original-host-instance', occurrenceId: 'original-loaded', observedAt: 100, receivedAt: 200, accepted: true, reason: null }
  const release = { buildId: page.buildId, digest: page.namespaceDigest, bytes: 100, fileCount: 2 }
  return { hostId: loaded.hostId, hostInstanceId: loaded.hostInstanceId, active: { ...release, revision: 1 }, retained: [release], retention: 'active-and-previous', operation: null,
    clients: [loaded], client: { target, availability: 'found', loaded, namespace: 'retained' }, coverage: { lifetime: 'current-host-instance', operationsRetained: 0, operationsEvicted: 0, loadedRetained: 1, loadedRejected: 0 }, observedAt: 300 }
}
const mounted: Array<{ root: Root; element: HTMLElement }> = []
async function mount(content: ReactNode) {
  const element = document.createElement('div'); document.body.appendChild(element); const root = createRoot(element); mounted.push({ root, element })
  const render = async (next: ReactNode) => { await act(async () => { root.render(next); await settle() }) }
  await render(content); return { element, render }
}
const button = (element: ParentNode, text: string) => [...element.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes(text) || item.getAttribute('aria-label') === text)!
const click = async (element: HTMLElement) => { expect(element).toBeDefined(); await act(async () => { element.click(); await settle() }) }
beforeEach(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); localStorage.clear()
  history.replaceState(null, '', '/mobile/reviewed-page-build/' + 'a'.repeat(64) + '/index.html') })
afterEach(async () => { for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() } vi.restoreAllMocks() })

it('reports original issue-field presence without reading its text, code or name', async () => {
  const f = reporter(); f.owner.setConnected(true)
  const value = catalog(['["local","/opaque-original"]'])
  Object.defineProperty(value.spaces[0]!, 'issue', { get() { throw new Error('private text must never be read') } })
  f.owner.observeCatalog(value); await settle()
  expect(f.rpc).toHaveBeenCalledTimes(1)
  const report = f.rpc.mock.calls[0]![1] as MobileWebReportParams
  expect(report.observation).toEqual({ kind: 'catalog-partial', source: 'space.ls', code: null, issueCount: 1, spaceIds: ['["local","/opaque-original"]'], omittedCount: 0 })
  expect(JSON.stringify(report)).not.toContain('private')
})
it('deduplicates an unchanged partial projection, then records a recurrence after a clean original catalog', async () => {
  const f = reporter(); f.owner.setConnected(true)
  f.owner.observeCatalog(catalog(['space-one'])); await settle()
  f.owner.observeCatalog(catalog(['space-one'], 'new presentation wording')); await settle()
  expect(f.rpc).toHaveBeenCalledTimes(1)
  f.owner.observeCatalog({ spaces: [] }); f.owner.observeCatalog(catalog(['space-one'])); await settle()
  expect(f.rpc).toHaveBeenCalledTimes(2)
  expect(f.rpc.mock.calls[0]![1].occurrenceId).not.toBe(f.rpc.mock.calls[1]![1].occurrenceId)
})
it('keeps at most four complete opaque references with truthful omitted counts and report bytes', async () => {
  const f = reporter(); f.owner.setConnected(true)
  f.owner.observeCatalog(catalog(['原'.repeat(5000), 'one', 'two', 'three', 'four', 'five'])); await settle()
  const report = f.rpc.mock.calls[0]![1] as MobileWebReportParams
  expect(report.observation).toEqual({ kind: 'catalog-partial', source: 'space.ls', code: null, issueCount: 6, spaceIds: ['one', 'two', 'three', 'four'], omittedCount: 2 })
  expect(new TextEncoder().encode(JSON.stringify(report)).byteLength).toBeLessThanOrEqual(4096)
})
it('admits the same previously dropped partial after the real queue drains', async () => {
  const f = reporter()
  for (let index = 0; index < 16; index++) f.owner.observeCatalog(catalog(['queued-' + index]))
  f.owner.observeCatalog(catalog(['pending-original'])); f.owner.observeCatalog(catalog(['pending-original']))
  expect(f.owner.snapshot()).toMatchObject({ queuedCount: 16, droppedCount: 1 })
  expect(f.owner.snapshot().queuedBytes).toBeLessThanOrEqual(64 * 1024)
  f.owner.setConnected(true); await vi.waitFor(() => expect(f.owner.snapshot().queuedCount).toBe(0), { interval: 1, timeout: 1000 })
  f.owner.observeCatalog(catalog(['pending-original'])); await settle()
  expect(f.rpc).toHaveBeenCalledTimes(17)
  expect(f.rpc.mock.calls[16]![1].observation.spaceIds).toEqual(['pending-original'])
})
it('shares one actual IO slot across A pending → B → C without retargeting the original report', async () => {
  const a = source(), b = source(), c = source(), pending = deferred<MobileWebReportReceipt>()
  a.rpc.mockImplementation(() => pending.promise)
  const { owner } = reporter(a); owner.setConnected(true); owner.observeCatalog(catalog(['a-original']))
  for (let index = 0; index < 15; index++) owner.observeCatalog(catalog(['a-waiting-' + index]))
  expect(owner.snapshot().queuedCount).toBe(16)
  owner.bindClient(b.client); owner.setConnected(true); owner.observeCatalog(catalog(['b-original']))
  owner.bindClient(c.client); owner.setConnected(true)
  for (let index = 0; index < 17; index++) owner.observeCatalog(catalog(['c-' + index]))
  expect(owner.snapshot().queuedCount).toBe(16); expect(owner.snapshot().inFlight).toBe(true)
  expect(b.rpc).not.toHaveBeenCalled(); expect(c.rpc).not.toHaveBeenCalled()
  const original = a.rpc.mock.calls[0]![1] as MobileWebReportParams
  pending.resolve(receipt(original)); await vi.waitFor(() => expect(owner.snapshot().queuedCount).toBe(0), { interval: 1, timeout: 1000 })
  expect(a.rpc).toHaveBeenCalledTimes(1); expect(b.rpc).not.toHaveBeenCalled(); expect(c.rpc).toHaveBeenCalledTimes(15)
  for (const [, input] of c.rpc.mock.calls) expect(input.observation.spaceIds[0]).toMatch(/^c-/u)
  expect(owner.snapshot()).toMatchObject({ queuedCount: 0, inFlight: false })
})
it('preserves a failed original occurrence for explicit diagnostic retry', async () => {
  const f = reporter(); f.rpc.mockRejectedValueOnce(new Error('private archive unavailable')); f.owner.setConnected(true)
  f.owner.observeCatalog(catalog(['space-original'])); await settle()
  expect(f.owner.snapshot()).toMatchObject({ queuedCount: 1, inFlight: false })
  const original = structuredClone(f.rpc.mock.calls[0]![1])
  f.owner.retry(); await settle()
  expect(f.rpc.mock.calls[1]![1]).toEqual(original)
  expect(f.owner.snapshot().queuedCount).toBe(0)
})
it('reports Native loss over a healthy consumer RPC and does not let Native restoration reopen a lost consumer', async () => {
  const f = reporter(); f.owner.setConnected(true)
  f.owner.observeConnection(connection('lost', 'core-ctxmux')); await settle()
  expect(f.rpc).toHaveBeenCalledTimes(1)
  f.owner.observeConnection(connection('lost')); f.owner.observeConnection(connection('restored', 'core-ctxmux')); await settle()
  expect(f.rpc).toHaveBeenCalledTimes(1)
  f.owner.observeConnection(connection('restored')); await settle()
  expect(f.rpc).toHaveBeenCalledTimes(4)
})
it('connects successful partial catalog consumption to reporting while a report failure leaves original navigation readable', async () => {
  const f = source(), owner = new MobileWebReporter(page); owner.bindClient(f.client); owner.setConnected(true)
  f.rpc.mockImplementation(async (method, input) => {
    if (method === 'space.ls') return { catalog: { ...catalog(['space-original']), zones: [], tabs: [], regions: [], bindings: [], locations: [], agentPresentation: [] } }
    if (method === 'app.mobile.report') throw new Error('archive denied')
    throw new Error('Unconfigured method ' + method)
  })
  const view = await mount(<MobileWebCatalogObservation.Provider value={owner.observeCatalog}><MobileSpatialNavigation home="focus" client={f.client} connected sessions={[]} openSession={() => {}} /></MobileWebCatalogObservation.Provider>)
  expect(f.rpc.mock.calls.filter(([method]) => method === 'app.mobile.report')).toHaveLength(1)
  expect(view.element.textContent).toContain('private original issue')
  expect(view.element.textContent).not.toContain('空间目录暂不可读')
  expect(owner.snapshot().issue).toContain('报送未确认')
})

it('reports the compiled page build and authentic receipt target; refresh only reads that exact Host/page', async () => {
  const f = source(); let value!: MobileWebPageObservation
  function Probe() { value = useMobileWebObservation(f.client, true).observation!; return <textarea defaultValue="original draft" /> }
  const view = await mount(<Probe />), originalEditor = view.element.querySelector('textarea')!
  expect(f.rpc.mock.calls[0]![0]).toBe('app.mobile.assets.loaded')
  expect(f.rpc.mock.calls[0]![1].buildId).toBe('reviewed-page-build')
  expect(f.rpc.mock.calls[0]![1].namespaceDigest).toBe(page.namespaceDigest)
  const originalInput = structuredClone(f.rpc.mock.calls[0]![1])
  await act(async () => { await value.refresh() })
  expect(f.rpc.mock.calls[1]).toEqual(['app.mobile.assets.inspect', { hostId: 'original-host', client: { devicePrincipalId: 'authenticated-device', documentId: originalInput.documentId } }])
  await act(async () => { f.emit(connection('lost', 'core-ctxmux')); await settle() })
  expect(value.connected).toBe(true)
  expect(view.element.querySelector('textarea')).toBe(originalEditor); expect(originalEditor.value).toBe('original draft')
  expect(f.client.dispose).not.toHaveBeenCalled(); expect(f.client.disconnect).not.toHaveBeenCalled(); expect(f.client.submitAgentPrompt).not.toHaveBeenCalled()
  history.replaceState(null, '', '/mobile/reviewed-page-build/' + 'b'.repeat(64) + '/index.html')
  await act(async () => { value.retryReports(); await settle() })
  const reports = f.rpc.mock.calls.filter(([method]) => method === 'app.mobile.assets.loaded')
  expect(reports[1]![1]).toEqual(originalInput)
})
it('does not adopt an old client loaded reply after another original connection replaces it', async () => {
  const a = source(), b = source(), pending = deferred<MobileAssetsLoadedReceipt>(); a.rpc.mockImplementation(() => pending.promise)
  let value!: MobileWebPageObservation
  function Probe({ client }: { client: AgentMuxHostedClient }) { value = useMobileWebObservation(client, true).observation!; return null }
  const view = await mount(<Probe client={a.client} />)
  await view.render(<Probe client={b.client} />)
  const original = a.rpc.mock.calls[0]![1]
  await act(async () => { pending.resolve({ ...original, hostId: 'old-host', producer: { devicePrincipalId: 'old-device', documentId: original.documentId }, hostInstanceId: 'old-instance', receivedAt: 400, accepted: true, reason: null }); await settle() })
  expect(value.loaded.result?.hostId).toBe('original-host')
  await act(async () => { await value.refresh() })
  expect(b.rpc.mock.calls.at(-1)![1].hostId).toBe('original-host')
})
function uiValue(): MobileWebPageObservation {
  const original = inspection()
  return { page, connected: true, loaded: { pending: false, result: original.client!.loaded, issue: null }, inspection: { pending: false, result: original, issue: null },
    reporter: { inFlight: false, queuedCount: 0, queuedBytes: 0, droppedCount: 0, receipt: null, issue: null }, refresh: vi.fn(async () => {}), retryReports: vi.fn() }
}
it('keeps prior version observations readable without presenting a failed current query as current success', async () => {
  const value = uiValue(), render = (next: MobileWebPageObservation) => <MobileNoticeProvider><MobileWebDiagnostics observation={next} copyText={vi.fn(async () => true)} /></MobileNoticeProvider>
  const view = await mount(render(value)); expect(view.element.textContent).toContain('本页已载入当前版本')
  await click(button(view.element, '网页版本与诊断'))
  await view.render(render({ ...value, inspection: { ...value.inspection, issue: '本次查询未确认' } }))
  expect(view.element.textContent).not.toContain('本页已载入当前版本')
  expect(view.element.textContent).toContain('版本查询未确认 · 保留上次观察')
  expect(view.element.textContent).toContain('original-build')
  await click(button(view.element, '收起提醒'))
  expect(view.element.textContent).not.toContain('本次查询未确认')
  expect(view.element.querySelector('button')?.getAttribute('aria-expanded')).toBe('true')
})
it('never adopts a pending copy acknowledgement under a different original query reference', async () => {
  const value = uiValue(), pending = deferred<boolean>(), copyText = vi.fn(() => pending.promise)
  const render = (next: MobileWebPageObservation) => <MobileWebDiagnostics observation={next} copyText={copyText} />
  const view = await mount(render(value)); await click(button(view.element, '网页版本与诊断'))
  await click(button(view.element, '复制原查询信息'))
  await view.render(render({ ...value, page: { ...page, documentId: 'another-document' } }))
  await act(async () => { pending.resolve(true); await settle() })
  expect(view.element.textContent).not.toContain('已复制原页面')
  expect(JSON.parse(copyText.mock.calls[0]![0]).page.documentId).toBe(page.documentId)
  expect(button(view.element, '刷新页面版本查询')).toBeDefined()
})
it('does not call an old page current when the same buildId now serves another complete release digest', async () => {
  const value = uiValue()
  value.inspection.result!.active!.digest = 'sha256:' + 'b'.repeat(64)
  value.inspection.result!.client!.namespace = 'not-retained'
  const view = await mount(<MobileNoticeProvider><MobileWebDiagnostics observation={value} copyText={vi.fn(async () => true)} /></MobileNoticeProvider>)
  expect(view.element.textContent).not.toContain('本页已载入当前版本')
  expect(view.element.textContent).toContain('有版本待载入')
  await click(button(view.element, '网页版本与诊断'))
  expect(view.element.textContent).toContain('旧资源已超出')
})
it('keeps the actual ConnectionRoot on its original client and document when Native changes, and follows only consumer connection changes', async () => {
  const f = source()
  connectionPort.connect.mockResolvedValue(f.client)
  const offer = { v: 2 as const, serverId: 'private-original-host', daemonPublicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', relay: { endpoint: '127.0.0.1:1', useTls: false } }
  const view = await mount(<MobileConnectionRoot platform={{} as ClientUiPlatform} native={false} offer={offer} />)
  const originalEditor = view.element.querySelector('textarea')!, documentId = view.element.firstElementChild!.getAttribute('data-document')
  expect(view.element.firstElementChild!.getAttribute('data-connection')).toBe('connected')
  for (const state of ['lost', 'restored'] as const) {
    await act(async () => { f.emit(connection(state, 'core-ctxmux')); await settle() })
    expect(view.element.firstElementChild!.getAttribute('data-connection')).toBe('connected')
    expect(view.element.firstElementChild!.getAttribute('data-document')).toBe(documentId)
    expect(view.element.querySelector('textarea')).toBe(originalEditor)
  }
  await act(async () => { f.emit(connection('lost')); await settle() })
  expect(view.element.firstElementChild!.getAttribute('data-connection')).toBe('disconnected')
  await act(async () => { f.emit(connection('restored')); await settle() })
  expect(view.element.firstElementChild!.getAttribute('data-connection')).toBe('connected')
  expect(view.element.querySelector('textarea')).toBe(originalEditor)
  expect(connectionPort.connect).toHaveBeenCalledTimes(1)
  expect(f.client.dispose).not.toHaveBeenCalled()
})
