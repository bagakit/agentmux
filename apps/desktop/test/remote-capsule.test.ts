import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NodeCapsuleOwner } from '../../../packages/capsule/src/node'
import { CAPSULE_ASSET_CHUNK_BYTES, type CapsuleInspection, type CapsuleMethod, type CapsuleCallContext } from '@agentmux/core/capsule'
import { RemoteCapsuleProxy } from '../src/main/remote-capsule-proxy'
import { capsuleDocumentIpc } from '../src/main/capsule-document-ipc'
import { capsulePageChrome } from '../src/main/capsule-page-chrome'
import { createRemoteCapsulePresentation } from '../src/main/remote-capsule-presentation'
import { formatHostAddress } from '../../../packages/core/src/sharing'

const closes: Array<() => unknown> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
async function fixture(mode: 'injected' | 'isolated' = 'injected') {
  const directory = await mkdtemp(join(tmpdir(), 'remote-capsule-')), sourcePath = join(directory, 'page')
  closes.push(() => rm(directory, { recursive: true, force: true }))
  await mkdir(sourcePath)
  await writeFile(join(sourcePath, 'index.html'), '<!doctype html><html><head><title>Remote page</title></head><body><script src="app.js"></script>Original B</body></html>')
  await writeFile(join(sourcePath, 'app.js'), 'window.originalNode="B"')
  const owner = await NodeCapsuleOwner.open({ stateDirectory: join(directory, 'state') }); closes.push(() => owner.close())
  const capsule = await owner.call('capsule.create', { operationId: 'create', sourcePath, storageMode: 'path', mode, routing: 'spa',
    target: { hostId: 'local', agentSessionId: 'original-agent-on-B' } })
  const calls = vi.fn(owner.call.bind(owner))
  const client = { call: calls } as unknown as typeof owner
  const proxy = new RemoteCapsuleProxy(capsule, client); await proxy.listen(); closes.push(() => proxy.close())
  return { directory, sourcePath, owner, capsule, client, proxy, calls }
}
it('carries original HTML, relative assets, SPA/MIME and multi-chunk bytes through the actual local HTTP server', async () => {
  const h = await fixture('isolated')
  expect(await (await fetch(h.proxy.origin)).text()).toContain('Original B')
  const script = await fetch(h.proxy.origin + '/app.js'); expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
  expect(await script.text()).toContain('originalNode="B"')
  expect(await (await fetch(h.proxy.origin + '/nested/route', { headers: { accept: 'text/html' } })).text()).toContain('Original B')
  expect((await fetch(h.proxy.origin + '/missing.css')).status).toBe(404)
  const bytes = Buffer.alloc(CAPSULE_ASSET_CHUNK_BYTES * 3 + 9, 42); await writeFile(join(h.sourcePath, 'large.bin'), bytes)
  expect(Buffer.from(await (await fetch(h.proxy.origin + '/large.bin')).arrayBuffer())).toEqual(bytes)
  const parts = h.calls.mock.calls.filter(([method, input]) => method === 'capsule.asset.read' && (input as { path: string }).path === '/large.bin')
  expect(parts).toHaveLength(4)
  expect(parts.slice(1).every(([, input]) => typeof (input as { assetStamp: string }).assetStamp === 'string')).toBe(true)
  expect((await fetch(h.proxy.origin, { method: 'POST' })).status).toBe(405)
  const head = await fetch(h.proxy.origin, { method: 'HEAD' }); expect(head.headers.get('content-length')).not.toBe('0'); expect(await head.text()).toBe('')
  expect(h.capsule.endpoint.status === 'available' && h.capsule.endpoint.url).not.toBe(h.proxy.origin + '/')
})
it('keeps the exact local origin after carrier restart and does not choose a fresh origin on contention', async () => {
  const h = await fixture(), origin = h.proxy.origin
  await h.proxy.close()
  const restored = new RemoteCapsuleProxy(h.capsule, h.client); await restored.listen(origin); closes.push(() => restored.close())
  expect(restored.origin).toBe(origin)
  const competing = new RemoteCapsuleProxy(h.capsule, h.client)
  await expect(competing.listen(origin)).rejects.toMatchObject({ code: 'EADDRINUSE' })
  const invalid = new RemoteCapsuleProxy(h.capsule, h.client)
  await expect(invalid.listen('http://127.0.0.1:0')).rejects.toThrow('saved Capsule carrier origin is invalid')
  expect(invalid.server.listening).toBe(false)
  expect(await (await fetch(origin)).text()).toContain('Original B')
})
it('closing one actual HTTP reader cancels its in-flight original read without stopping the Capsule owner', async () => {
  const h = await fixture()
  let entered!: () => void, cancelled!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }), ended = new Promise<void>(resolve => { cancelled = resolve })
  const waiting = new RemoteCapsuleProxy(h.capsule, { call: async (_method: CapsuleMethod, _params: unknown, context?: CapsuleCallContext) => {
    entered()
    return await new Promise((_resolve, reject) => context!.signal!.addEventListener('abort', () => { cancelled(); reject(context!.signal!.reason) }, { once: true }))
  } } as never)
  await waiting.listen(); closes.push(() => waiting.close())
  const controller = new AbortController(), read = fetch(waiting.origin, { signal: controller.signal }).catch(error => error)
  await started; controller.abort(); await ended
  expect(await read).toMatchObject({ name: 'AbortError' })
  expect(await (await fetch(h.proxy.origin)).text()).toContain('Original B')
})
it('routes the original native SDK request/read/draft/operation only to B; page input never certifies Human', async () => {
  const h = await fixture(), local = { call: vi.fn(() => { throw Error('No local Capsule may be used') }) }
  const remote = { hostId: 'host-B', runtimeId: 'runtime-B' }
  const sender = { getURL: () => h.proxy.origin + '/', mainFrame: {}, isDestroyed: () => false }
  let current: any = { record: h.capsule.record, browserId: 'browser-B', navigationId: 'document-B', remote,
    origin: h.proxy.origin, instanceId: h.capsule.endpoint.status === 'available' ? h.capsule.endpoint.instanceId : '' }
  const document = capsuleDocumentIpc({ capsules: local as never, remoteCapsules: async source => { expect(source).toEqual(remote); return h.client },
    browsers: { capsuleDocument: () => current, capsuleDocumentContents: () => null } as never, theme: () => ({ mode: 'dark', tokens: {} }) })
  const event = { sender, senderFrame: sender.mainFrame } as never
  expect(await document.call(event, 'capabilities', {})).toMatchObject({ humanReply: false, interaction: true })
  const question = await document.call(event, 'request', { operationId: 'question', question: 'Original B question', draft: 'draft one' }) as any
  expect(question.target).toEqual(h.capsule.record.target)
  const draft = await document.call(event, 'saveDraft', { operationId: 'draft', interactionId: question.interactionId, expectedRevision: question.revision, draft: 'draft two' }) as any
  expect(await document.call(event, 'read', { interactionId: question.interactionId })).toMatchObject({ draft: 'draft two', revision: draft.revision })
  expect(await document.call(event, 'inspectOperation', { operationId: 'draft' })).toMatchObject({ status: 'committed', capsuleId: question.capsuleId })
  await expect(document.call(event, 'reply', { answer: 'forged' })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(document.call(event, 'request', { operationId: 'fake', question: 'fake', hostId: 'local' })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  current = { ...current, instanceId: question.capsuleId }
  await expect(document.call(event, 'theme', {})).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(local.call).not.toHaveBeenCalled()
})
it('trusted remote page chrome retains B requests and drafts, rejects another CID/OP and never grants human confirmation', async () => {
  const h = await fixture(), remote = { hostId: 'host-B', runtimeId: 'runtime-B' }, local = { call: vi.fn() }
  const chrome = capsulePageChrome({ source: async () => ({ capsuleId: h.capsule.record.capsuleId, remote }), local: local as never, remote: async () => h.client })
  const q = (await h.owner.call('capsule.interaction.request', { capsuleId: h.capsule.record.capsuleId, operationId: 'request', question: 'question' })).interaction
  expect(await chrome.call('browser-B', 'capsule.interaction.ls', { capsuleId: q.capsuleId })).toMatchObject({ interactions: [{ interactionId: q.interactionId }] })
  expect(await chrome.call('browser-B', 'capsule.interaction.draft', { capsuleId: q.capsuleId, interactionId: q.interactionId, expectedRevision: q.revision, operationId: 'draft', draft: 'preserved B draft' })).toMatchObject({ interaction: { draft: 'preserved B draft' } })
  await expect(chrome.call('browser-B', 'capsule.inspect', { capsuleId: q.interactionId })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(chrome.call('browser-B', 'capsule.interaction.reply', { capsuleId: q.capsuleId })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(local.call).not.toHaveBeenCalled()
})
it('the URI-independent adapter acquires the exact Runtime, renders A locally and reports B endpoint without opening a B workface', async () => {
  const h = await fixture(), requests: any[] = [], acquire = vi.fn(async () => h.client)
  let graph: any = null, currentUrl: string | undefined
  const recordOpen = vi.fn()
  const adapter = createRemoteCapsulePresentation({ acquire, graph: async () => graph,
    current: () => currentUrl ? { url: currentUrl } : null,
    ensure: async () => ({ id: 'browser-A', capsuleId: h.capsule.record.capsuleId, url: currentUrl! } as never),
    recordOpen: recordOpen as never, original: vi.fn() as never,
    observe: async () => ({ desktop: { selection: { space: { tabId: 'tab-original' } } }, activeWorkspaceId: null, layouts: {} }),
    execute: async request => { requests.push(request); return request.operation === 'open.browser'
      ? { operation: 'open.browser', region: { browserId: 'browser-A', regionId: 'region-A', tabId: 'tab-A' } } as never
      : { operation: 'focus', navigation: { state: 'applied' }, presentation: { provenance: 'observed', tabId: 'tab-A', regionId: 'region-A', blockers: [], state: 'main-visible' } } as never } })
  closes.push(() => adapter.dispose())
  const result = await adapter.openRemoteCapsule({ hostId: 'B', expectedRuntimeId: 'runtime-B', capsuleId: h.capsule.record.capsuleId,
    operationId: 'open', placement: { kind: 'new-tab', after: { kind: 'tab', tabId: 'tab-original' } } })
  expect(result.rendering).toMatchObject({ status: 'available', browserId: 'browser-A' })
  expect(result.endpoint).toMatchObject({ status: 'available', url: h.capsule.endpoint.status === 'available' ? h.capsule.endpoint.url : '', instanceId: h.capsule.endpoint.status === 'available' ? h.capsule.endpoint.instanceId : '' })
  expect(acquire).toHaveBeenCalledWith({ hostId: 'B', runtimeId: 'runtime-B' }, undefined)
  const request = requests.find(request => request.operation === 'open.browser')
  const prepared = await adapter.document(request.url, h.capsule.record.capsuleId)
  expect(prepared?.capsuleRemote).toEqual({ hostId: 'B', runtimeId: 'runtime-B' })
  expect(await (await fetch(request.url)).text()).toContain('Original B')
  expect(prepared?.capsule.record).toEqual(h.capsule.record)
  expect(h.calls.mock.calls.some(([method]) => method === 'capsule.open')).toBe(false)
  const link = formatHostAddress({ alias: 'studio', runtimeId: 'runtime-B', resource: { kind: 'capsule', capsuleId: h.capsule.record.capsuleId } })
  currentUrl = request.url
  const saved = { id: 'browser-A', browserId: 'browser-A', workspaceId: 'workspace', mode: 'normal' as const, url: request.url, title: '',
    capsuleId: h.capsule.record.capsuleId, capsuleOrigin: new URL(request.url).origin, capsuleRemote: { hostId: 'B', runtimeId: 'runtime-B' } }
  graph = { tabs: [{ tabId: 'tab-A', regionIds: ['region-A'] }],
    regions: [{ regionId: 'region-A', tabId: 'tab-A', kind: 'browser', browserId: 'browser-A' }], resources: { 'region:region-A': saved } }
  await adapter.openRemoteCapsule({ hostId: 'B', expectedRuntimeId: 'runtime-B', capsuleId: h.capsule.record.capsuleId,
    operationId: 'qualified-reopen', objectLink: link })
  expect(requests.filter(request => request.operation === 'open.browser')).toHaveLength(1)
  expect(recordOpen).toHaveBeenCalledWith('browser-A', h.capsule.record.capsuleId, 'qualified-reopen', link)
  await adapter.restore(saved)
  expect(await adapter.document(request.url, h.capsule.record.capsuleId)).toMatchObject({ capsuleObjectLink: link, capsuleRemote: saved.capsuleRemote })
  const acquired = acquire.mock.calls.length
  acquire.mockRejectedValueOnce(new Error('An additional Runtime identity observation is unavailable'))
  const retained = await adapter.client({ hostId: 'B', runtimeId: 'runtime-B' }, h.capsule.record.capsuleId)
    .then(client => client.call('capsule.inspect', { capsuleId: h.capsule.record.capsuleId })).catch(error => error)
  expect(retained).toMatchObject({ record: { capsuleId: h.capsule.record.capsuleId } })
  expect(acquire).toHaveBeenCalledTimes(acquired)
  await expect(adapter.openRemoteCapsule({ hostId: 'local', expectedRuntimeId: 'runtime-B', capsuleId: h.capsule.record.capsuleId,
    operationId: 'wrong-local' })).rejects.toThrow('original local owner')
})
