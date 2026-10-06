import { fixturePath } from '../../../test/fixture-values.mjs'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { DEVICE_WORKFACE_KEY, getDeviceWorkface } from '../src/recovery/device-workface'
import { openTreeSession, button, click, fixture, mount, mounted } from './conversation-fixture'

afterEach(async () => {
  for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks()
})

describe('original Space cold Back boundary', () => {
  it('preserves the navigated device record during a restored guard release, then one original browser Back returns to the exact directory without input', async () => {
    localStorage.clear(); window.history.replaceState(null, '')
    const f = fixture()
    const catalog = {
      spaces: [{ spaceId: 'cold-original-space', kind: 'folder', name: 'Original Folder', hostId: 'host-original', directoryPath: fixturePath("workspace"), projectId: null }],
      zones: [{ zoneId: 'cold-original-zone', workspaceId: 'cold-original-workspace', hostId: 'host-original', directoryPath: fixturePath("workspace"), kind: 'directory', branch: null }],
      tabs: [{ tabId: 'cold-original-tab', zoneId: 'cold-original-zone', workspaceId: 'cold-original-workspace', name: 'Original Tab', regionIds: ['cold-original-region'] }],
      regions: [{ regionId: 'cold-original-region', tabId: 'cold-original-tab', kind: 'file', agentSessionId: null, runId: null,
        file: { workspaceId: 'cold-original-workspace', path: 'original.md', zoneRelativePath: 'original.md' } }],
      bindings: [{ spaceId: 'cold-original-space', zoneId: 'cold-original-zone' }],
      locations: [{ spaceId: 'cold-original-space', zoneId: 'cold-original-zone', workspaceId: 'cold-original-workspace',
        displayWorkspaceId: 'cold-original-display', groupId: 'cold-original-group', tabId: 'cold-original-tab', regionId: 'cold-original-region' }]
    }
    const rpc = vi.fn().mockImplementation(async (method: string, params: any) => {
      if (method === 'space.ls') return { catalog }
      if (method === 'app.snapshot') return { sessions: [], agents: [], projects: [], executors: [], unavailable: [],
        workspaces: [{ workspaceId: 'cold-original-workspace', hostId: 'host-original', path: fixturePath("workspace") }] }
      if (method === 'file.read') return { resource: { ...params.expectedResource, zoneId: params.zoneId, path: params.path },
        result: { status: 'read', document: { path: params.path, content: '# Original cold Space file', revision: 'sha256:' + 'a'.repeat(64) } } }
      throw new Error(`Unexpected public method ${method}`)
    })
    f.client.forwardRpc = rpc
    const connection = { state: 'connected' as const, message: 'Connected to original Host' }
    const app = () => <MobileApp client={f.client} connection={connection} platform={createBrowserPlatform()} />
    const original = await mount(app())
    await click(button(original.element.querySelector<HTMLElement>('.mobile-navigation')!, 'Space'))
    await click(original.element.querySelector('.mobile-space-row')!)
    await click(original.element.querySelector('.mobile-spatial-tab button')!)
    await vi.waitFor(() => expect(original.element.querySelector('.mobile-region-content h1')?.textContent).toBe('Original cold Space file'))
    const record = getDeviceWorkface().snapshot().record
    const raw = localStorage.getItem(DEVICE_WORKFACE_KEY)
    const guard = structuredClone(window.history.state)
    expect(guard).toMatchObject({ agentmuxMobileBack: expect.stringMatching(/^mobile-back:/), anchor: null })
    expect(record.presentation?.spatial).toEqual({ spaceId: 'cold-original-space', tabId: 'cold-original-tab', regionId: 'cold-original-region' })
    const first = mounted.findIndex(view => view.element === original.element)
    const previous = mounted.splice(first, 1)[0]!
    await act(async () => previous.root.unmount()); previous.element.remove()
    expect(localStorage.getItem(DEVICE_WORKFACE_KEY)).toBe(raw)
    // A real same-page reload keeps history.state. React unmount cleanup intentionally replaces
    // its anchor, so the harness restores only the just-observed original guard, never the record.
    window.history.replaceState(guard, '')
    const rawBack = window.history.back.bind(window.history)
    const traversals = vi.spyOn(window.history, 'back')
    const restored = await mount(app())
    // Finish any original bookkeeping traversal; no user Back has been requested yet.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    expect(getDeviceWorkface().snapshot().record).toEqual(record)
    expect(localStorage.getItem(DEVICE_WORKFACE_KEY)).toBe(raw)
    expect(restored.element.querySelector('.mobile-spatial-tab')).toBeNull()
    expect(restored.element.querySelector('.mobile-region-content h1')?.textContent).toBe('Original cold Space file')
    expect(window.history.state).toEqual(guard)
    const neutralTraversals = traversals.mock.calls.length
    await act(async () => { rawBack(); await new Promise(resolve => setTimeout(resolve, 20)) })
    expect(restored.element.querySelector('.mobile-spatial-tab')).not.toBeNull()
    expect(getDeviceWorkface().snapshot().record.presentation?.spatial).toEqual({ spaceId: 'cold-original-space', tabId: null, regionId: null })
    expect(traversals).toHaveBeenCalledTimes(neutralTraversals)
    expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
    expect(rpc.mock.calls.every(([method]) => ['space.ls', 'app.snapshot', 'file.read'].includes(method))).toBe(true)
  })
})
