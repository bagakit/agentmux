// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { iconShapes } from '@agentmux/client-ui/icons'
import { AUTHORED_ICON_DEFINITIONS } from '../../../packages/client-ui/src/theme/icon-authored'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { applyConfigEdit } from '../src/shared/config-edit'
import { TopicDirectorySettingsPane } from '../src/renderer/src/components/settings/TopicDirectorySettingsPane'
import { AgentRegionHeader } from '../src/renderer/src/components/AgentRegionHeader'
import { TopicActionsMenu } from '../src/renderer/src/components/TopicContextMenu'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'

const dom = composerDOM(), original = composerSession('original-agent')
const reference = { displayWorkspaceId: 'workspace', groupId: 'original-group', tabId: 'original-tab', regionId: 'original-region' }
beforeEach(() => {
  const tab = createWorkbenchTab(reference.tabId, { kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId: original.id, regionId: reference.regionId })
  useAppStore.setState({ config: composerConfig, sessions: [original], tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout(reference.groupId, [tab.id]) },
    activeWorkspaceId: 'workspace', agentComposerDrafts: { [original.id]: 'Keep the original draft' }, spaceZoneBindings: {}, spatialRequests: {}, scratchTopicSnapshots: {}, topicCategories: [], error: null })
})
it('Promotion saves the original policy while preserving Agent work', async () => {
  const write = vi.spyOn(api.config, 'save').mockImplementation(async (requested, expected) => {
    const saved = applyConfigEdit(useAppStore.getState().config!, expected!, requested); useAppStore.setState({ config: saved }); return saved
  })
  await dom.render(<TopicDirectorySettingsPane config={useAppStore.getState().config!} onClose={() => {}} promotion />)
  await act(async () => dom.container.querySelector<HTMLInputElement>('[aria-label="Allow promotion"]')!.click())
  const save = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Save Promotion settings')!
  await act(async () => save.click())
  expect(write).toHaveBeenCalledOnce(); expect(useAppStore.getState().config?.promotion).toEqual({ enabled: false })
  expect(dom.draft(original.id)).toBe('Keep the original draft'); expect(useAppStore.getState().sessions).toEqual([original])
})
it('the actual Agent menu hands Promotion to the exact original Region and shared Takeover stage without association admission', async () => {
  const old = vi.spyOn(api.agentPromotions, 'call'), request = vi.spyOn(useAppStore.getState(), 'requestRegionDerivedAction')
  await dom.render(<WorkbenchPresentationContext.Provider value={{ active: true, retainedRegionId: null, reference }}>
    <AgentRegionHeader name="Original work" executorLabel="Codex" sessionId={original.id} sessionKind="agent" regionId={reference.regionId}
      executionHost={{ id: 'local', label: 'This Mac', cwd: original.workspacePath, configured: true }} readOnly={false} onHistory={undefined} />
  </WorkbenchPresentationContext.Provider>)
  await act(async () => { const trigger = document.querySelector<HTMLButtonElement>('[aria-label^="More actions for"]')!
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); trigger.click() })
  const entry = document.querySelector<HTMLElement>('[data-agent-promotion]')!
  expect(entry.textContent).toBe('Promotion…')
  expect(entry.querySelector('svg')?.getAttribute('data-semantic-icon')).toBe('object.promotion')
  expect(iconShapes('object.promotion')).toBe(AUTHORED_ICON_DEFINITIONS['promotion-rise'].shapes)
  await act(async () => entry.click())
  expect(request).toHaveBeenCalledWith({ tabId: reference.tabId, regionId: reference.regionId, sessionId: original.id,
    runId: original.control.run.runId, actionId: 'mote-promotion' })
  expect(old).not.toHaveBeenCalled(); expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(dom.draft(original.id)).toBe('Keep the original draft')
})
it('the Topic menu uses the same Promotion symbol while retaining its original Topic owner', async () => {
  const promote = vi.fn()
  await dom.render(<TopicActionsMenu title="Original Topic" pinned={false} onPromote={promote} onCopyPath={() => {}} onCopyLink={() => {}}
    onRename={() => {}} onReveal={() => {}} onTogglePin={() => {}} onEditWiki={() => {}} />)
  const trigger = document.querySelector<HTMLButtonElement>('button')!
  await act(async () => { trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); trigger.click() })
  const entry = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Promote to Mote Club…')!
  expect(entry.querySelector('svg')?.getAttribute('data-semantic-icon')).toBe('object.promotion')
  await act(async () => entry.click())
  await vi.waitFor(() => expect(promote).toHaveBeenCalledOnce())
})
