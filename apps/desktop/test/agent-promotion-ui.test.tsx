// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AgentPromotionReceipt, AgentPromotionApply, AgentPromotionDiscovery } from '@agentmux/core/agent-promotion'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { applyConfigEdit } from '../src/shared/config-edit'
import { TopicDirectorySettingsPane } from '../src/renderer/src/components/settings/TopicDirectorySettingsPane'
import { AgentPromotionDialog } from '../src/renderer/src/components/AgentPromotionDialog'
import { TopicActionsMenu } from '../src/renderer/src/components/TopicContextMenu'
import { TopicPromotionDialog } from '../src/renderer/src/components/TopicPromotionDialog'
import { AgentRegionHeader } from '../src/renderer/src/components/AgentRegionHeader'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAgentPromotion } from '../src/renderer/src/lib/use-agent-promotion'

const dom = composerDOM(), original = composerSession('original-agent')
const reference = { displayWorkspaceId: 'workspace', groupId: 'original-group', tabId: 'original-tab', regionId: 'original-region' }
const selection = { target: { hostId: 'local', agentSessionId: original.control.agentSessionId }, source: { hostId: 'local', sessionId: original.control.agentSessionId, ...reference }, title: 'My trusted collaborator' }
const club = { title: 'Research Club', directoryPath: '/private/promotion/motes/research', target: { spaceId: 'research-club', zoneId: 'research-home', expectedResource: { hostId: 'local', workspaceId: 'mote-workspace', workspacePath: '/private/promotion' } } }
const another = { title: 'Writing Club', directoryPath: '/private/promotion/motes/writing', target: { spaceId: 'writing-club', zoneId: 'writing-home', expectedResource: { hostId: 'local', workspaceId: 'mote-workspace', workspacePath: '/private/promotion' } } }
const partial: AgentPromotionReceipt = { ...selection, destination: { kind: 'existing-club', target: club.target }, operationId: 'original-promotion', topicId: 'launcher:research', moteSpaceId: club.target.spaceId, zoneId: club.target.zoneId, directoryPath: '/private/promotion/motes/research',
  conversation: { ...selection.source, displayWorkspaceId: 'research-club', groupId: 'mote-group', tabId: 'mote-tab', regionId: 'mote-region' },
  state: 'partial', stage: 'spatial', diskDurability: 'unconfirmed', unavailable: [{ code: 'SPATIAL_UNCONFIRMED', message: 'Original association save is unconfirmed.', recovery: 'Inspect the original operation.' }] }
const complete = { ...partial, state: 'complete' as const, stage: 'complete' as const, diskDurability: 'confirmed' as const, unavailable: [] }
const discovery = (patch: Partial<AgentPromotionDiscovery> = {}) => ({ promotion: null, discovery: { clubs: [club, another], memberships: [], pending: [], nextCursor: null, issue: null, ...patch } })
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === text)!
async function click(text: string) { const node = button(text); expect(node, text).toBeDefined(); await act(async () => node.click()) }
async function choose(text: string) {
  const label = [...document.querySelectorAll<HTMLLabelElement>('.agent-promotion__club')].find(node => node.textContent?.includes(text))!
  expect(label, text).toBeDefined(); await act(async () => label.querySelector<HTMLInputElement>('input')!.click())
}
async function menu() {
  await act(async () => { const node = document.querySelector<HTMLButtonElement>('[aria-label^="More actions for"]')!
    node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); node.click() })
  await act(async () => document.querySelector<HTMLElement>('[data-agent-promotion]')!.click())
}
beforeEach(() => {
  const tab = createWorkbenchTab(reference.tabId, { kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId: original.id, regionId: reference.regionId })
  useAppStore.setState({ config: structuredClone(composerConfig), sessions: [original], tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout(reference.groupId, [tab.id]) },
    activeWorkspaceId: 'unrelated-workspace', agentComposerDrafts: { [original.id]: 'Keep the original draft' }, spaceZoneBindings: {}, spatialRequests: {}, scratchTopicSnapshots: {}, topicCategories: [], error: null })
  vi.spyOn(useAppStore.getState(), 'refreshSpatialState').mockResolvedValue(undefined)
  vi.spyOn(useAppStore.getState(), 'refreshScratchTopics').mockResolvedValue([])
})

it('Promotion saves the original policy while preserving Agent work', async () => {
  const write = vi.spyOn(api.config, 'save').mockImplementation(async (requested, expected) => {
    const saved = applyConfigEdit(useAppStore.getState().config!, expected!, requested); useAppStore.setState({ config: saved }); return saved
  })
  await dom.render(<TopicDirectorySettingsPane config={useAppStore.getState().config!} onClose={() => {}} promotion />)
  await act(async () => dom.container.querySelector<HTMLInputElement>('[aria-label="Allow promotion"]')!.click())
  await click('Save Promotion settings')
  expect(write).toHaveBeenCalledOnce(); expect(useAppStore.getState().config?.promotion).toEqual({ enabled: false })
  expect(dom.draft(original.id)).toBe('Keep the original draft'); expect(useAppStore.getState().sessions).toEqual([original])
})

it('discovery never chooses the first Club and the exact selected Club reaches the original owner', async () => {
  const done = vi.fn(), close = vi.fn()
  const call = vi.spyOn(api.agentPromotions, 'call').mockImplementation(async (method, input) => method === 'agent.promote.inspect' ? discovery() : { promotion: { ...complete, ...input } } as never)
  await dom.render(<AgentPromotionDialog selection={selection} onClose={close} onPromoted={done} />)
  expect(button('选择加入方式').disabled).toBe(true); expect(call).toHaveBeenCalledOnce()
  await choose(another.title); await click('加入 Club')
  expect(call).toHaveBeenLastCalledWith('agent.promote.apply', { ...selection, destination: { kind: 'existing-club', target: another.target }, operationId: expect.any(String) })
  expect(done).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce()
  expect(dom.draft(original.id)).toBe('Keep the original draft'); expect(useAppStore.getState().activeWorkspaceId).toBe('unrelated-workspace')
})

it('new Club creation is an explicit two-level choice even with an empty roster', async () => {
  const call = vi.spyOn(api.agentPromotions, 'call').mockImplementation(async (method, input) => method === 'agent.promote.inspect' ? discovery({ clubs: [] }) : { promotion: { ...complete, ...input } } as never)
  await dom.render(<AgentPromotionDialog selection={selection} onClose={() => {}} onPromoted={() => {}} />)
  expect(document.body.textContent).toContain('还没有可加入的 Club')
  await choose('新建 Club'); await click('新建 Club 并加入')
  expect(call).toHaveBeenLastCalledWith('agent.promote.apply', expect.objectContaining({ ...selection, destination: { kind: 'new-club' } }))
})

it('historical completion does not close a new Promotion and unrelated discovery issues retain known Club choices', async () => {
  const done = vi.fn(), close = vi.fn()
  vi.spyOn(api.agentPromotions, 'call').mockResolvedValue(discovery({ issue: 'Another Club could not be read; confirmed choices remain available.' }))
  await dom.render(<AgentPromotionDialog selection={selection} onClose={close} onPromoted={done} />)
  expect(done).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled()
  await choose(club.title); expect(button('加入 Club').disabled).toBe(false)
})

it('disabled policy preserves inspection and the original pending operation, without accepting a new action', async () => {
  useAppStore.setState({ config: { ...composerConfig, promotion: { enabled: false } } })
  const call = vi.spyOn(api.agentPromotions, 'call').mockImplementation(async method => method === 'agent.promote.inspect' ? discovery({ pending: [partial] }) : { promotion: complete })
  await dom.render(<AgentPromotionDialog selection={{ ...selection, title: 'Later label' }} onClose={() => {}} onPromoted={() => {}} />)
  await choose('新建 Club')
  expect(document.body.textContent).toContain('Promotion 已关闭'); expect(document.querySelector<HTMLButtonElement>('.agent-promotion-dialog .topic-promotion__submit')!.disabled).toBe(true)
  await act(async () => document.querySelector<HTMLButtonElement>('[data-promotion-operation="original-promotion"]')!.click()); expect(button('继续操作').disabled).toBe(false)
  await click('继续操作')
  expect(call).toHaveBeenLastCalledWith('agent.promote.apply', { ...selection, destination: partial.destination, operationId: partial.operationId })
})

it('a lost reply inspects the exact frozen operation and only explicitly continues that operation', async () => {
  let submitted: AgentPromotionApply | undefined, applies = 0
  const call = vi.spyOn(api.agentPromotions, 'call').mockImplementation(async (method, input) => {
    if (method === 'agent.promote.inspect') return 'operationId' in input ? { promotion: { ...partial, ...submitted }, discovery: null } : discovery()
    submitted = input as AgentPromotionApply
    if (++applies === 1) throw Error('Original reply was lost')
    return { promotion: { ...complete, ...submitted } }
  })
  await dom.render(<AgentPromotionDialog selection={selection} onClose={() => {}} onPromoted={() => {}} />)
  await choose(club.title); await click('加入 Club'); const op = submitted!.operationId
  await click('查看结果'); expect(applies).toBe(1)
  expect(call).toHaveBeenLastCalledWith('agent.promote.inspect', { target: selection.target, operationId: op })
  await click('继续操作'); expect(submitted!.operationId).toBe(op); expect(applies).toBe(2)
})

it('paged operation discovery retains an earlier gap until the same scope is reread', async () => {
  const call = vi.spyOn(api.agentPromotions, 'call').mockImplementation(async (_method, input) => 'cursor' in input
    ? discovery({ pending: [{ ...partial, operationId: 'another-operation', directoryPath: another.directoryPath,
      moteSpaceId: another.target.spaceId, zoneId: another.target.zoneId, destination: { kind: 'existing-club', target: another.target } }] })
    : discovery({ pending: [partial], nextCursor: 'same-agent-page', issue: 'One original record is unreadable.' }))
  await dom.render(<AgentPromotionDialog selection={selection} onClose={() => {}} onPromoted={() => {}} />)
  await click('继续读取操作')
  expect(call).toHaveBeenLastCalledWith('agent.promote.inspect', { target: selection.target, cursor: 'same-agent-page' })
  expect(document.querySelectorAll('[data-promotion-operation]')).toHaveLength(2)
  expect(document.body.textContent).toContain('One original record is unreadable.')
  await click('重新读取')
  expect(call).toHaveBeenLastCalledWith('agent.promote.inspect', { target: selection.target })
})

it('the actual Region menu retains the full unknown intent across dismissal and reopening despite unrelated focus', async () => {
  let submitted: AgentPromotionApply | undefined
  const call = vi.spyOn(api.agentPromotions, 'call').mockImplementation(async (method, input) => {
    if (method === 'agent.promote.inspect') return 'operationId' in input ? { promotion: { ...partial, ...submitted }, discovery: null } : discovery()
    submitted = input as AgentPromotionApply; throw Error('Original reply was lost')
  })
  await dom.render(<WorkbenchPresentationContext.Provider value={{ active: true, retainedRegionId: null, reference }}><AgentRegionHeader
    name={selection.title} executorLabel="Codex" sessionId={original.id} sessionKind="agent" executionHost={{ id: 'local', label: 'This Mac', configured: true, cwd: original.workspacePath }}
    regionId={reference.regionId} nativeSession={original} readOnly={false} onHistory={undefined} /></WorkbenchPresentationContext.Provider>)
  await menu(); await choose(club.title); await click('加入 Club')
  expect(submitted).toEqual({ ...selection, destination: { kind: 'existing-club', target: club.target }, operationId: expect.any(String) })
  await click('稍后查看'); await menu()
  expect(call).toHaveBeenLastCalledWith('agent.promote.inspect', { target: selection.target, operationId: submitted!.operationId })
  expect(dom.draft(original.id)).toBe('Keep the original draft'); expect(useAppStore.getState().activeWorkspaceId).toBe('unrelated-workspace')
})

it('the original Topic operation remains inspectable and explicitly continuable with policy off', async () => {
  useAppStore.setState({ config: { ...composerConfig, promotion: { enabled: false } } })
  const call = vi.spyOn(api.topics, 'call').mockResolvedValue({ promotion: { operationId: 'original-topic-promotion', topicId: partial.topicId, state: 'partial', stage: 'spatial', topic: null, moteSpaceId: null, unavailable: [], diskDurability: 'confirmed' } } as never)
  await dom.render(<TopicPromotionDialog target={{ topicId: partial.topicId, title: selection.title }} onClose={() => {}} onPromoted={() => {}} />)
  expect(button('继续晋升').disabled).toBe(false); await click('继续晋升')
  expect(call).toHaveBeenCalledWith('topic.promote.apply', { topicId: partial.topicId, operationId: 'original-topic-promotion' })
})

it('a late completion keeps a different original Agent intent held by the reused hook', async () => {
  const second = composerSession('second-agent')
  const secondRef = { ...reference, tabId: 'second-tab', regionId: 'second-region' }
  const secondTab = createWorkbenchTab(secondRef.tabId, { kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId: second.id, regionId: secondRef.regionId })
  useAppStore.setState(state => ({ sessions: [original, second], tabs: { ...state.tabs, [secondTab.id]: secondTab },
    layouts: { workspace: createWorkspaceLayout(reference.groupId, [reference.tabId, secondTab.id]) } }))
  let finishFirst!: (value: { promotion: AgentPromotionReceipt }) => void
  const inputs: AgentPromotionApply[] = []
  const call = vi.spyOn(api.agentPromotions, 'call').mockImplementation(async (method, input) => {
    if (method === 'agent.promote.inspect') return 'operationId' in input
      ? { promotion: { ...partial, ...inputs.find(item => item.operationId === input.operationId)! }, discovery: null } : discovery()
    inputs.push(input as AgentPromotionApply)
    if (inputs.length === 1) return await new Promise(resolve => { finishFirst = resolve })
    throw Error('Second original reply is unknown')
  })
  function Surface({ session }: { session: typeof original }) {
    const promotion = useAgentPromotion(session, session.label, session.id === original.id ? reference : secondRef)
    return <><button onClick={promotion.open}>Promotion action</button>{promotion.dialog}{promotion.feedback}</>
  }
  await dom.render(<Surface session={original} />); await click('Promotion action'); await choose(club.title)
  await act(async () => { button('加入 Club').click() }); await click('稍后查看')
  await dom.render(<Surface session={second} />); await click('Promotion action'); await choose(another.title); await click('加入 Club')
  expect(inputs).toHaveLength(2)
  await act(async () => finishFirst({ promotion: { ...complete, ...inputs[0]! } }))
  expect(document.querySelector('.agent-promotion-dialog')?.getAttribute('data-phase')).toBe('unknown')
  expect(document.querySelector('.agent-promotion-feedback')).toBeNull()
  await click('稍后查看'); await click('Promotion action')
  expect(call).toHaveBeenLastCalledWith('agent.promote.inspect', { target: inputs[1]!.target, operationId: inputs[1]!.operationId })
})

it('Topic keeps its own Club-level promotion action and original result', async () => {
  const noop = () => {}
  for (const promoted of [false, true]) {
    await dom.render(<TopicActionsMenu title="A familiar Topic" pinned={false} promoted={promoted} onPromote={noop}
      onCopyPath={noop} onCopyLink={noop} onRename={noop} onReveal={noop} onTogglePin={noop} onEditWiki={noop} />)
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Actions for A familiar Topic"]')!
    await act(async () => { trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); trigger.click() })
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === (promoted ? 'View promotion result' : 'Promote to Mote Club…'))
    expect(item).toBeDefined(); expect(item!.querySelector('svg')?.getAttribute('data-semantic-icon')).toBe('object.promotion')
    await dom.render(<div />)
  }
})
