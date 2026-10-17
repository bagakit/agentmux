const { fixtureEpoch: _batchFixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'
import type { BrowserInputImageReference, BrowserInputContext } from '@agentmux/core/browser-input-context'
import { createBrowserInputContextPorts, registerBrowserInputContextIpc } from '../src/main/browser-input-context-ipc'
import { browserPngFromBytes } from '../src/main/browser-image'
import { senderTrust, assertSenderTrusted } from '../src/main/ipc-sender-trust'

const bridge = vi.hoisted(() => { vi.stubGlobal('window', {}); return { api: null as AgentMuxPreloadApi | null, invoke: vi.fn() } })
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (_key: string, api: AgentMuxPreloadApi) => { bridge.api = api } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), removeListener: vi.fn() }, webFrame: { getZoomFactor: () => 1 } }))
import '../src/preload/index'

const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6V8AAAAASUVORK5CYII=', 'base64')
const homes: string[] = []
afterEach(async () => { vi.restoreAllMocks(); bridge.invoke.mockReset(); await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'amux-selection-ipc-')); homes.push(home)
  const context: BrowserInputContext = { kind: 'browser', version: 1, capturedAt: _batchFixtureEpoch(0, 0, 12),
    browser: { hostId: 'local', browserId: 'page', navigationId: 'original-nav' }, page: { url: 'https://page.invalid/original' } }
  const browsers = { inputContext: vi.fn(() => context), captureInputFrame: vi.fn(async () => ({ before: context, after: context,
    capture: { browserId: 'page', navigationId: 'original-nav', image: browserPngFromBytes(bytes),
      source: { url: context.page.url, title: null, viewport: null, viewportWarning: 'Unknown viewport' } } })) }
  // Unit transport/decoder only. Root's final native join exercises real pixels and the full Main shell.
  const createFromBuffer = vi.fn(() => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }) }))
  const ports = createBrowserInputContextPorts({ hostId: 'local', home, directory: join(home, 'scenes'), browsers, createFromBuffer: createFromBuffer as never })
  const trusted = {}, handlers = new Map<string, (...args: any[]) => any>()
  registerBrowserInputContextIpc({ ...ports, handle: (channel, handler) => { handlers.set(channel, handler) },
    trust: (channel, event) => assertSenderTrusted(senderTrust(channel, event.sender, trusted)) })
  bridge.invoke.mockImplementation((channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: trusted }, ...args))
  const api = bridge.api!.browser
  const scene = await api.captureInputContext('page'), frame = await api.captureInputFrame('page')
  const input = { operationId: 'selection-intent', scene: scene.reference, frame: frame.scene.reference,
    region: { x: 0, y: 0, width: 1, height: 1, space: 'capture-pixels' as const }, png: browserPngFromBytes(bytes) }
  return { home, browsers, createFromBuffer, ports, handlers, trusted, api, input }
}

describe('Browser selection trusted IPC and exact resource read', () => {
  it('connects actual preload, Main constructor ports and the original scene/writer/read owners', async () => {
    const f = await fixture(), receipt = await f.api.prepareInputSelection(f.input)
    expect(f.browsers.captureInputFrame).toHaveBeenCalledWith('page', 'local')
    expect(f.browsers.inputContext).toHaveBeenCalledWith('page', 'local')
    expect(await f.api.readInputSelection(f.input.operationId)).toMatchObject({ state: 'prepared', receipt })
    const reference = receipt.scene.inputContext.selection!.attachment!
    expect(await f.api.readSelectionImage(reference)).toEqual({ dataUrl: `data:image/png;base64,${bytes.toString('base64')}` })
    expect(await readFile(reference.path)).toEqual(bytes)
    expect(f.createFromBuffer).toHaveBeenCalledWith(bytes)
    expect(bridge.invoke.mock.calls.map(call => call[0])).toEqual(['browser:captureInputContext', 'browser:captureInputFrame',
      'browser:prepareInputSelection', 'browser:readInputSelection', 'browser:readSelectionImage'])
  })

  it.each(['browser:captureInputFrame', 'browser:prepareInputSelection', 'browser:readInputSelection', 'browser:readSelectionImage'])('refuses a page sender before %s reaches its owner', async channel => {
    const f = await fixture(), methods = ['captureFrame', 'prepareSelection', 'readSelection'] as const
    const called = methods.map(method => vi.spyOn(f.ports.captures, method)), read = vi.spyOn(f.ports, 'readSelectionImage')
    const parameter = channel === 'browser:captureInputFrame' ? 'page' : channel === 'browser:prepareInputSelection' ? f.input :
      channel === 'browser:readInputSelection' ? f.input.operationId : { hostId: 'local', path: 'missing.png', mimeType: 'image/png', sha256: '0'.repeat(64), width: 1, height: 1 }
    await expect(Promise.resolve().then(() => f.handlers.get(channel)!({ sender: {} }, parameter))).rejects.toThrow('Untrusted Browser input scene sender')
    for (const spy of [...called, read]) expect(spy).not.toHaveBeenCalled()
  })

  it.each(['host', 'missing-hash', 'hash', 'mime', 'width', 'height', 'missing'] as const)('keeps a mismatched %s reference unavailable without replacing its original', async mismatch => {
    const f = await fixture(), receipt = await f.api.prepareInputSelection(f.input)
    const reference = receipt.scene.inputContext.selection!.attachment!, changed: BrowserInputImageReference = { ...reference }
    if (mismatch === 'host') changed.hostId = 'foreign'
    if (mismatch === 'missing-hash') delete changed.sha256
    if (mismatch === 'hash') changed.sha256 = '0'.repeat(64)
    if (mismatch === 'mime') changed.mimeType = 'image/jpeg' as never
    if (mismatch === 'width') changed.width += 1
    if (mismatch === 'height') changed.height += 1
    if (mismatch === 'missing') changed.path += '.missing'
    expect(await f.api.readSelectionImage(changed)).toBeNull()
    expect(await f.api.readSelectionImage(reference)).not.toBeNull()
  })

  it('confines the exact read to the original pasted owner and refuses native decode failure', async () => {
    const f = await fixture(), receipt = await f.api.prepareInputSelection(f.input), reference = receipt.scene.inputContext.selection!.attachment!
    const outside = join(f.home, 'outside.png'), linked = join(f.home, '.agentmux', 'pasted', 'linked.png')
    await writeFile(outside, bytes); await symlink(outside, linked)
    expect(await f.api.readSelectionImage({ ...reference, path: outside })).toBeNull()
    expect(await f.api.readSelectionImage({ ...reference, path: linked })).toBeNull()
    f.createFromBuffer.mockImplementation(() => { throw new Error('Native decode unavailable') })
    expect(await f.api.readSelectionImage(reference)).toBeNull()
    f.createFromBuffer.mockReturnValue({ isEmpty: () => false, getSize: () => ({ width: 2, height: 1 }) })
    expect(await f.api.readSelectionImage(reference)).toBeNull()
  })

  it('does not preview a damaged resource under its original reference', async () => {
    const f = await fixture(), receipt = await f.api.prepareInputSelection(f.input), reference = receipt.scene.inputContext.selection!.attachment!
    await writeFile(reference.path, Buffer.from('Damaged original image'))
    expect(await f.api.readSelectionImage(reference)).toBeNull()
    expect(await f.api.readInputSelection(f.input.operationId)).toMatchObject({ state: 'prepared', receipt })
  })
})
