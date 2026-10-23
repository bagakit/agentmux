// @vitest-environment happy-dom
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { NodeCapsuleOwner } from '../../../packages/capsule/src/node'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'

// Exercises the actual public Unix RPC -> Renderer Control -> Browser client call boundary.
// The Browser client here is a controlled Main port; the native Browser gate closes that join.
const initial = useAppStore.getState(), closes: Array<() => Promise<unknown> | void> = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllGlobals(); useAppStore.setState(initial, true)
})

it('carries the original Capsule and open operation through the actual public Browser request and Store consumer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amux-capsule-open-'))
  closes.push(() => rm(directory, { recursive: true, force: true }))
  const sourcePath = join(directory, 'content'); await mkdir(sourcePath)
  await writeFile(join(sourcePath, 'index.html'), '<title>Original content</title>')
  const owner = await NodeCapsuleOwner.open({ stateDirectory: join(directory, 'capsules') }); closes.push(() => owner.close())
  const capsule = await owner.call('capsule.create', { sourcePath, storageMode: 'path', mode: 'injected', operationId: 'original-create' })
  expect(capsule.endpoint.status).toBe('available')
  const url = (capsule.endpoint as { url: string }).url
  const config = { ...await api.config.get(), workspaces: [{ id: 'workspace', hostId: 'local', name: 'Original workspace', path: directory, kind: 'folder' as const }] }
  const user = createWorkbenchTab('user-tab', { kind: 'file', regionId: 'user-region', workspaceId: 'workspace', path: 'notes.md' })
  const background = createWorkbenchTab('background-tab', { kind: 'launcher', regionId: 'background-region', workspaceId: 'workspace' })
  useAppStore.setState({ ...initial, config, loading: false, sessions: [], mainSurface: 'board', activeWorkspaceId: 'workspace',
    tabs: { [user.id]: user, [background.id]: background }, layouts: { workspace: createWorkspaceLayout('group', [user.id, background.id]) } }, true)
  await initializeSpatialControlFixture()
  const draft = document.createElement('textarea'); draft.value = 'Unsent original draft'; document.body.append(draft); draft.focus()
  closes.push(() => draft.remove())
  const before = useAppStore.getState()
  const create = vi.spyOn(api.browser, 'create').mockImplementation(async (id, target, _workspace, _profile, _mode, _viewport, capsuleId, operationId) => ({
    id, mode: 'normal', navigationId: 'native-navigation', url: target, title: 'Original Capsule', profileId: capsuleId ? null : 'default',
    loading: false, canGoBack: false, canGoForward: false, viewport: 'responsive', error: null, driving: false, appLinkPrompt: null,
    ...(capsuleId ? { capsuleId, capsuleOrigin: new URL(url).origin, capsuleActive: true, capsuleOpenOperationIds: [operationId!] } : {})
  }))
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'rpc.sock'), coreClients: () => [],
    execute: request => useAppStore.getState().executeControl(request) })
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  const result = await rpc.call('browser.open', { url, capsuleId: capsule.record.capsuleId, operationId: 'original-open',
    destination: { kind: 'launcher', regionId: 'background-region' } })
  expect(create).toHaveBeenCalledExactlyOnceWith(result.region.browserId, url, 'workspace', undefined, undefined, undefined, capsule.record.capsuleId, 'original-open')
  const after = useAppStore.getState()
  expect(after.tabs[result.region.tabId]!.regions[result.region.regionId]).toMatchObject({
    kind: 'browser', browserId: result.region.browserId, capsuleId: capsule.record.capsuleId, capsuleOpenOperationIds: ['original-open']
  })
  expect(after.tabs[user.id]).toBe(before.tabs[user.id])
  expect(after.layouts.workspace!.groups[0]!.activeTabId).toBe(before.layouts.workspace!.groups[0]!.activeTabId)
  expect(document.activeElement).toBe(draft); expect(draft.value).toBe('Unsent original draft')
})
