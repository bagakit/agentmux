import './mobile-lan-crypto.setup'
import { appendFileSync } from 'node:fs'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxInteractionRequest } from '@agentmux/core'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { parseSpaceControlSuccessReceipt } from '../../../packages/core/src/space-control-parser'
import { MobileApp } from '../src/MobileApp'
import { MobileSpatialNavigation } from '../src/navigation/MobileSpatialNavigation'
import { MobileMoteTeamPanel } from '../src/navigation/MobileMoteTeam'
import { mobileMoteTeam } from '../src/navigation/mobile-mote-team'
import { MobileAgentMenuContext, type MobileAgentMenuTarget } from '../src/navigation/MobileAgentRow'
import { createBrowserPlatform } from '../src/platform/browser'
import { saveMobileHome } from '../src/navigation/home-preference'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, fixture, mount, mounted, session } from './conversation-fixture'
import { fixturePath } from '../../../test/fixture-values.mjs'

type Row = NonNullable<AgentMuxSpaceCatalog['agentPresentation']>[number]
const sid = 'session-original', hostId = 'host-original'
const rows: Row[] = [
  { agentSessionId: sid, name: '原未知 Agent', project: '原项目', group: 'idle', state: 'disconnected', stateMark: 'unknown', presenceUnknown: true, stateLabel: 'Run not observed', detail: '原 Host 观测失败；保留准确 Session 与 Run。', providerId: 'codex', recap: null },
  { agentSessionId: 'peer', name: '原工作 Agent', project: '原项目', group: 'working', state: 'working', stateMark: 'working', stateLabel: 'Run not observed', detail: '展示文案不决定工作状态', providerId: 'codex', recap: null },
  { agentSessionId: 'other', name: '原错误 Agent', project: '原项目', group: 'attention', state: 'error', stateMark: 'error', presenceUnknown: true, stateLabel: 'Run not observed', detail: '准确错误不因观测未知被隐藏', providerId: 'codex', recap: null },
  { agentSessionId: 'permission-original', name: '原权限 Agent', project: '原项目', group: 'attention', state: 'waiting', stateMark: 'attention', presenceUnknown: true, stateLabel: '原权限请求', detail: '需要明确授权', providerId: 'codex', recap: null },
  { agentSessionId: 'question-original', name: '原问题 Agent', project: '原项目', group: 'attention', state: 'blocked', stateMark: 'attention', presenceUnknown: true, stateLabel: '原问题待答复', detail: '需要原问题的回答', providerId: 'codex', recap: null }
]
function catalog(kind: 'mote' | 'topic' = 'topic'): AgentMuxSpaceCatalog {
  const raw: AgentMuxSpaceCatalog = { spaces: [{ spaceId: 'space-original', kind, name: '原项目', hostId, directoryPath: fixturePath('quiet-status'), projectId: null }],
    zones: [{ zoneId: 'zone-original', kind: 'home', hostId, workspaceId: 'workspace-original', directoryPath: fixturePath('quiet-status'), branch: null }],
    bindings: [{ spaceId: 'space-original', zoneId: 'zone-original' }],
    tabs: [{ tabId: 'tab-original', zoneId: 'zone-original', workspaceId: 'workspace-original', name: '原工作面', regionIds: rows.map(row => 'region-' + row.agentSessionId) }],
    regions: rows.map(row => ({ tabId: 'tab-original', regionId: 'region-' + row.agentSessionId, kind: 'agent', agentSessionId: row.agentSessionId, runId: session(row.agentSessionId).run.runId, execution: { hostId, cwd: fixturePath('quiet-status') } })),
    locations: rows.map(row => ({ spaceId: 'space-original', zoneId: 'zone-original', workspaceId: 'workspace-original', displayWorkspaceId: 'display-original', groupId: 'group-original', tabId: 'tab-original', regionId: 'region-' + row.agentSessionId })),
    agentPresentation: structuredClone(rows) }
  return (parseSpaceControlSuccessReceipt({ schemaVersion: 5, requestId: 'quiet-status-read', operation: 'space.ls', ok: true, result: { catalog: raw } }).result as { catalog: AgentMuxSpaceCatalog }).catalog
}
function original() {
  const f = fixture(), facts = catalog()
  for (const row of rows) f.sessions.set(row.agentSessionId, session(row.agentSessionId))
  const ensure = vi.fn(); f.client.ensureAgentContinuity = ensure
  const rpc = vi.fn(async (method: string, input: any) => {
    if (method === 'space.ls') return { catalog: facts }
    if (method === 'agent.inspect') return { routeHostId: hostId, session: f.client.agentSession(input.target.agentSessionId), status: null, unavailable: [], displayName: { override: null, source: null, nameRevision: 0, availability: 'observed' } }
    return { agents: [], unavailable: [], goals: [], topics: [], categories: [] }
  })
  f.client.forwardRpc = rpc as never
  return { ...f, facts, rpc, ensure, directoryReads: () => rpc.mock.calls.filter(([method]) => method === 'space.ls').length }
}
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 10000 }) }
beforeEach(async () => {
  const evaluated = (globalThis as any).__mobileQuietRunStatusEvaluated as Array<{ name: string; file: string; applied: boolean; originalSha256: string; loadedSha256: string }>
  for (const suffix of ['mobile-agent-status.ts', 'MobileAgentStatusDetails.tsx', 'MobileSpatialNavigation.tsx', 'MobileMoteTeam.tsx', 'MobileAgentRow.tsx', 'MobileAgentActions.tsx', 'MobileApp.tsx']) {
    expect(evaluated.some(value => value.file.endsWith('/' + suffix)), 'Real consumer module evaluated: ' + suffix).toBe(true)
  }
  if (process.env.AGENTMUX_MOBILE_QUIET_MUTATION) expect(evaluated.some(value => value.applied && value.originalSha256 !== value.loadedSha256)).toBe(true)
  if (process.env.AGENTMUX_MOBILE_QUIET_TRACE) for (const value of evaluated) appendFileSync(process.env.AGENTMUX_MOBILE_QUIET_TRACE, JSON.stringify({ phase: 'evaluated', ...value }) + '\n')
  window.history.replaceState(null, ''); localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
})
afterEach(async () => {
  for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks()
})

it.each(['focus', 'space'] as const)('quiets ordinary unknown text and glyph in actual %s rows without hiding errors, requests or original navigation', async home => {
  const f = original(), open = vi.fn()
  const view = await mount(<MobileSpatialNavigation home={home} client={f.client} connected sessions={f.client.agentSessions()} openSession={open}
    initialContext={home === 'space' ? { spaceId: 'space-original', tabId: null, regionId: null } : undefined} />)
  await wait(() => expect(view.element.querySelectorAll('.mobile-agent-row__open')).toHaveLength(rows.length))
  const named = (name: string) => [...view.element.querySelectorAll<HTMLElement>('.mobile-agent-row__open')].find(node => node.querySelector('strong')?.textContent === name)!
  const unknown = named('原未知 Agent')
  expect(unknown.querySelector('.mobile-session-state > span[title]')).toBeNull()
  expect(unknown.querySelector('[data-focus-state-icon]')).toBeNull()
  expect(unknown.textContent).toContain('codex')
  expect(named('原工作 Agent').querySelector('[data-focus-state-icon="working"]')).not.toBeNull()
  expect(named('原工作 Agent').querySelector('.mobile-session-state > span[title]')?.textContent).toBe('Run not observed')
  expect(named('原错误 Agent').querySelector('[data-focus-state-icon="error"]')).not.toBeNull()
  expect(named('原权限 Agent').textContent).toContain('原权限请求')
  expect(named('原问题 Agent').textContent).toContain('原问题待答复')
  await click(unknown)
  expect(open).toHaveBeenCalledExactlyOnceWith(sid, expect.anything())
  expect(f.submit).not.toHaveBeenCalled(); expect(f.ensure).not.toHaveBeenCalled()
  // Renaming display copy cannot change typed unknown eligibility.
  f.facts.agentPresentation![0]!.stateLabel = 'Working'
  await click(button(view.element, '刷新空间目录'))
  await wait(() => expect(f.directoryReads()).toBe(2))
  expect(named('原未知 Agent').querySelector('.mobile-session-state > span[title]')).toBeNull()
})

it('keeps original Team reasons and a read-only refresh folded on demand while real permission and question requests remain visible', async () => {
  const f = original(), facts = catalog('mote'), team = mobileMoteTeam(facts, 'space-original', f.client)!, refresh = vi.fn(), open = vi.fn()
  for (const [id, kind] of [['permission-original', 'permission'], ['question-original', 'question']] as const) {
    const member = team.members.find(value => value.sessionId === id)!
    const request: AgentMuxInteractionRequest = kind === 'permission' ? { kind, id: 'permission-request', agentSessionId: id, title: '允许原文件读取？', options: [], evidence: { source: 'native-hook', observedAt: 1 } }
      : { kind, id: 'question-request', agentSessionId: id, questions: [{ id: 'original-question', prompt: '选择原方案？', options: [] }], evidence: { source: 'native-hook', observedAt: 1 } }
    member.request = request
    member.presentation = { ...rows[0]!, agentSessionId: id, name: member.name }
  }
  const view = await mount(<MobileMoteTeamPanel team={team} issue={null} currentSessionId={null} onRefresh={refresh} onOpen={open} onMain={() => {}} onWork={() => {}} onConfigure={() => {}} />)
  const unknown = view.element.querySelector<HTMLElement>('[data-mote-member="session-original"]')!
  expect(unknown.querySelector('.mobile-mote-member-copy .mobile-mote-member-state')).toBeNull()
  expect(unknown.querySelector('[data-focus-state-icon]')).toBeNull()
  const detail = unknown.querySelector<HTMLDetailsElement>('.mobile-agent-status-details')!
  expect(detail.open).toBe(false); expect(detail.querySelector('summary')?.textContent).toBe('状态与来源')
  await click(detail.querySelector('summary')!)
  expect(detail.textContent).toContain('不代表会话已结束'); expect(detail.textContent).toContain(rows[0]!.stateLabel)
  expect(detail.textContent).toContain(rows[0]!.detail)
  await click(button(detail, '刷新状态')); expect(refresh).toHaveBeenCalledOnce()
  expect(view.element.textContent).toContain('权限请求 · 允许原文件读取？'); expect(view.element.textContent).toContain('等待答复 · 选择原方案？')
  for (const id of ['permission-original', 'question-original']) {
    const members = [...view.element.querySelectorAll<HTMLElement>('[data-mote-member="' + id + '"]')]
    expect(members).toHaveLength(2)
    expect(members.at(-1)!.querySelector('.mobile-mote-member-state')).not.toBeNull()
  }
  await click(button(unknown, '打开原成员 · 原未知 Agent'))
  expect(open).toHaveBeenCalledExactlyOnceWith(sid, expect.anything(), expect.objectContaining({ sessionId: sid }))
  expect(f.submit).not.toHaveBeenCalled(); expect(f.ensure).not.toHaveBeenCalled()
})

async function appMenu(missingPresentation = false) {
  const f = original(), owner = getDeviceWorkface()
  if (missingPresentation) delete f.facts.agentPresentation
  saveMobileHome('focus')
  await owner.updateNavigation({ selectedSessionId: 'peer', hostUrl: '', panel: 'sessions' })
  await owner.updateConversation({ version: 1, drafts: [['peer', '原未发送草稿']], attempts: [], responses: [] })
  const originalWorkface = owner.snapshot().record.conversation
  const view = await mount(<MobileApp client={f.client} connection={{ state: 'connected', message: '原 Host 已连接' }} platform={createBrowserPlatform()} />)
  await click(button(view.element.querySelector<HTMLElement>('.mobile-navigation')!, 'Focus'))
  await wait(() => expect(view.element.querySelectorAll('.mobile-agent-row__open')).toHaveLength(rows.length))
  if (missingPresentation) {
    const summary = [...view.element.querySelectorAll('summary')].find(node => node.textContent === '其他已有会话')!
    await click(summary)
    await click(view.element.querySelector('.mobile-agent-row__more')!)
  } else await click(button(view.element, '原未知 Agent · 更多操作'))
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
  expect(dialog).not.toBeNull()
  const detail = dialog.querySelector<HTMLDetailsElement>('.mobile-agent-status-details')!
  expect(detail).not.toBeNull(); expect(detail.open).toBe(false)
  await click(detail.querySelector('summary')!)
  return { ...f, ...view, dialog, detail, owner, originalWorkface }
}
it('actual App menu retains the original reason and queues only the original directory refresh until its sheet closes', async () => {
  const f = await appMenu(), reads = f.directoryReads()
  expect(f.detail.textContent).toContain(rows[0]!.stateLabel); expect(f.detail.textContent).toContain(rows[0]!.detail)
  await click(button(f.detail, '刷新状态'))
  expect(f.detail.textContent).toContain('回到原目录时重新读取')
  expect(f.directoryReads()).toBe(reads)
  expect(f.owner.snapshot().record.selectedSessionId).toBe('peer')
  expect(f.owner.snapshot().record.conversation).toEqual(f.originalWorkface)
  expect(button(f.dialog, '恢复原 Agent').disabled).toBe(false)
  await click(button(f.dialog, '关闭面板'))
  await wait(() => expect(f.directoryReads()).toBe(reads + 1))
  expect(f.rpc.mock.calls.filter(([method]) => method === 'space.ls').every(([, input]) => JSON.stringify(input) === JSON.stringify({ target: {}, presentation: true }))).toBe(true)
  expect(f.submit).not.toHaveBeenCalled(); expect(f.ensure).not.toHaveBeenCalled()
})
it('actual App stale menu source keeps original detail but refuses its refresh without changing healthy Agent input or lifecycle', async () => {
  const f = await appMenu(), reads = f.directoryReads()
  f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'another-runtime', ownerInstanceId: 'another-owner' })
  await click(button(f.detail, '刷新状态'))
  expect(f.detail.textContent).toContain('原目录来源已变化，未刷新')
  expect(f.directoryReads()).toBe(reads)
  expect(f.detail.textContent).toContain(rows[0]!.detail)
  expect(f.owner.snapshot().record.conversation).toEqual(f.originalWorkface)
  expect(f.submit).not.toHaveBeenCalled(); expect(f.ensure).not.toHaveBeenCalled()
})
it('an original row menu refresh cannot be lent to a new directory client', async () => {
  const first = original(), second = original(), menu = vi.fn<(target: MobileAgentMenuTarget) => void>()
  const render = (source = first) => <MobileAgentMenuContext.Provider value={menu}><MobileSpatialNavigation home="focus" client={source.client} connected sessions={source.client.agentSessions()} openSession={() => {}} /></MobileAgentMenuContext.Provider>
  const view = await mount(render())
  await wait(() => expect(button(view.element, '原未知 Agent · 更多操作')).toBeDefined())
  await click(button(view.element, '原未知 Agent · 更多操作'))
  const target = menu.mock.calls[0]![0]
  expect(target.presentation).toEqual(rows[0]); expect(target.refreshStatus).toBeTypeOf('function')
  await view.render(render(second)); await wait(() => expect(second.directoryReads()).toBe(1))
  const before = second.directoryReads()
  await act(async () => { expect(target.refreshStatus!()).toBe(false) })
  expect(second.directoryReads()).toBe(before)
  expect(first.directoryReads()).toBe(1)
})


it('healthy Team members with missing presentation retain a folded unknown explanation and original refresh without inventing source facts', async () => {
  const f = original(), facts = catalog('mote'); delete facts.agentPresentation
  const team = mobileMoteTeam(facts, 'space-original', f.client)!, refresh = vi.fn(), open = vi.fn()
  const member = team.members.find(value => value.sessionId === sid)!
  expect(member.session?.agentSessionId).toBe(sid); expect(member.issue).toBeUndefined(); expect(member.presentation).toBeUndefined()
  const view = await mount(<MobileMoteTeamPanel team={team} issue={null} currentSessionId={null} onRefresh={refresh} onOpen={open} onMain={() => {}} onWork={() => {}} onConfigure={() => {}} />)
  const row = view.element.querySelector<HTMLElement>('[data-mote-member="session-original"]')!
  expect(row.querySelector('.mobile-mote-member-copy .mobile-mote-member-state')).toBeNull()
  const detail = row.querySelector<HTMLDetailsElement>('.mobile-agent-status-details')!
  expect(detail).not.toBeNull(); expect(detail.open).toBe(false)
  await click(detail.querySelector('summary')!)
  expect(detail.textContent).toContain('目录尚未提供这条 Agent 的状态资料')
  expect(detail.textContent).toContain('不代表会话已结束')
  expect(detail.querySelector('.mobile-agent-status-details__label')).toBeNull(); expect(detail.querySelector('.mobile-agent-status-details__reason')).toBeNull()
  await click(button(detail, '刷新状态')); expect(refresh).toHaveBeenCalledOnce()
  await click(button(row, '打开原成员 · 成员名称未确认'))
  expect(open).toHaveBeenCalledExactlyOnceWith(sid, expect.anything(), expect.anything())
  expect(f.submit).not.toHaveBeenCalled(); expect(f.ensure).not.toHaveBeenCalled()
})
it('actual App SDK fallback row keeps missing presentation discoverable and refreshable through its original menu', async () => {
  const f = await appMenu(true), reads = f.directoryReads()
  expect(f.detail.textContent).toContain('目录尚未提供这条 Agent 的状态资料')
  expect(f.detail.querySelector('.mobile-agent-status-details__label')).toBeNull(); expect(f.detail.querySelector('.mobile-agent-status-details__reason')).toBeNull()
  await click(button(f.detail, '刷新状态'))
  expect(f.directoryReads()).toBe(reads)
  await click(button(f.dialog, '关闭面板'))
  await wait(() => expect(f.directoryReads()).toBe(reads + 1))
  expect(f.owner.snapshot().record.conversation).toEqual(f.originalWorkface)
  expect(f.submit).not.toHaveBeenCalled(); expect(f.ensure).not.toHaveBeenCalled()
})
