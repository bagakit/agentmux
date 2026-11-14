// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AgentPromotionReceipt, AgentPromotionApply } from '@agentmux/core/agent-promotion'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { applyConfigEdit } from '../src/shared/config-edit'
import { TopicDirectorySettingsPane } from '../src/renderer/src/components/settings/TopicDirectorySettingsPane'
import { AgentPromotionDialog } from '../src/renderer/src/components/AgentPromotionDialog'
import { TopicPromotionDialog } from '../src/renderer/src/components/TopicPromotionDialog'
import { AgentRegionHeader } from '../src/renderer/src/components/AgentRegionHeader'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'

const dom = composerDOM(), original = composerSession('original-agent')
const reference = { displayWorkspaceId: 'workspace', groupId: 'original-group', tabId: 'original-tab', regionId: 'original-region' }
const selection = { target: { hostId: 'local', agentSessionId: original.control.agentSessionId }, source: { hostId: 'local', sessionId: original.control.agentSessionId, ...reference }, title: 'My trusted collaborator' }
const partial: AgentPromotionReceipt = { ...selection, operationId: 'original-promotion', topicId: 'launcher:promoted-agent', moteSpaceId: 'original-mote', zoneId: 'original-home', directoryPath: '/private/promotion/motes/original',
  conversation: { ...selection.source, displayWorkspaceId: 'original-mote', groupId: 'mote-group', tabId: 'mote-tab', regionId: 'mote-region' },
  state: 'partial', stage: 'main', diskDurability: 'confirmed', unavailable: [{ code: 'MOTE_MAIN_UNCONFIRMED', message: 'Original Main save is unconfirmed.', recovery: 'Inspect the original operation.' }] }
const complete = { ...partial, state: 'complete' as const, stage: 'complete' as const, unavailable: [] }
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === text)!
async function click(text: string) { const node = button(text); expect(node, text).toBeDefined(); await act(async () => node.click()) }
function configWrite() { return vi.spyOn(api.config, 'save').mockImplementation(async (requested, expected) => {
  const saved = applyConfigEdit(useAppStore.getState().config!, expected!, requested); useAppStore.setState({ config: saved }); return saved
}) }
beforeEach(() => {
  const tab = createWorkbenchTab(reference.tabId, { kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId: original.id, regionId: reference.regionId })
  useAppStore.setState({ config: structuredClone(composerConfig), sessions: [original], tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout(reference.groupId, [tab.id]) },
    activeWorkspaceId: 'unrelated-workspace', agentComposerDrafts: { [original.id]: 'Keep the original draft' }, spaceZoneBindings: {}, spatialRequests: {}, scratchTopicSnapshots: {}, topicCategories: [], error: null })
  vi.spyOn(useAppStore.getState(), 'refreshSpatialState').mockResolvedValue(undefined)
  vi.spyOn(useAppStore.getState(), 'refreshScratchTopics').mockResolvedValue([])
})

it('Promotion saves its real global switch through the original configuration transaction and retains work', async () => {
  const write = configWrite(), sessions = useAppStore.getState().sessions, tabs = useAppStore.getState().tabs
  await dom.render(<TopicDirectorySettingsPane config={useAppStore.getState().config!} onClose={() => {}} promotion />)
  const toggle = dom.container.querySelector<HTMLInputElement>('[aria-label="Allow promotion"]')!
  expect(toggle.checked).toBe(true)
  await act(async () => toggle.click()); await click('Save Promotion settings')
  expect(write).toHaveBeenCalledOnce(); expect(useAppStore.getState().config?.promotion).toEqual({ enabled: false })
  expect(useAppStore.getState().sessions).toBe(sessions); expect(useAppStore.getState().tabs).toBe(tabs)
  expect(dom.draft(original.id)).toBe('Keep the original draft')
  await dom.render(<TopicDirectorySettingsPane config={useAppStore.getState().config!} onClose={() => {}} promotion />)
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Allow promotion"]')!.checked).toBe(false)
  expect(dom.container.textContent).toContain('Saved: Off')
})

it('a disabled new Agent promotion remains inspectable and explains its saved policy without applying', async () => {
  useAppStore.setState({ config: { ...composerConfig, promotion: { enabled: false } } })
  const call = vi.spyOn(api.agentPromotions, 'call').mockResolvedValue({ promotion: null })
  await dom.render(<AgentPromotionDialog selection={selection} onClose={() => {}} onPromoted={() => {}} />)
  expect(call).toHaveBeenCalledWith('agent.promote.inspect', { target: selection.target })
  expect(document.querySelector('.agent-promotion-dialog')?.textContent).toContain('Promotion 已关闭')
  expect(button('晋升为 Mote').disabled).toBe(true)
  await click('晋升为 Mote'); expect(call).toHaveBeenCalledOnce()
})

it('disabled policy permits continuation of the original partial Agent operation with its frozen request', async () => {
  useAppStore.setState({ config: { ...composerConfig, promotion: { enabled: false } } })
  const calls: Array<{ method: string; input: unknown }> = []
  vi.spyOn(api.agentPromotions, 'call').mockImplementation(async (method, input) => {
    calls.push({ method, input }); return { promotion: method.endsWith('inspect') ? partial : complete }
  })
  const done = vi.fn(), close = vi.fn()
  await dom.render(<AgentPromotionDialog selection={{ ...selection, title: 'Later label' }} onClose={close} onPromoted={done} />)
  expect(button('继续晋升').disabled).toBe(false); await click('继续晋升')
  expect(calls).toEqual([{ method: 'agent.promote.inspect', input: { target: selection.target } }, { method: 'agent.promote.apply', input: { ...selection, operationId: partial.operationId } }])
  expect(done).toHaveBeenCalledWith(complete); expect(close).toHaveBeenCalledOnce()
  expect(dom.draft(original.id)).toBe('Keep the original draft'); expect(useAppStore.getState().activeWorkspaceId).toBe('unrelated-workspace')
})

it('a lost Agent promotion reply only inspects the same target before explicit same-operation continuation', async () => {
  let submitted: AgentPromotionApply | undefined, inspect = 0, applies = 0
  const call = vi.spyOn(api.agentPromotions, 'call').mockImplementation(async (method, input) => {
    if (method === 'agent.promote.inspect') return { promotion: ++inspect === 1 ? null : { ...partial, operationId: submitted!.operationId } }
    submitted = input as AgentPromotionApply
    if (++applies === 1) throw Error('Original reply was lost')
    return { promotion: { ...complete, operationId: submitted.operationId } }
  })
  await dom.render(<AgentPromotionDialog selection={selection} onClose={() => {}} onPromoted={() => {}} />)
  await click('晋升为 Mote'); const op = submitted!.operationId
  expect(button('查看结果')).toBeDefined(); expect(applies).toBe(1)
  await click('查看结果'); expect(applies).toBe(1); await click('继续晋升')
  expect(submitted!.operationId).toBe(op); expect(call).toHaveBeenCalledTimes(4)
})

it('the Topic dialog shares the new-promotion switch while preserving an original partial continuation', async () => {
  useAppStore.setState({ config: { ...composerConfig, promotion: { enabled: false } } })
  const call = vi.spyOn(api.topics, 'call').mockResolvedValue({ promotion: null } as never)
  await dom.render(<TopicPromotionDialog target={{ topicId: partial.topicId, title: selection.title }} onClose={() => {}} onPromoted={() => {}} />)
  expect(button('晋升为 Mote').disabled).toBe(true)
  await dom.render(<div />)
  call.mockResolvedValue({ promotion: { operationId: 'original-topic-promotion', topicId: partial.topicId, state: 'partial', stage: 'spatial', topic: null, moteSpaceId: null, unavailable: [], diskDurability: 'confirmed' } } as never)
  await dom.render(<TopicPromotionDialog target={{ topicId: partial.topicId, title: selection.title }} onClose={() => {}} onPromoted={() => {}} />)
  expect(button('继续晋升').disabled).toBe(false); await click('继续晋升')
  expect(call).toHaveBeenCalledWith('topic.promote.apply', { topicId: partial.topicId, operationId: 'original-topic-promotion' })
})

it('the real Region Header menu opens promotion for its exact original Agent occurrence despite unrelated active focus', async () => {
  const call = vi.spyOn(api.agentPromotions, 'call').mockResolvedValue({ promotion: null })
  await dom.render(<WorkbenchPresentationContext.Provider value={{ active: true, retainedRegionId: null, reference }}><AgentRegionHeader
    name={selection.title} executorLabel="Codex" sessionId={original.id} sessionKind="agent" executionHost={{ id: 'local', label: 'This Mac', configured: true, cwd: original.workspacePath }}
    regionId={reference.regionId} nativeSession={original} readOnly={false} onHistory={undefined} /></WorkbenchPresentationContext.Provider>)
  const more = document.querySelector<HTMLButtonElement>('[aria-label^="More actions for"]')!
  expect(more).not.toBeNull()
  await act(async () => { more.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); more.click() })
  const action = document.querySelector<HTMLElement>('[data-agent-promotion]')!
  expect(action).not.toBeNull()
  await act(async () => action.click())
  expect(document.querySelector('.agent-promotion-dialog')).not.toBeNull()
  expect(call).toHaveBeenCalledWith('agent.promote.inspect', { target: selection.target })
  await click('晋升为 Mote')
  expect(call).toHaveBeenCalledWith('agent.promote.apply', expect.objectContaining(selection))
})
