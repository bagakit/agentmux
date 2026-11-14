// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/monaco', () => ({}))
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab, addWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { requestWorkbenchReferenceClose } from '../src/renderer/src/lib/workbench-close-request'
import { composerDOM } from './helpers/composer-dom-fixture'

composerDOM()
it.each([false, true])('requests the exact display occurrence without requiring a Session observation (split %s)', split => {
  let tab = createWorkbenchTab('original-tab', { kind: 'agent', phase: 'attached', sessionId: 'unobserved-agent', workspaceId: 'resource-workspace', regionId: 'original-region' })
  if (split) tab = addWorkbenchRegion(tab, 'original-region', 'right', { kind: 'launcher', workspaceId: 'resource-workspace', regionId: 'kept-region' })!
  useAppStore.setState({ sessions: [], tabs: { [tab.id]: tab }, layouts: { 'display-workspace': createWorkspaceLayout('original-group', [tab.id]),
    'other-display': createWorkspaceLayout('other-group', [tab.id]) }, closeTabRequest: null, closeRegionRequest: null })
  requestWorkbenchReferenceClose({ displayWorkspaceId: 'display-workspace', groupId: 'original-group', tabId: tab.id, regionId: 'original-region' })
  expect(useAppStore.getState()[split ? 'closeRegionRequest' : 'closeTabRequest']).toMatchObject({ workspaceId: 'display-workspace', tabId: tab.id,
    ...(split ? { groupId: 'original-group', regionId: 'original-region' } : { tabGroupId: 'original-group' }) })
  expect(useAppStore.getState().tabs[tab.id]).toBe(tab)
  expect(useAppStore.getState().sessions).toEqual([])
})
it('keeps the original workface when its display occurrence is no longer present', () => {
  useAppStore.setState({ tabs: {}, layouts: {}, closeTabRequest: null, closeRegionRequest: null })
  const report = vi.spyOn(useAppStore.getState(), 'reportError').mockImplementation(() => {})
  requestWorkbenchReferenceClose({ displayWorkspaceId: 'display-workspace', groupId: 'missing-group', tabId: 'original-tab', regionId: 'original-region' })
  expect(report).toHaveBeenCalledOnce()
  expect(useAppStore.getState().closeTabRequest).toBeNull()
  expect(useAppStore.getState().closeRegionRequest).toBeNull()
})
