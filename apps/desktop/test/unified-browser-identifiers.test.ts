import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { afterEach, expect, it, vi } from 'vitest'
import { ExternalBrowserBridge } from '../src/main/browser-external-bridge'

class Signal { addListener() {} }
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.unstubAllGlobals() })
let Worker: any
async function fixture(legacy = false) {
  const directory = await mkdtemp(join(tmpdir(), 'agentmux-identity-consumer-'))
  const tab = { id: 7, url: 'https://fixture.invalid/original', title: 'Original page' }
  const legacyId = '11111111-1111-4111-8111-111111111111'
  let state: any = legacy ? { instanceId: legacyId, grants: [{ tabId: tab.id, grantId: legacyId, navigationId: 'original-cdp-loader', url: tab.url, title: tab.title }] } : {}
  if (legacy) await writeFile(join(directory, 'bindings.json'), JSON.stringify({ version: 1, targets: [{ ...state.grants[0], id: legacyId,
    workspaceId: 'original-workspace', extensionId: 'a'.repeat(32), instanceId: legacyId, status: 'disconnected' }] }))
  const bridge = new ExternalBrowserBridge(join(directory, 'bindings.json'))
  const signal = new Signal()
  const chrome = { storage: { session: { get: async () => structuredClone(state), set: async (next: any) => { state = structuredClone(next) } } },
    runtime: { onMessage: signal, getURL: (name: string) => 'chrome-extension://' + 'a'.repeat(32) + '/' + name },
    tabs: { onRemoved: signal, onUpdated: signal, get: async () => tab, query: async () => [tab] },
    debugger: { onDetach: signal, onEvent: signal, attach: vi.fn(), detach: vi.fn() } }
  class Socket extends WebSocket { constructor(url: string) { super(url, { origin: 'chrome-extension://' + 'a'.repeat(32) }) } }
  vi.stubGlobal('chrome', chrome); vi.stubGlobal('WebSocket', Socket)
  let worker: any
  if (!Worker) { const module = await import('../browser-extension/service-worker.js'); Worker = module.SharedTabWorker; worker = module.worker }
  else { worker = new Worker(chrome, Socket); worker.start() }
  await worker.ready
  const pairing = await bridge.createPairing('original-workspace')
  await worker.popup({ type: 'connect', link: pairing.link })
  cleanup.push(async () => { worker.disconnect('Consumer complete'); await bridge.dispose(); await rm(directory, { recursive: true, force: true }) })
  return { worker, bridge, chrome, tab, state: () => state, pairing, legacyId }
}
it('passes freshly allocated short identities through the actual extension and loopback bridge', async () => {
  const f = await fixture(), pending = f.worker.popup({ type: 'share', tabId: f.tab.id })
  await expect(pending).resolves.toEqual({ bindingId: expect.any(String) })
  const result = await pending
  const binding = f.bridge.require(result.bindingId)
  for (const id of [f.worker.instanceId, binding.grantId, binding.id, binding.connection?.id, binding.navigationId]) expect(id).toMatch(/^[1-9A-HJ-NP-Za-km-z]{12}$/)
  expect(f.state().instanceId).toBe(binding.instanceId)
  expect(f.state().grants[0].grantId).toBe(binding.grantId)
  expect(f.chrome.debugger.attach).not.toHaveBeenCalled()
})
it('retains the original extension UUID and grant while preserving the external loader identity', async () => {
  const f = await fixture(true)
  const [binding] = f.bridge.list()
  expect(binding).toBeDefined()
  const exact = f.bridge.require(binding!.id)
  expect(exact.instanceId).toBe(f.legacyId); expect(exact.grantId).toBe(f.legacyId)
  expect(exact.navigationId).toBe('original-cdp-loader')
  expect(f.state().instanceId).toBe(f.legacyId); expect(f.state().grants[0].grantId).toBe(f.legacyId)
  expect(f.chrome.debugger.attach).not.toHaveBeenCalled()
})
it('rejects a different original pairing instance without selecting a replacement shared tab', async () => {
  const f = await fixture(), pending = f.worker.popup({ type: 'share', tabId: f.tab.id })
  await expect(pending).resolves.toEqual({ bindingId: expect.any(String) })
  const result = await pending
  const original = f.bridge.require(result.bindingId)
  f.worker.instanceId = '222222222222'
  await expect(f.worker.popup({ type: 'connect', link: f.pairing.link })).rejects.toThrow()
  expect(f.bridge.list()).toHaveLength(1); expect(f.bridge.require(original.id).grantId).toBe(original.grantId)
  expect(f.chrome.debugger.attach).not.toHaveBeenCalled()
})
