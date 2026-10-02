import { fixturePath as _hygiene_fixturePath } from "../../scripts/lib/fixture-values.mjs"
import { vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxSpatialStateStore } from '../../../../packages/core/src/spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../../src/renderer/src/lib/api'
import { useAppStore } from '../../src/renderer/src/store'
import { createWorkbenchTab } from '../../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph, reconcileSpatialGraphs } from '../../src/renderer/src/lib/desktop-spatial-state'
import { validateProjectGroup } from '../../src/renderer/src/lib/cross-device-project-groups'
import { directoryIdentity } from '../../src/shared/space-addresses'
import type { AppConfig } from '../../src/shared/contracts'

export const groupConfig: AppConfig = {
  version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }, { id: 'farm', kind: 'ssh', label: 'Farm machine', hostname: 'test.invalid' }],
  executors: {}, workspaces: [
    { id: 'local-project', name: 'Shared project', path: _hygiene_fixturePath("local/shared"), hostId: 'local', kind: 'folder' },
    { id: 'remote-project', name: 'Shared project', path: _hygiene_fixturePath("remote/shared"), hostId: 'farm', kind: 'folder' }
  ], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}
export const ids = [directoryIdentity('local', _hygiene_fixturePath("local/shared")), directoryIdentity('farm', _hygiene_fixturePath("remote/shared"))]
export const group = { groupId: 'shared-group', name: 'Shared project', projectIds: ids }
const original = useAppStore.getState(), dirs: string[] = []
export const disposers: (() => void)[] = []
export function workbench() {
  const tab = createWorkbenchTab('original-tab', { regionId: 'original-region', kind: 'file', workspaceId: 'local-project', path: 'notes.md' })
  return { config: groupConfig, projectGroups: [], sessions: [], tabs: { [tab.id]: tab }, layouts: { 'local-project': createWorkspaceLayout('original-layout', [tab.id]) }, spaceZoneBindings: {}, spatialRequests: {} }
}
export async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'amux-project-group-')); dirs.push(dir)
  const owner = new AgentMuxSpatialStateStore(join(dir, 'spatial.json'))
  vi.spyOn(api.spatial, 'read').mockImplementation(() => owner.read())
  vi.spyOn(api.spatial, 'commit').mockImplementation(input => owner.commit(input))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => owner.subscribe(listener))
  vi.spyOn(api.config, 'get').mockResolvedValue(groupConfig)
  const snapshot = await api.sessions.snapshot()
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ ...snapshot, sessions: [], recoveryCandidates: [] })
  await owner.commit({ expectedRevision: 0, graph: desktopSpatialGraph(workbench(), []) })
  useAppStore.setState(workbench())
  disposers.push(await useAppStore.getState().initialize())
  return owner
}
export async function cleanupGroups() {
  for (const dispose of disposers.splice(0)) dispose()
  vi.restoreAllMocks(); useAppStore.setState(original, true)
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
}
