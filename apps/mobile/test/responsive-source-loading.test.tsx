import './mobile-lan-crypto.setup'
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { fixturePath } from '../../../test/fixture-values.mjs'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { fixture, mount, mounted } from './conversation-fixture'

const directory = vi.hoisted(() => ({ imports: 0 }))
vi.mock('../src/topics/MobileTopicsSurface', async () => {
  directory.imports += 1
  throw new Error('Controlled directory module is unavailable; original source remains independent.')
})
afterEach(async () => {
  for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); window.history.replaceState(null, '')
})

it('cold compact Source reads independently of Topics and stays readable when the wide directory module fails', async () => {
  vi.stubGlobal('innerWidth', 390); vi.stubGlobal('innerHeight', 844)
  const owner = getDeviceWorkface(), f = fixture()
  await owner.replaceBackup(emptyDeviceWorkface())
  const path = fixturePath('responsive-source-loading')
  const source = { kind: 'file' as const, hostId: 'host-original', path: path + '/source.md' }
  const context = { categoryId: null, topicId: null, mode: 'knowledge' as const }
  await owner.updatePresentation({ selectedSessionId: 'session-original', hostUrl: '', panel: 'conversation' }, {
    primary: 'topics', showSession: false, showGoalWork: false, identity: null, profile: null,
    topics: { context, sources: [{ source, origin: context }] },
  })
  const resource = { hostId: source.hostId, workspaceId: 'workspace-original', workspacePath: path }
  const call = vi.fn(async (method: string, params: any) => {
    if (method === 'app.snapshot') return { workspaces: [{ workspaceId: resource.workspaceId, hostId: resource.hostId, path, projectId: null }], unavailable: [] }
    if (method === 'space.ls') return { catalog: { spaces: [], zones: [{ ...resource, directoryPath: path, zoneId: 'zone-original', kind: 'directory' }], tabs: [], regions: [], bindings: [], locations: [] } }
    if (method === 'file.read') {
      expect(params).toEqual({ zoneId: 'zone-original', path: 'source.md', expectedResource: resource })
      return { resource: { ...resource, zoneId: 'zone-original', zonePath: path, path: 'source.md' }, result: { status: 'read', document: { path: 'source.md', revision: 'sha256:' + 'b'.repeat(64), content: '# Original independent Source\n\nHealthy original file bytes.' } } }
    }
    throw new Error('Unrelated public read: ' + method)
  })
  f.client.forwardRpc = call as typeof f.client.forwardRpc
  const view = await mount(<MobileApp client={f.client} connection={{ state: 'connected', message: 'Original Host' }} platform={createBrowserPlatform()} restoreWorkface />)
  await vi.waitFor(async () => { await act(async () => {}); expect(view.element.querySelector('.mobile-source-host article h1')?.textContent).toBe('Original independent Source') })
  await vi.waitFor(async () => { await act(async () => {}); expect(owner.snapshot().record.presentation?.topics?.sources[0]?.content?.kind).toBe('file') })
  expect(directory.imports, 'Cold compact Source must not import the Topics directory').toBe(0)
  const reader = view.element.querySelector('.mobile-topic-source-reader')!, bytes = JSON.stringify(owner.snapshot().record)
  await act(async () => { vi.stubGlobal('innerWidth', 951); window.dispatchEvent(new Event('resize')) })
  await vi.waitFor(async () => { await act(async () => {}); expect(view.element.querySelector('.mobile-topics-directory-host')?.textContent).toContain('Topics暂时无法打开') })
  expect(directory.imports).toBe(1)
  expect(view.element.querySelector('.mobile-topic-source-reader')).toBe(reader)
  expect(reader.closest('[hidden]')).toBeNull(); expect(reader.textContent).toContain('Healthy original file bytes.')
  expect(JSON.stringify(owner.snapshot().record)).toBe(bytes)
  expect(call.mock.calls.filter(([method]) => method === 'file.read')).toHaveLength(1)
  expect(f.submit).not.toHaveBeenCalled(); expect(f.signalAgent).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
})
