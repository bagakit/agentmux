import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, deferred, editor, fixture, mount, mounted, paste, session, waitForElement } from './conversation-fixture'

const sid = 'session-original', memberId = 'other', spaceId = 'original-mote'
const connected = { state: 'connected' as const, message: 'Connected' }
const platform = createBrowserPlatform()
const place = (regionId: string, tabId = 'original-tab') => ({ spaceId, zoneId: 'original-zone', workspaceId: 'original-workspace',
  displayWorkspaceId: 'original-display', groupId: 'original-group', tabId, regionId })
const main = { hostId: 'host-original', sessionId: sid, ...place('main-region') }
const { spaceId: _space, zoneId: _zone, workspaceId: _workspace, ...mainReference } = main
function catalog(): AgentMuxSpaceCatalog {
  return {
    spaces: [{ spaceId, kind: 'mote', name: '产品研究搭档', hostId: 'host-original', directoryPath: null, projectId: null },
      { spaceId: 'foreign-mote', kind: 'mote', name: '另一个 Mote', hostId: 'host-original', directoryPath: null, projectId: null }],
    zones: [], bindings: [{ spaceId, zoneId: 'original-zone' }, { spaceId: 'foreign-mote', zoneId: 'foreign-zone' }],
    tabs: [{ tabId: 'original-tab', zoneId: 'original-zone', workspaceId: 'original-workspace', name: 'Original team', regionIds: ['member-region', 'main-region'] },
      { tabId: 'foreign-tab', zoneId: 'foreign-zone', workspaceId: 'original-workspace', name: 'Other team', regionIds: ['foreign-region'] }],
    regions: [
      { tabId: 'original-tab', regionId: 'member-region', kind: 'agent', agentSessionId: memberId, execution: { hostId: 'host-original', cwd: '/original' } },
      { tabId: 'original-tab', regionId: 'main-region', kind: 'agent', agentSessionId: sid, execution: { hostId: 'host-original', cwd: '/original' } },
      { tabId: 'foreign-tab', regionId: 'foreign-region', kind: 'agent', agentSessionId: 'peer', execution: { hostId: 'host-original', cwd: '/foreign' } }
    ], locations: [place('main-region'), place('member-region'), { ...place('foreign-region', 'foreign-tab'), spaceId: 'foreign-mote', zoneId: 'foreign-zone' }],
    motePresentation: [{ spaceId, content: null, quickMode: { status: 'saved', version: 'original-mote-revision', defaults: { conversation: mainReference } }, conversation: mainReference }],
    agentPresentation: [
      { agentSessionId: 'peer', name: '别的 Mote 成员', project: '别的团队', detail: '', group: 'working', state: 'working', providerId: 'codex', stateMark: 'working', stateLabel: '正在执行', recap: { text: '不能混入当前团队', source: 'Last assistant message' } },
      { agentSessionId: memberId, name: '资料研究员', project: '产品研究搭档', detail: '', group: 'attention', state: 'waiting', providerId: 'codex', stateMark: 'attention', stateLabel: '等待你答复', recap: { text: '已比较三份资料，等你确认读取范围。', source: 'Last assistant message' } },
      { agentSessionId: sid, name: '协调与执行搭档', project: '产品研究搭档', detail: '', group: 'working', state: 'working', providerId: 'codex', stateMark: 'working', stateLabel: '正在执行', recap: { text: '正在整理下一步方案。', source: 'Last assistant message' } }
    ]
  }
}
async function setup(initial = catalog()) {
  const f = fixture(), owner = getDeviceWorkface()
  const member = session(memberId)
  member.pendingInteraction = { request: { kind: 'permission', agentSessionId: memberId, id: 'member-permission', title: '请确认读取原资料范围',
    evidence: { source: 'native-hook', observedAt: 1, run: member.run }, permissionHook: { receiptId: 'member-permission' },
    options: [{ id: 'allow-original', label: '允许本次原资料读取', kind: 'allow-once' }] } }
  f.sessions.set(memberId, member)
  await owner.updatePresentation({ selectedSessionId: sid, hostUrl: '', panel: 'conversation' },
    { primary: 'mote', showSession: true, showGoalWork: false, identity: { name: '协调与执行搭档', project: '产品研究搭档', context: place('main-region'), mote: { spaceId, name: '产品研究搭档' } }, profile: null })
  let current = initial, failure = false
  const rpc = vi.fn().mockImplementation(async (method: string, input: any) => {
    if (method === 'space.ls' || method === 'space.inspect') { if (failure) throw Error('原团队读取失败'); return { catalog: current } }
    if (method === 'agent.inspect') return { session: f.client.agentSession(input.agentSessionId), displayName: { override: null, availability: 'observed' } }
    return { agents: [], workspaces: [], projects: [], executors: [], unavailable: [], goals: [], topics: [], categories: [] }
  })
  f.client.forwardRpc = rpc; f.client.ensureAgentContinuity = vi.fn()
  const app = () => <MobileApp client={f.client} connection={connected} platform={platform} />
  const view = await mount(app())
  await vi.waitFor(() => expect(view.element.querySelector('.mobile-mote-team-summary')?.textContent).toContain('团队 '))
  return { ...f, owner, view, app, rpc, setCatalog(next: AgentMuxSpaceCatalog) { current = next }, fail() { failure = true } }
}
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => { for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }; document.body.replaceChildren(); vi.restoreAllMocks() })
const panel = () => document.querySelector<HTMLElement>('[aria-label="本 Mote 团队"]')!

it('actual chat-first App exposes its original main recipient and scoped team without changing the draft or dispatching input', async () => {
  const f = await setup()
  const summary = f.view.element.querySelector('.mobile-mote-team-summary')!
  expect(summary.textContent).toContain('主 Agent'); expect(summary.textContent).toContain('协调与执行搭档'); expect(summary.textContent).toContain('1 需要你')
  expect(f.view.element.querySelector('.mobile-header .mobile-session-title')?.textContent).toBe('产品研究搭档')
  await paste(f.view.element, '保留主 Agent 未发送草稿')
  const originalEditor = editor(f.view.element)
  await click(button(f.view.element, '查看本 Mote 团队'))
  expect(panel().textContent).toContain('请确认读取原资料范围'); expect(panel().textContent).toContain('正在整理下一步方案。')
  expect(panel().textContent).not.toContain('别的 Mote 成员'); expect(panel().textContent).not.toContain('不能混入当前团队')
  expect(panel().querySelectorAll('.mobile-mote-team-section:last-child [data-mote-member]')).toHaveLength(2)
  await click(button(document.body, '关闭面板'))
  expect(editor(f.view.element)).toBe(originalEditor); expect(originalEditor.textContent).toBe('保留主 Agent 未发送草稿')
  expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled(); expect(f.client.ensureAgentContinuity).not.toHaveBeenCalled()
})

it('actual member request navigation keeps original source and both drafts while returning to the saved main rather than first member', async () => {
  const f = await setup()
  await paste(f.view.element, '主对话的原草稿')
  await click(button(f.view.element, '查看本 Mote 团队')); await click(button(panel(), '打开原成员 · 资料研究员'))
  expect(f.owner.snapshot().record.selectedSessionId).toBe(memberId)
  expect(f.view.element.querySelector('.mobile-mote-recipient')?.textContent).toContain('成员资料研究员')
  expect(f.view.element.querySelector('.mobile-header .mobile-session-title')?.textContent).toBe('产品研究搭档')
  expect(button(f.view.element, '允许本次原资料读取')).toBeDefined()
  await paste(f.view.element, '成员的原草稿')
  expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
  await click(button(f.view.element, '允许本次原资料读取'))
  expect(f.respond).toHaveBeenCalledOnce()
  expect(f.respond.mock.calls[0]![0]).toMatchObject({ agentSessionId: memberId, moteSource: { spaceId, zoneId: 'original-zone', tabId: 'original-tab', regionId: 'member-region' } })
  await click(button(f.view.element, '回主对话'))
  expect(f.owner.snapshot().record.selectedSessionId).toBe(sid); expect(editor(f.view.element).textContent).toBe('主对话的原草稿')
  await click(button(f.view.element, '查看本 Mote 团队')); await click(button(panel(), '打开原成员 · 资料研究员'))
  expect(editor(f.view.element).textContent).toBe('成员的原草稿'); expect(f.respond).toHaveBeenCalledOnce()
})

it('unknown main reference is not replaced with a first member and healthy original input stays available', async () => {
  const original = catalog(); original.motePresentation![0]!.quickMode = { status: 'unconfirmed', message: '原主引用尚未确认' }; original.motePresentation![0]!.conversation = null
  const f = await setup(original)
  expect(f.view.element.querySelector('.mobile-mote-recipient')?.textContent).toContain('原对话')
  expect(f.view.element.querySelector('.mobile-mote-main-return')).toBeNull()
  await click(button(f.view.element, '查看本 Mote 团队'))
  expect(button(panel(), '核对主 Agent')).toBeDefined(); expect(panel().querySelector('.mobile-mote-role')?.textContent).not.toBe('主 Agent')
  await click(button(document.body, '关闭面板')); await paste(f.view.element, '健康原输入')
  expect(button(f.view.element, 'Send').disabled).toBe(false)
  expect(f.submit).not.toHaveBeenCalled()
})

it('multiple original positions remain explicit candidates and cold App reading preserves member and main drafts', async () => {
  const original = catalog()
  original.tabs.push({ ...original.tabs[0]!, tabId: 'second-tab', regionIds: ['second-region'] })
  original.regions.push({ ...original.regions[0]!, tabId: 'second-tab', regionId: 'second-region' })
  original.locations.push(place('second-region', 'second-tab'))
  const f = await setup(original)
  await paste(f.view.element, '冷读后保留主稿'); await click(button(f.view.element, '查看本 Mote 团队'))
  expect(panel().textContent).toContain('2 个原位置')
  await click(button(panel(), '打开原位置 · original-group / second-tab / second-region'))
  expect(f.owner.snapshot().record.presentation?.identity?.context?.regionId).toBe('second-region')
  await paste(f.view.element, '冷读后保留成员稿')
  await f.view.render(null); await f.view.render(f.app())
  await vi.waitFor(() => expect(f.view.element.querySelector('.mobile-mote-recipient')?.textContent).toContain('资料研究员'))
  expect(editor(f.view.element).textContent).toBe('冷读后保留成员稿')
  await click(button(f.view.element, '回主对话')); expect(editor(f.view.element).textContent).toBe('冷读后保留主稿')
  expect(f.owner.snapshot().record.selectedSessionId).toBe(sid)
})

it('a foreign Host with the same Session ID cannot contribute a request or retarget original navigation', async () => {
  const f = await setup()
  await act(async () => f.emit({ type: 'agent-session', session: { ...f.sessions.get(memberId)!, hostId: 'foreign-host' } }))
  await vi.waitFor(() => expect(f.view.element.querySelector('.mobile-mote-team-summary')?.textContent).not.toContain('需要你'))
  await click(button(f.view.element, '查看本 Mote 团队'))
  expect(panel().textContent).not.toContain('请确认读取原资料范围')
  const original = panel().querySelector<HTMLElement>('.mobile-mote-team-section:last-child [data-mote-member="other"][data-mote-host="host-original"]')!
  expect(original.textContent).not.toContain('资料研究员')
  await click(original.querySelector('.mobile-mote-member-open')!)
  expect(f.owner.snapshot().record.selectedSessionId).toBe(sid); expect(document.body.textContent).toContain('当前连接尚未匹配这个成员')
  expect(f.respond).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled()
})

it('failed team refresh retains original cards and only relevant Session changes read that Mote again', async () => {
  const f = await setup(), before = f.rpc.mock.calls.length
  await act(async () => f.emit({ type: 'agent-session', session: f.sessions.get('peer')! }))
  expect(f.rpc.mock.calls.length).toBe(before)
  f.fail(); await click(button(f.view.element, '查看本 Mote 团队')); await click(button(panel(), '刷新本 Mote 团队'))
  await vi.waitFor(() => expect(panel().textContent).toContain('原团队读取失败'))
  expect(panel().textContent).toContain('资料研究员'); expect(panel().textContent).toContain('正在整理下一步方案。')
  await click(button(document.body, '关闭面板')); await paste(f.view.element, '原团队读取失败后继续输入'); expect(button(f.view.element, 'Send').disabled).toBe(false)
  expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
})

it('late original team reads cannot replace a newly selected original Host or Mote', async () => {
  const f = await setup(), held = deferred<{ catalog: AgentMuxSpaceCatalog }>()
  f.rpc.mockImplementationOnce(() => held.promise)
  await click(button(f.view.element, '查看本 Mote 团队')); await click(button(panel(), '刷新本 Mote 团队'))
  const second = fixture(); second.client.forwardRpc = vi.fn().mockResolvedValue({ catalog: { ...catalog(), spaces: [] } })
  await f.view.render(<MobileApp client={second.client} connection={connected} platform={platform} />)
  await act(async () => held.resolve({ catalog: catalog() }))
  expect(panel().textContent).not.toContain('正在整理下一步方案。')
  expect(f.submit).not.toHaveBeenCalled(); expect(second.submit).not.toHaveBeenCalled()
})

it('member work entry reads its original Goal scope and returns to that conversation without starting work', async () => {
  const f = await setup()
  f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'original-runtime', ownerInstanceId: 'original-owner', availability: 'connected' })
  await paste(f.view.element, '查看成员工作仍保留主稿')
  await click(button(f.view.element, '查看本 Mote 团队'))
  const member = panel().querySelector<HTMLElement>('.mobile-mote-team-section:last-child [data-mote-member="other"]')!
  await click(button(member, '工作与结果'))
  await waitForElement(f.view.element, '.mobile-goal-work')
  await vi.waitFor(() => expect(f.rpc).toHaveBeenCalledWith('goal.ls', { agentSessionId: memberId }))
  expect(f.owner.snapshot().record.selectedSessionId).toBe(memberId)
  await click(button(f.view.element, '返回对话'))
  expect(f.owner.snapshot().record.selectedSessionId).toBe(memberId)
  await click(button(f.view.element, '回主对话'))
  expect(f.owner.snapshot().record.selectedSessionId).toBe(sid); expect(editor(f.view.element).textContent).toBe('查看成员工作仍保留主稿')
  expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled(); expect(f.client.ensureAgentContinuity).not.toHaveBeenCalled()
})

it('same Mote SID on two execution Hosts remains two exact members and a wrong Host click never retargets the current conversation', async () => {
  const original = catalog()
  original.tabs[0]!.regionIds.push('foreign-member-region')
  original.regions.push({ ...original.regions[0]!, regionId: 'foreign-member-region', execution: { hostId: 'foreign-host', cwd: '/foreign' } })
  original.locations.push(place('foreign-member-region'))
  const f = await setup(original)
  await paste(f.view.element, '准确原主稿')
  await click(button(f.view.element, '查看本 Mote 团队'))
  const rows = [...panel().querySelectorAll<HTMLElement>('.mobile-mote-team-section:last-child [data-mote-member="other"]')]
  expect(rows).toHaveLength(2)
  expect(new Set(rows.map(row => row.dataset.moteHost))).toEqual(new Set(['host-original', 'foreign-host']))
  expect(new Set(rows.map(row => row.dataset.moteMemberKey)).size).toBe(2)
  for (const row of rows) expect(row.textContent).not.toContain('资料研究员')
  const foreign = rows.find(row => row.dataset.moteHost === 'foreign-host')!
  await click(foreign.querySelector('.mobile-mote-member-open')!)
  expect(f.owner.snapshot().record.selectedSessionId).toBe(sid)
  expect(document.body.textContent).toContain('当前连接尚未匹配这个成员')
  const matching = rows.find(row => row.dataset.moteHost === 'host-original')!
  await click(matching.querySelector('.mobile-mote-member-open')!)
  expect(f.owner.snapshot().record.selectedSessionId).toBe(memberId)
  expect(f.owner.snapshot().record.presentation?.identity?.context?.regionId).toBe('member-region')
  await click(button(f.view.element, '回主对话'))
  expect(editor(f.view.element).textContent).toBe('准确原主稿')
  expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
})

it('unknown execution Hosts retain independent original Regions and never borrow the cached same SID target or name', async () => {
  const original = catalog()
  delete original.regions[0]!.execution
  original.tabs[0]!.regionIds.push('second-unknown-region')
  original.regions.push({ ...original.regions[0]!, regionId: 'second-unknown-region' })
  original.locations.push(place('second-unknown-region'))
  const f = await setup(original)
  await paste(f.view.element, 'Host 未知仍保留原主稿')
  await click(button(f.view.element, '查看本 Mote 团队'))
  const rows = [...panel().querySelectorAll<HTMLElement>('.mobile-mote-team-section:last-child [data-mote-member="other"]')]
  expect(rows).toHaveLength(2)
  expect(panel().textContent).toContain('1 位 Agent · 2 处待确认')
  expect(new Set(rows.map(row => row.dataset.moteMemberKey)).size).toBe(2)
  expect(panel().querySelector('.mobile-mote-team-section h3')?.textContent).not.toContain('需要你')
  for (const row of rows) {
    expect(row.dataset.moteHost).toBe(''); expect(row.textContent).not.toContain('资料研究员')
    expect(row.textContent).toContain('原位置与恢复'); expect(row.querySelector('button')!.disabled).toBe(false)
    await click(row.querySelector('.mobile-mote-member-open')!)
    expect(f.owner.snapshot().record.selectedSessionId).toBe(sid)
  }
  expect(panel().textContent).toContain('member-region'); expect(panel().textContent).toContain('second-unknown-region')
  expect(document.body.textContent).toContain('这个成员的执行端尚未确认')
  await click(button(rows[0]!, '刷新原团队'))
  expect(f.rpc).toHaveBeenCalledWith('space.ls', { target: { spaceId }, presentation: true })
  await click(button(document.body, '关闭面板'))
  expect(editor(f.view.element).textContent).toBe('Host 未知仍保留原主稿'); expect(button(f.view.element, 'Send').disabled).toBe(false)
  expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled(); expect(f.client.ensureAgentContinuity).not.toHaveBeenCalled()
})
