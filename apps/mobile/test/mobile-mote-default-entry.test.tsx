import { appendFileSync } from 'node:fs'
import { act } from 'react'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import type { MoteDialoguePage } from '@agentmux/core/mote-dialogue'
import { PMO_TEAMS_TOPIC_ID } from '@agentmux/core/mote-preferences'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, deferred, editor, fixture, mount, mounted, paste, session, waitForElement } from './conversation-fixture'
import { fixturePath } from '../../../test/fixture-values.mjs'

const connected = { state: 'connected' as const, message: '原 Host 已连接' }
const hostId = 'host-original', mainSid = 'other', workerSid = 'peer'
const spaceId = 'mote-chosen', zoneId = 'chosen-zone', workspaceId = 'chosen-workspace', workspacePath = fixturePath('mote-entry')
const main = { hostId, sessionId: mainSid, displayWorkspaceId: workspaceId, groupId: 'chosen-group', tabId: 'chosen-tab', regionId: 'chosen-main' }
const content = { hostId, workspaceId, workspacePath, zoneId }
const target = { spaceId, zoneId, expectedResource: { hostId, workspaceId, workspacePath } }
const identity = { name: '原承接者', project: '原 Mote', mote: { spaceId, name: '原 Mote', contentReference: content } }
function catalog(): AgentMuxSpaceCatalog {
  const primary = { ...main, sessionId: 'session-original', tabId: 'primary-tab', regionId: 'primary-main' }
  const place = (regionId: string) => ({ spaceId, zoneId, workspaceId, displayWorkspaceId: workspaceId, groupId: main.groupId, tabId: main.tabId, regionId })
  return { spaces: [
    { spaceId: 'mote-primary', kind: 'mote', name: '另一主 Mote', topicId: PMO_TEAMS_TOPIC_ID, hostId, directoryPath: workspacePath, projectId: null },
    { spaceId, kind: 'mote', name: '原 Mote', topicId: 'chosen-topic', hostId, directoryPath: workspacePath, projectId: null }
  ], zones: [{ zoneId, workspaceId, hostId, directoryPath: workspacePath, kind: 'home', branch: null }], bindings: [{ spaceId, zoneId }],
  tabs: [{ tabId: main.tabId, zoneId, workspaceId, name: '原工作', regionIds: ['chosen-worker', main.regionId] }],
  // A member deliberately precedes Main in both regions and display rows.
  regions: [{ tabId: main.tabId, regionId: 'chosen-worker', kind: 'agent', agentSessionId: workerSid, execution: { hostId, cwd: workspacePath } },
    { tabId: main.tabId, regionId: main.regionId, kind: 'agent', agentSessionId: mainSid, execution: { hostId, cwd: workspacePath } }],
  locations: [place('chosen-worker'), place(main.regionId)],
  motePresentation: [{ spaceId: 'mote-primary', content: null, quickMode: { status: 'saved', version: 'primary-version', defaults: { conversation: primary } }, conversation: primary },
    { spaceId, content, quickMode: { status: 'saved', version: 'chosen-version', defaults: { conversation: main, conversationRevision: 'chosen-role' } }, conversation: main }],
  agentPresentation: [workerSid, mainSid, 'session-original'].map(agentSessionId => ({ agentSessionId, name: agentSessionId === workerSid ? '原成员' : agentSessionId === mainSid ? '原承接者' : '另一承接者',
    project: '原 Mote', group: 'working', state: 'working', detail: '', providerId: 'codex', recap: null })) }
}
function dialogue(): MoteDialoguePage {
  return { main: { target, identity: { hostId, moteId: spaceId }, status: 'ready', resource: { ...content, zonePath: workspacePath, path: 'MOTE.md' },
    documentRevision: 'chosen-version', roleRevision: 'chosen-role', current: main, issue: null }, links: [], incarnation: 'original-journal', throughSequence: 0,
    next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null }
}
beforeEach(async () => {
  localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
  await getDeviceWorkface().updatePresentation({ selectedSessionId: 'session-original', hostUrl: '', panel: 'conversation' },
    { primary: 'focus', showSession: false, showGoalWork: false, recentMoteSpaceId: spaceId, identity: null, profile: null })
})
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  document.body.replaceChildren(); vi.restoreAllMocks()
})
afterAll(() => {
  const marker = (globalThis as any).__mobileMoteEntryEvaluated
  expect(marker, 'The real MobileApp source was evaluated').toBeDefined()
  if (process.env.AGENTMUX_TEST_MOTE_ENTRY_TRACE) appendFileSync(process.env.AGENTMUX_TEST_MOTE_ENTRY_TRACE, JSON.stringify({ phase: 'evaluated', ...marker }) + '\n')
})
async function original(facts = catalog()) {
  const f = fixture(), owner = getDeviceWorkface(), ensure = vi.fn(async (input: any) => ({ operationId: input.operationId, agentSessionId: input.agentSessionId,
    previousRun: input.expectedRun, kind: 'reattachable', reason: 'run-running' }))
  f.client.ensureAgentContinuity = ensure
  let delayed: ReturnType<typeof deferred<{ catalog: AgentMuxSpaceCatalog }>> | null = null
  const rpc = vi.fn(async (method: string, input: any) => {
    if (method === 'space.ls' || method === 'space.inspect') {
      if (input.target?.spaceId === spaceId && delayed) return delayed.promise
      return { catalog: facts }
    }
    if (method === 'agent.inspect') return { session: f.client.agentSession(input.target.agentSessionId), routeHostId: hostId }
    if (method === 'space.mote.dialogue.read') {
      const page = dialogue(), fact = facts.motePresentation?.find(value => value.spaceId === spaceId)
      if (fact?.quickMode.status !== 'saved' || !fact.quickMode.defaults.conversation) page.main = { ...page.main, current: null, documentRevision: null, roleRevision: 'unbound-role' }
      return page
    }
    if (method === 'space.mote.preferences.read') return { kind: 'quick', target: input.target, status: 'unconfirmed', source: null, defaults: null,
      choices: { executors: [], conversations: [], destinations: [] }, main: false, issue: '原快捷配置待读取；原对象与草稿保留。' }
    if (method === 'space.state') return { state: null }
    return { agents: [], workspaces: [], projects: [], executors: [], unavailable: [], goals: [], categories: [], topics: [] }
  })
  f.client.forwardRpc = rpc
  const platform = createBrowserPlatform(), render = (client = f.client) => <MobileApp client={client} connection={connected} platform={platform} restoreWorkface />
  const view = await mount(render())
  const nav = () => view.element.querySelector<HTMLElement>('.mobile-navigation')!
  await click(button(nav(), 'Focus'))
  await waitForElement(view.element, '.mobile-session-list')
  return { ...f, owner, rpc, ensure, view, render, facts, nav,
    delayEntry() { delayed = deferred(); return delayed },
    async directory() { await click(button(view.element, '返回 Mote')); await waitForElement(view.element, '.mobile-mote-choice') } }
}
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 10000, interval: 10 }) }
function mainIsVisible(f: Awaited<ReturnType<typeof original>>) {
  expect(f.owner.snapshot().record.selectedSessionId).toBe(mainSid)
  expect(f.view.element.querySelector('.mobile-conversation-panel')?.hasAttribute('hidden')).toBe(false)
  expect(f.view.element.querySelector('.mobile-mote-navigation [aria-selected="true"]')?.textContent).toBe('Discussion')
  expect(f.owner.snapshot().record.presentation?.moteView).toMatchObject({ spaceId, section: 'discussion', directAgent: false })
}

it('opens the exact saved recent Mote Main from the actual bottom bar, retaining the original composer and draft', async () => {
  const f = await original()
  await click([...f.view.element.querySelectorAll<HTMLButtonElement>('.mobile-agent-row__open')].find(value => value.textContent?.includes('另一承接者'))!)
  await waitForElement(f.view.element, '[contenteditable="true"]')
  const originalEditor = editor(f.view.element)
  await paste(f.view.element, '原 Session 的未发送草稿')
  await click(button(f.nav(), 'Mote'))
  await wait(() => mainIsVisible(f))
  expect(f.rpc).toHaveBeenCalledWith('space.ls', { target: { spaceId }, presentation: true })
  expect(editor(f.view.element)).toBe(originalEditor)
  expect(f.owner.snapshot().record.conversation.drafts).toContainEqual([JSON.stringify(['draft', 'session-original']), '原 Session 的未发送草稿'])
  expect(f.ensure).toHaveBeenCalledTimes(1)
  expect(f.ensure).toHaveBeenCalledWith(expect.objectContaining({ agentSessionId: mainSid, expectedRun: f.sessions.get(mainSid)!.run }))
  expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
})

it('uses the unique original primary Mote only when this device has no recent Mote', async () => {
  await getDeviceWorkface().updatePresentation({ selectedSessionId: 'session-original', hostUrl: '', panel: 'conversation' },
    { primary: 'focus', showSession: false, showGoalWork: false, identity: null, profile: null })
  const f = await original()
  await click(button(f.nav(), 'Mote'))
  await wait(() => expect(f.owner.snapshot().record.presentation?.moteView).toMatchObject({ spaceId: 'mote-primary', section: 'discussion', directAgent: false }))
  expect(f.owner.snapshot().record.selectedSessionId).toBe('session-original')
  expect(f.submit).not.toHaveBeenCalled()
})

it('opens a concrete Mote choice directly as Main and keeps explicit member input direct through background refresh', async () => {
  const f = await original()
  await click(button(f.nav(), 'Mote')); await wait(() => mainIsVisible(f)); await f.directory()
  await click(button(f.view.element, '打开 Mote 主对话 · 原 Mote')); await wait(() => mainIsVisible(f))
  await paste(f.view.element, '主对话原稿')
  await click(button(f.view.element, 'Threads'))
  await waitForElement(f.view.element, '[aria-label="打开原成员 · 原成员"]')
  await click(button(f.view.element, '打开原成员 · 原成员'))
  await wait(() => expect(f.owner.snapshot().record.selectedSessionId).toBe(workerSid))
  await paste(f.view.element, '成员原稿')
  const before = f.ensure.mock.calls.length
  await act(async () => f.emit({ type: 'agent-session', session: { ...session(workerSid), updatedAt: 2 } }))
  await act(async () => f.emit({ type: 'connection-state', state: 'restored', evidence: { source: 'native-hook', observedAt: 2, run: { runId: 'run-peer' } } } as any))
  expect(f.owner.snapshot().record.selectedSessionId).toBe(workerSid)
  expect(f.owner.snapshot().record.presentation?.moteView).toMatchObject({ section: 'threads', directAgent: true })
  expect(editor(f.view.element).textContent).toBe('成员原稿'); expect(f.ensure).toHaveBeenCalledTimes(before)
  await click(button(f.view.element, 'Discussion')); await wait(() => mainIsVisible(f))
  expect(editor(f.view.element).textContent).toBe('主对话原稿')
  expect(f.owner.snapshot().record.conversation.drafts).toContainEqual([JSON.stringify(['draft', workerSid]), '成员原稿'])
  expect(f.submit).not.toHaveBeenCalled()
})

it('uses original Profile Setup for the exact unbound Mote without borrowing the primary Mote or its first member', async () => {
  const facts = catalog(); facts.motePresentation![1]!.quickMode = { status: 'missing' }; facts.motePresentation![1]!.conversation = null
  const f = await original(facts)
  await click(button(f.nav(), 'Mote'))
  await waitForElement(document.body, '.mobile-mote-profile')
  expect(f.owner.snapshot().record.selectedSessionId).toBe('session-original')
  expect(f.owner.snapshot().record.presentation?.profile?.identity.mote?.spaceId).toBe(spaceId)
  expect(document.body.querySelector('.mobile-mote-profile')?.getAttribute('data-mote-space-id')).toBe(spaceId)
  expect(document.body.querySelector('.mobile-mote-setup')).not.toBeNull()
  expect(f.rpc).toHaveBeenCalledWith('space.mote.preferences.read', { kind: 'quick', target })
  expect(f.ensure).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled()
  expect(f.rpc.mock.calls.some(([method]) => method.includes('setup.advance') || method === 'agent.open')).toBe(false)
})

it('keeps a saved Main reference navigable when Session metadata and its original place are unavailable', async () => {
  const facts = catalog(); facts.locations = []; facts.motePresentation![1]!.conversation = null
  const f = await original(facts); f.sessions.delete(mainSid)
  await click(button(f.nav(), 'Mote')); await wait(() => mainIsVisible(f))
  expect(f.owner.snapshot().record.presentation?.identity?.context).toBeUndefined()
  expect(f.owner.snapshot().record.presentation?.identity?.mote?.spaceId).toBe(spaceId)
  expect(f.ensure).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled()
})

it('does not let a delayed explicit Main lookup replace later navigation or an explicit member selection', async () => {
  const f = await original(), pending = f.delayEntry()
  await click(button(f.nav(), 'Mote')); await waitForElement(f.view.element, '.mobile-mote-agents')
  await click(f.view.element.querySelector<HTMLButtonElement>('.mobile-mote-agents .mobile-agent-row__open')!)
  await wait(() => expect(f.owner.snapshot().record.selectedSessionId).toBe(workerSid))
  await act(async () => pending.resolve({ catalog: f.facts }))
  expect(f.owner.snapshot().record.selectedSessionId).toBe(workerSid)
  expect(f.owner.snapshot().record.presentation?.moteView).toMatchObject({ section: 'threads', directAgent: true })
  expect(f.ensure).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled()
})

it('does not let the prior client or Runtime return take over a later primary workface', async () => {
  const f = await original(), pending = f.delayEntry()
  await click(button(f.nav(), 'Mote'))
  await click(button(f.nav(), 'Focus'))
  const second = fixture(); second.client.forwardRpc = vi.fn(async () => ({ catalog: f.facts })) as any
  await f.view.render(f.render(second.client))
  await act(async () => pending.resolve({ catalog: f.facts }))
  expect(f.owner.snapshot().record.selectedSessionId).toBe('session-original')
  expect(f.view.element.querySelector('.mobile-conversation-panel')?.hasAttribute('hidden')).toBe(true)
  expect(f.nav().querySelector('[aria-current="page"]')?.textContent).toBe('Focus')
  expect(f.ensure).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled(); expect(second.submit).not.toHaveBeenCalled()
})

it.each(['client', 'runtime'] as const)('keeps the original reading when the %s owner changes during an explicit Main lookup', async change => {
  const f = await original(), pending = f.delayEntry()
  await click(button(f.nav(), 'Mote'))
  if (change === 'client') {
    const second = fixture(); second.client.forwardRpc = vi.fn(async () => ({ catalog: f.facts })) as any
    await f.view.render(f.render(second.client))
  } else f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'replacement-runtime' })
  await act(async () => pending.resolve({ catalog: f.facts }))
  expect(f.owner.snapshot().record.selectedSessionId).toBe('session-original')
  expect(f.view.element.querySelector('.mobile-conversation-panel')?.hasAttribute('hidden')).toBe(true)
  expect(f.ensure).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled()
})

it('retains an explicitly restored member route through discovery instead of automatically returning to Main', async () => {
  await getDeviceWorkface().updatePresentation({ selectedSessionId: workerSid, hostUrl: '', panel: 'conversation' },
    { primary: 'mote', showSession: true, showGoalWork: false, recentMoteSpaceId: spaceId, identity, profile: null,
      moteView: { spaceId, section: 'threads', detail: true, directAgent: true } })
  const f = fixture(), ensure = vi.fn(); f.client.ensureAgentContinuity = ensure
  f.client.forwardRpc = vi.fn(async (method: string) => method === 'space.mote.dialogue.read' ? dialogue() : { catalog: catalog() }) as any
  const view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} restoreWorkface />)
  await waitForElement(view.element, '.mobile-mote-thread-return')
  await act(async () => f.emit({ type: 'connection-state', state: 'restored', evidence: { source: 'native-hook', observedAt: 2 } } as any))
  expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe(workerSid)
  expect(getDeviceWorkface().snapshot().record.presentation?.moteView).toMatchObject({ section: 'threads', directAgent: true })
  expect(ensure).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled()
})
