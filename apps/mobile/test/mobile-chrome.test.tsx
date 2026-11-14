import { fixtureEpoch, fixturePath } from '../../../test/fixture-values.mjs'
import { readFileSync } from 'node:fs'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PMO_TEAMS_TOPIC_ID } from '@agentmux/core/mote-preferences'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { activityStatus } from './activity-status-fixture'
import { button, click, editor, fixture, mount, mounted, openAppMenu, paste, waitForElement } from './conversation-fixture'
import { openPrimary } from './mobile-root-navigation'

// Canvas painting has separate renderer coverage; routing and the original Session stay real.
vi.mock('../src/terminal/MobileTerminalViewer', () => ({ MobileTerminalViewer: ({ agentSessionId }: { agentSessionId: string }) => <div data-terminal-session={agentSessionId} /> }))

const connected = { state: 'connected' as const, message: '原 Host' }
const order = ['Goals', 'Topics', 'Mote', 'Focus', 'Space']
const hostId = 'host-original', workspace = fixturePath('workspace'), execution = { hostId, cwd: workspace }
const resource = { hostId, workspaceId: 'original-workspace', workspacePath: workspace }
const main = { hostId, sessionId: 'session-original', displayWorkspaceId: 'original-workspace', groupId: 'mote-zone', tabId: 'main-tab', regionId: 'main-region' }
const agents = [
  { spaceId: 'original-mote', zoneId: 'mote-zone', tabId: 'main-tab', regionId: 'main-region', agentSessionId: 'session-original', name: 'Original Agent', waiting: false },
  { spaceId: 'original-mote', zoneId: 'mote-zone', tabId: 'member-tab', regionId: 'member-region', agentSessionId: 'other', name: 'Member Agent', waiting: false },
  { spaceId: 'original-project', zoneId: 'project-zone', tabId: 'project-tab', regionId: 'project-region', agentSessionId: 'peer', name: 'Project Agent', waiting: true }]
const catalog = {
  spaces: [{ spaceId: 'original-mote', kind: 'mote', name: 'Original Mote', topicId: PMO_TEAMS_TOPIC_ID, hostId, directoryPath: workspace, projectId: null },
    { spaceId: 'original-project', kind: 'project', name: 'Original Project Space', hostId, directoryPath: workspace, projectId: null }],
  zones: ['mote-zone', 'project-zone'].map(zoneId => ({ zoneId, workspaceId: resource.workspaceId, hostId, directoryPath: workspace, kind: 'home', branch: null })),
  bindings: [{ spaceId: 'original-mote', zoneId: 'mote-zone' }, { spaceId: 'original-project', zoneId: 'project-zone' }],
  tabs: agents.map(agent => ({ tabId: agent.tabId, zoneId: agent.zoneId, workspaceId: resource.workspaceId, name: agent.name, regionIds: [agent.regionId] })),
  regions: agents.map(agent => ({ regionId: agent.regionId, tabId: agent.tabId, kind: 'agent', agentSessionId: agent.agentSessionId,
    runId: agent.agentSessionId === 'session-original' ? 'run-original' : `run-${agent.agentSessionId}`, execution })),
  locations: agents.map(agent => ({ spaceId: agent.spaceId, zoneId: agent.zoneId, workspaceId: resource.workspaceId, displayWorkspaceId: resource.workspaceId,
    groupId: agent.zoneId, tabId: agent.tabId, regionId: agent.regionId })),
  // The directory reads every row as working or waiting; the open conversation's header must not borrow that.
  agentPresentation: agents.map(agent => ({ agentSessionId: agent.agentSessionId, name: agent.name, project: 'Original Project', providerId: 'codex', recap: null,
    ...(agent.waiting ? { group: 'attention', state: 'waiting', stateMark: 'attention', detail: '等待你的确认' } : { group: 'working', state: 'working', detail: 'Working' }) })),
  motePresentation: [{ spaceId: 'original-mote', content: { ...resource, zoneId: 'mote-zone' }, conversation: main,
    quickMode: { status: 'saved', version: 'original-source', defaults: { conversation: main, conversationRevision: 'original-role' } } }]
}
const target = { spaceId: 'original-mote', zoneId: 'mote-zone', expectedResource: resource }
const dialogue = () => ({ main: { target, identity: { hostId, moteId: 'original-mote' }, status: 'ready', resource: { ...resource, zoneId: 'mote-zone', zonePath: workspace, path: 'MOTE.md' },
  documentRevision: 'original-source', roleRevision: 'original-role', current: main, issue: null },
  links: [], incarnation: 'original-journal', throughSequence: 0, next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null })
const goal = { id: 'original-goal', title: '原Goal', description: '原目标正文', status: 'backlog', priority: 'normal', sessionIds: ['session-original'], assigneeSessionIds: ['session-original'],
  supervisorSessionId: 'session-original', participations: [], activityLog: [], source: 'session', createdAt: fixtureEpoch(0, 0, 1), updatedAt: fixtureEpoch(0, 0, 7) }
const category = { categoryId: 'category-original', title: '工作分类', hostId: 'local', spaceId: 'category-space', directoryPath: fixturePath('workspace/category'), revision: 'category-version' }
const topic = { topicId: 'topic-original', title: '讨论甲', summary: '', hostId: 'local', zoneId: 'project-zone', directoryPath: fixturePath('workspace/topic'), categorySpaceIds: [category.spaceId], chatIds: [], spatialRevision: 1 }

function originalClient() {
  const f = fixture(), state = { rootFails: false, dialogueFails: false }
  f.client.runtimeOwnerIdentity = () => ({ runtimeId: 'original-runtime', ownerInstanceId: 'original-process', availability: 'connected' })
  const rpc = vi.fn(async (method: string, params: any) => {
    if (method === 'space.ls') {
      if (state.rootFails && JSON.stringify(params.target) === '{}') throw new Error('原需要你来源暂不可读')
      return { catalog: structuredClone(catalog) }
    }
    if (method === 'space.mote.dialogue.read') { if (state.dialogueFails) throw new Error('原主对话读取失败，旧来源保留'); return dialogue() }
    if (method === 'space.mote.preferences.read') return { kind: 'quick', target, status: 'ready', main: false, issue: null,
      source: { resource: dialogue().main.resource, result: { status: 'read', document: { path: 'MOTE.md', content: '# Original Mote', revision: 'sha256:' + 'a'.repeat(64) } } },
      defaults: { executorId: 'original-executor', conversation: main, conversationRevision: 'original-role' },
      choices: { executors: [{ id: 'original-executor', name: 'Original executor', providerId: 'codex' }], conversations: [], destinations: [] } }
    if (method === 'space.state') return { state: { graph: { resources: {} } } }
    if (method === 'goal.ls') return { goals: [goal] }
    if (method === 'goal.inspect') return { goal, goalContinuations: [] }
    if (method === 'goal.decisions') return { goalId: goal.id, decisions: [] }
    if (method === 'goal.discuss') return { goal, receipt: { route: 'discussion', goalId: goal.id, tabId: 'main-tab', regionId: 'main-region', hostId: 'local', agentSessionId: 'session-original', mode: params.mode, operationId: params.operationId } }
    if (method === 'topic.category.ls') return { categories: [category], unavailable: [] }
    if (method === 'topic.ls') return { topics: [topic], unavailable: [] }
    if (method === 'topic.inspect') return { topic, unavailable: [] }
    if (method === 'agent.inspect') return { session: f.client.agentSession(params.agentSessionId), displayName: { override: null, availability: 'observed' } }
    if (method === 'app.snapshot') return { agents: [], workspaces: [], projects: [], executors: [], unavailable: [] }
    throw new Error('Unconfigured observation: ' + method)
  })
  f.client.forwardRpc = rpc as any
  return { ...f, rpc, state, calls: (method: string) => rpc.mock.calls.filter(([name]) => name === method).length }
}

const shown = (root: ParentNode, selector: string) => [...root.querySelectorAll<HTMLElement>(selector)].filter(node => !node.closest('[hidden]'))
const header = (element: HTMLElement) => element.querySelector<HTMLElement>('.mobile-header')!
const strip = (element: HTMLElement) => element.querySelector<HTMLElement>('.mobile-mote-context')!
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
async function find<T extends HTMLElement>(subject: string, lookup: () => T | null | undefined): Promise<T> {
  let found: T | null | undefined
  await vi.waitFor(async () => { await settle(); found = lookup(); expect(found, subject).toBeTruthy() }, { timeout: 8000, interval: 10 })
  return found!
}
const openRow = async (element: HTMLElement, scope: string, name: string) =>
  click(await find(`${name} in ${scope}`, () => shown(element, `${scope} .mobile-agent-row__open`).find(row => row.textContent?.includes(name))))

/** A root page carries the five-entry bar with Mote centred under one header; a work page carries back instead. */
function expectRoot(element: HTMLElement, page: string) {
  const bar = element.querySelector('.mobile-navigation-bar')
  expect(bar, `${page} keeps the tab bar`).not.toBeNull()
  const entries = [...bar!.querySelectorAll('.mobile-navigation button')].map(entry => entry.getAttribute('aria-label'))
  expect(entries, `${page} keeps the five entries in order`).toEqual(order)
  expect(entries.indexOf('Mote'), `${page} centres Mote`).toBe(2)
  expect(shown(element, '.mobile-header, .mobile-page-header'), `${page} has one header`).toHaveLength(1)
}
function expectWork(element: HTMLElement, page: string, back?: string) {
  expect(element.querySelector('.mobile-navigation-bar'), `${page} has no tab bar`).toBeNull()
  expect(element.querySelector('.mobile-navigation'), `${page} has no tab entries`).toBeNull()
  const headers = shown(element, '.mobile-header, .mobile-page-header')
  expect(headers.map(node => node.className), `${page} has only the conversation header`).toEqual([expect.stringContaining('mobile-header--session')])
  const origin = headers[0]!.querySelector('[data-mobile-back]')
  expect(origin, `${page} leads back through its header`).not.toBeNull()
  if (back) expect(origin!.getAttribute('aria-label'), `${page} names where back leads`).toBe(back)
}

beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  document.head.querySelectorAll('style[data-mobile-chrome]').forEach(node => node.remove())
  delete document.documentElement.dataset.browserKeyboard
  document.body.replaceChildren(); vi.restoreAllMocks()
})

describe('actual phone chrome around work', () => {
  it('opens the new narrow Goal via conversation actions and returns to the original Composer and More focus without input or recovery', async () => {
    const viewport = (window as unknown as { happyDOM: { setWindowSize(size: { width: number; height: number }): void } }).happyDOM
    const originalSize = { width: window.innerWidth, height: window.innerHeight }
    viewport.setWindowSize({ width: 320, height: 720 })
    try {
      const chromePath = '../src/conversation/chrome.css'
      const style = Object.assign(document.createElement('style'), { textContent: readFileSync(new URL(chromePath, import.meta.url), 'utf8') })
      style.dataset.mobileChrome = ''; document.head.append(style)
      expect(window.matchMedia('(max-width: 359px)').matches).toBe(true)
      const f = originalClient(), recover = vi.fn()
      Object.assign(f.client, { ensureAgentContinuity: recover })
      const view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} />)
      await openPrimary(view.element, 'Focus')
      await openRow(view.element, '.mobile-focus-project', 'Original Agent')
      expectWork(view.element, 'original narrow conversation', '返回 Focus')
      const surface = view.element.querySelector('.mobile-conversation-slot')!.firstElementChild
      const originalEditor = editor(view.element), originalRunId = f.client.agentSession('session-original').run.runId
      await paste(view.element, '窄屏目标菜单往返保留的原草稿')
      const fixedGoal = await find('the mounted Goal shortcut', () => header(view.element).querySelector<HTMLElement>('.mobile-conversation__goal'))
      expect(getComputedStyle(fixedGoal).display, 'the shipped narrow media rule leaves Goal in the More panel').toBe('none')
      const more = button(header(view.element), '当前对话操作')
      more.focus(); await click(more)
      const sheet = await waitForElement<HTMLElement>(document.body, '.mobile-sheet--agent')
      const entry = sheet.querySelector<HTMLButtonElement>('.mobile-goal-menu-entry[aria-label="目标与结果"]')
      expect(entry, 'the narrow conversation actions keep the Goal entry reachable').not.toBeNull()
      await click(entry!)
      await waitForElement(view.element, '.mobile-goal-panel:not([hidden]) .mobile-goal-work')
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expectWork(view.element, 'narrow Goal work', '返回对话')
      expect(f.rpc.mock.calls.some(([method, params]) => method === 'goal.ls' && params.agentSessionId === 'session-original')).toBe(true)
      expect(view.element.querySelector('.mobile-conversation-slot')!.firstElementChild).toBe(surface)
      expect(view.element.querySelector('.mobile-conversation')?.getAttribute('data-agent-session-id')).toBe('session-original')
      const back = button(header(view.element), '返回对话')
      back.focus(); await click(back)
      await find('the retained conversation after Goal work', () => shown(view.element, '.mobile-conversation-panel .mobile-conversation')[0])
      expectWork(view.element, 'returned narrow conversation', '返回 Focus')
      expect(view.element.querySelector('.mobile-conversation-slot')!.firstElementChild).toBe(surface)
      expect(editor(view.element)).toBe(originalEditor)
      expect(originalEditor.textContent).toBe('窄屏目标菜单往返保留的原草稿')
      expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('session-original')
      expect(f.client.agentSession('session-original').run.runId).toBe(originalRunId)
      await vi.waitFor(() => expect(document.activeElement, 'Goal return restores the visible original More trigger').toBe(more))
      expect(f.submit).not.toHaveBeenCalled(); expect(f.respond).not.toHaveBeenCalled()
      expect(f.rejoinInput).not.toHaveBeenCalled(); expect(f.signalAgent).not.toHaveBeenCalled()
      expect(recover).not.toHaveBeenCalled(); expect(f.calls('goal.discuss')).toBe(0)
    } finally { await act(async () => { viewport.setWindowSize(originalSize) }) }
  }, 30000)

  it('opens the original new Goal form from the header and keeps project selection there', async () => {
    const f = originalClient(), view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} />)
    await openPrimary(view.element, 'Goals')
    const page = await waitForElement(view.element, '.mobile-goals')
    const trigger = page.querySelector<HTMLElement>('.mobile-page-header [aria-label="新建目标"]')
    expect(trigger, 'new Goal action belongs in the header').not.toBeNull()
    expect(page.querySelector('.mobile-goal-create__form')?.hasAttribute('hidden')).toBe(true)
    await click(trigger!)
    expect(page.querySelector('.mobile-goal-create__form')?.hasAttribute('hidden')).toBe(false)
    expect(page.querySelector('[aria-label="新目标项目"]')?.closest('[hidden]')).toBeNull()
    expect(page.querySelector('.mobile-goal-lookup')?.closest('.mobile-page-header')).not.toBeNull()
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('shows the tab bar on the five directories, the Mote main and Threads, and on no conversation, terminal or Goal work', async () => {
    const f = originalClient(), view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} />)
    // Startup opens the primary Mote's saved main, which is itself a root page.
    await waitForElement(view.element, '.mobile-mote-context[data-variant="main"]')
    expectRoot(view.element, 'Mote main')
    await click(button(strip(view.element), 'Threads'))
    expectRoot(view.element, 'Mote Threads')
    await click(button(strip(view.element), 'Discussion'))
    await click(button(header(view.element), '返回 Mote'))
    expectRoot(view.element, 'Mote directory')
    for (const label of ['Goals', 'Topics', 'Focus', 'Space']) { await openPrimary(view.element, label); expectRoot(view.element, `${label} directory`) }

    await openPrimary(view.element, 'Focus')
    await openRow(view.element, '.mobile-focus-project', 'Original Agent')
    expectWork(view.element, 'Agent conversation from Focus', '返回 Focus')
    await click(button(header(view.element), '查看终端'))
    expect(view.element.querySelector('[data-terminal-session]')?.closest('[hidden]')).toBeNull()
    expectWork(view.element, 'terminal')
    await click(button(header(view.element), '查看对话'))
    await click(button(view.element.querySelector<HTMLElement>('.mobile-conversation__floating-tools')!, '目标与结果'))
    expect(view.element.querySelector('.mobile-goal-panel')?.hasAttribute('hidden')).toBe(false)
    expectWork(view.element, 'Goal work')

    await openPrimary(view.element, 'Space')
    await click(await find('Original Project Space row', () => shown(view.element, '.mobile-spatial-panel button').find(row => row.querySelector('strong')?.textContent === 'Original Project Space')))
    await openRow(view.element, '.mobile-spatial-panel', 'Project Agent')
    expectWork(view.element, 'Agent conversation from Space', '返回 Space')

    await openPrimary(view.element, 'Topics')
    await click(await find('Topic category', () => shown(view.element, '.mobile-topics button').find(row => row.textContent?.includes('工作分类'))))
    await click(await find('Topic', () => shown(view.element, '.mobile-topics button').find(row => row.textContent?.includes('讨论甲'))))
    await openRow(view.element, '.mobile-zone-workface', 'Project Agent')
    expectWork(view.element, 'Agent conversation from Topics', '返回 Topics')

    await openPrimary(view.element, 'Goals')
    await click(await waitForElement(view.element, '.mobile-goals-list button'))
    await click(button(view.element, '打开目标讨论'))
    expectWork(view.element, 'Agent conversation from Goals', '返回 Goals')

    await openPrimary(view.element, 'Mote')
    await click(button(header(view.element), '返回 Mote'))
    await openRow(view.element, '.mobile-mote-agents', 'Member Agent')
    await waitForElement(view.element, '.mobile-mote-context[data-variant="member"]')
    expectWork(view.element, 'Mote member conversation')
    expect(f.submit).not.toHaveBeenCalled()
  }, 30000)

  it('names a Mote member once, keeps role, team and main in the strip, and keeps the main source entry with its recovery actions', async () => {
    const f = originalClient(); f.state.dialogueFails = true
    const view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} />)
    const main = await waitForElement(view.element, '.mobile-mote-context[data-variant="main"]')
    const status = await find('main source entry in the strip', () => main.querySelector<HTMLElement>('.mobile-mote-source-status'))
    expect(status.querySelector('summary')?.getAttribute('aria-label')).toMatch(/^主对话信息待核对 · \d+ 项$/)
    await click(status.querySelector('summary')!)
    expect(status.hasAttribute('open')).toBe(true)
    expect(status.textContent).toContain('原主对话读取失败')
    expect(button(status, '返回当前主对话')).toBeDefined()
    const reads = f.calls('space.mote.dialogue.read')
    f.state.dialogueFails = false
    await click(button(status, '重新核对'))
    await vi.waitFor(() => expect(f.calls('space.mote.dialogue.read')).toBeGreaterThan(reads))
    await find('confirmed main without the entry', () => main.querySelector('.mobile-mote-source-status') ? null : main)

    await click(button(header(view.element), '返回 Mote'))
    await openRow(view.element, '.mobile-mote-agents', 'Member Agent')
    const member = await waitForElement(view.element, '.mobile-mote-context[data-variant="member"]')
    expect(shown(view.element, '.mobile-header, .mobile-page-header')).toHaveLength(1)
    expect(view.element.querySelector('.mobile-mote-team-summary')).toBeNull()
    expect(header(view.element).querySelector('.mobile-session-title')?.textContent).toBe('Member Agent')
    // Everything above the conversation names the member exactly once: the header owns the name.
    const chrome = [...view.element.querySelector('.mobile-app')!.children].filter(node => !node.matches('.mobile-main, .mobile-navigation-bar') && !node.closest('[hidden]'))
    expect(chrome.map(node => node.textContent ?? '').join('').split('Member Agent')).toHaveLength(2)
    expect(member.querySelector('.mobile-mote-context__role')?.textContent).toBe('成员')
    expect(button(member, '查看本 Mote 团队')).toBeDefined()
    await click(button(member, '回主对话'))
    await waitForElement(view.element, '.mobile-mote-context[data-variant="main"]')
    expect(getDeviceWorkface().snapshot().record.selectedSessionId).toBe('session-original')
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('writes the header status word only from the open conversation surface and stays silent while that fact is unconfirmed', async () => {
    const f = originalClient(), original = f.client.agentSession('session-original')
    original.semanticStatus = { state: 'working', source: 'native-hook', observedAt: Date.now() }
    f.client.statusAgent = vi.fn(async (id: string) => { if (id !== 'session-original') throw new Error('原状态暂不可读'); return activityStatus(original) }) as any
    const view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} />)
    const word = await find('status word in the header', () => header(view.element).querySelector<HTMLElement>('.mobile-session-status .mobile-active-state'))
    expect(word.textContent).toBe('正在执行')
    await click(button(header(view.element), '返回 Mote'))
    await openRow(view.element, '.mobile-mote-agents', 'Member Agent')
    await waitForElement(view.element, '.mobile-mote-context[data-variant="member"]')
    await vi.waitFor(() => expect(f.client.statusAgent).toHaveBeenCalledWith('other'))
    await settle()
    // The directory presents this member as working; its own surface has not confirmed that, so the header says nothing.
    expect(header(view.element).querySelector('.mobile-session-status')?.textContent).toBe('')
    expect(header(view.element).textContent).not.toMatch(/正在执行|执行中|Working/)
  })

  it('carries needs-you on back inside a conversation and hands the same count, or its unknown, back to the Focus tab', async () => {
    const f = originalClient(), view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} />)
    const focusBadge = () => view.element.querySelector('.mobile-navigation-bar [data-workface="focus"] .mobile-tab-badge')?.textContent
    const backBadge = () => header(view.element).querySelector('[data-mobile-back] .mobile-back-badge')
    await openPrimary(view.element, 'Focus')
    await vi.waitFor(() => expect(focusBadge()).toBe('1'))
    await openRow(view.element, '.mobile-focus-project', 'Original Agent')
    expect(backBadge()?.textContent).toBe('1')
    expect(header(view.element).querySelector('[data-mobile-back]')?.getAttribute('aria-description')).toBe('另有 1 个需要你')
    await click(button(header(view.element), '返回 Focus'))
    expect(focusBadge()).toBe('1')
    // The one waiting Agent is the conversation in front of the person, so back carries nothing.
    await openRow(view.element, '.mobile-focus-project', 'Project Agent')
    expect(backBadge()).toBeNull()
    await click(button(header(view.element), '返回 Focus'))

    f.state.rootFails = true
    await click(button(shown(view.element, '.mobile-spatial-panel')[0]!, '刷新空间目录'))
    await vi.waitFor(() => expect(focusBadge()).toBe('?'))
    await openRow(view.element, '.mobile-focus-project', 'Original Agent')
    await vi.waitFor(() => expect(backBadge()?.textContent).toBe('?'))
    expect(backBadge()?.hasAttribute('data-unconfirmed')).toBe(true)
    await click(button(header(view.element), '返回 Focus'))
    expect(focusBadge()).toBe('?')
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('returns between Focus and the open conversation three times without new reads, a rebuilt conversation or a lost draft', async () => {
    const f = originalClient(), view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} />)
    await openPrimary(view.element, 'Focus')
    await openRow(view.element, '.mobile-focus-project', 'Original Agent')
    const surface = view.element.querySelector('.mobile-conversation-slot')!.firstElementChild, originalEditor = editor(view.element)
    await paste(view.element, '往返之间保留的原草稿')
    await settle()
    const cost = () => ({ catalog: f.calls('space.ls'), subscriptions: vi.mocked(f.client.observeSessionHistory).mock.calls.length,
      releases: f.disposeHistory.mock.calls.length, history: f.readHistory.mock.calls.length, timeline: f.readTimeline.mock.calls.length })
    const trips: Array<ReturnType<typeof cost>> = []
    for (let trip = 1; trip <= 3; trip++) {
      const start = cost()
      await click(button(header(view.element), '返回 Focus'))
      expectRoot(view.element, `Focus after return ${trip}`)
      await openRow(view.element, '.mobile-focus-project', 'Original Agent')
      expectWork(view.element, `conversation after return ${trip}`, '返回 Focus')
      await settle()
      const end = cost()
      trips.push(Object.fromEntries(Object.entries(end).map(([key, value]) => [key, value - start[key as keyof typeof start]])) as ReturnType<typeof cost>)
      expect(view.element.querySelector('.mobile-conversation-slot')!.firstElementChild, `conversation instance after return ${trip}`).toBe(surface)
    }
    // A hidden conversation releases its live reading and resumes it once when shown again.
    expect(trips[0]).toMatchObject({ subscriptions: 1, releases: 1, history: 1, timeline: 1 })
    // Catalog budget per trip: the shown Focus directory, the resumed attention reader, and the Mote team and header identity.
    expect(trips[0]!.catalog).toBeLessThanOrEqual(4)
    expect(trips[1], 'the second trip costs what the first did').toEqual(trips[0])
    expect(trips[2], 'the third trip costs what the first did').toEqual(trips[0])
    expect(editor(view.element)).toBe(originalEditor)
    expect(originalEditor.textContent).toBe('往返之间保留的原草稿')
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('animates only a returning tab bar, through a motion attribute that reduced motion and the soft keyboard override', async () => {
    const css = ['../src/mobile.css', '../src/navigation/shell.css', '../src/conversation/chrome.css'].map(path => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n')
    const style = Object.assign(document.createElement('style'), { textContent: css }); style.dataset.mobileChrome = ''
    document.head.append(style)
    const f = originalClient(), view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} />)
    const bar = () => view.element.querySelector<HTMLElement>('.mobile-navigation-bar')!
    await waitForElement(view.element, '.mobile-mote-context[data-variant="main"]')
    expect(bar().hasAttribute('data-motion'), 'the first root page appears in place').toBe(false)
    await openPrimary(view.element, 'Focus')
    expect(bar().hasAttribute('data-motion'), 'switching between root pages keeps the bar still').toBe(false)
    await openRow(view.element, '.mobile-focus-project', 'Original Agent')
    await click(button(header(view.element), '返回 Focus'))
    expect(bar().getAttribute('data-motion')).toBe('enter')
    // The DOM engine keeps the cascaded shorthand rather than its longhands.
    expect(getComputedStyle(bar()).animation).toMatch(/^mobile-bar-enter\b/)
    const device = (window as unknown as { happyDOM: { settings: { device: { prefersReducedMotion: string } } } }).happyDOM.settings.device
    device.prefersReducedMotion = 'reduce'
    try {
      style.textContent = css
      expect(getComputedStyle(bar()).animation, 'reduced motion stills the returning bar').toBe('none')
    } finally { device.prefersReducedMotion = 'no-preference'; style.textContent = css }
    // This DOM engine weighs only the last compound of a selector, so the keyboard cascade itself is measured in Chromium by the mature-shell capture.
    const keyboard = [...style.sheet!.cssRules].filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && rule.style.display === 'none')
      .flatMap(rule => rule.selectorText.split(',').map(selector => selector.trim())).filter(selector => /^\[data-(mobile|browser)-keyboard='shown'\] /.test(selector))
    document.documentElement.dataset.browserKeyboard = 'shown'
    expect(keyboard.filter(selector => bar().matches(selector)), 'the shipped soft-keyboard rule still folds this bar away').toEqual(["[data-browser-keyboard='shown'] .mobile-navigation-bar"])
  })

  it('leads the drawer with the Mac connection card, one tap from connection and devices, keeping Survey, the default directory and diagnostics', async () => {
    const f = originalClient(), view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} />)
    await openPrimary(view.element, 'Focus')
    await openAppMenu(view.element)
    const drawer = await find('the drawer', () => document.querySelector<HTMLElement>('.mobile-drawer'))
    const groups = [...drawer.children].filter(node => !node.matches('.mobile-sheet-handle, .mobile-sheet-title, #mobile-sheet-description'))
    const card = groups[0] as HTMLElement | undefined
    expect(card?.matches('button.mobile-drawer-connection'), 'the connection card is the first group').toBe(true)
    expect(card!.getAttribute('data-connection')).toBe('connected')
    expect(card!.querySelector('.mobile-status-dot'), 'the card carries the status dot').not.toBeNull()
    expect(card!.querySelector('img.brand-icon'), 'the card carries the brand').not.toBeNull()
    expect(card!.querySelector('.mobile-drawer-connection__address')?.textContent).toBe(location.host || 'Mac 地址未记录')
    expect(card!.querySelector('.mobile-drawer-connection__state')?.textContent).toBe('已连接')
    expect(drawer.querySelectorAll('.mobile-drawer-connection, .mobile-menu-row[aria-label^="连接与设备"]'), 'the connection fact has one entry in the drawer').toHaveLength(1)
    expect(button(drawer, 'Survey研究与笔记')).toBeDefined()
    expect(drawer.querySelector('select[aria-label="退出对话后的默认目录"]')).not.toBeNull()
    expect(button(drawer, '提醒与诊断')).toBeDefined()
    await click(card!)
    const sheet = await find('connection and devices', () => document.querySelector<HTMLElement>('.mobile-sheet'))
    expect(sheet.querySelector('h2')?.textContent).toBe('连接与设备')
    expect(sheet.textContent).toContain('Agent 与会话由 Mac 管理')
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('keeps the terminal under its one header without the Mote context strip, for the Mote main and a member alike', async () => {
    const f = originalClient(), view = await mount(<MobileApp client={f.client} connection={connected} platform={createBrowserPlatform()} />)
    // Everything above the work area, other than the work area itself and the bounded notices.
    const chromeRows = () => [...view.element.querySelector('.mobile-app')!.children].filter(node => !node.matches('.mobile-main, .mobile-notice-stack') && !node.closest('[hidden]'))
    for (const variant of ['main', 'member'] as const) {
      if (variant === 'member') {
        await click(button(header(view.element), '返回 Mote'))
        await openRow(view.element, '.mobile-mote-agents', 'Member Agent')
      }
      await waitForElement(view.element, `.mobile-mote-context[data-variant="${variant}"]`)
      await click(button(header(view.element), '查看终端'))
      const terminal = await find(`${variant} terminal`, () => shown(view.element, '.mobile-terminal-panel [data-terminal-session]')[0])
      expect(terminal.dataset.terminalSession).toBe(variant === 'main' ? 'session-original' : 'other')
      expectWork(view.element, `${variant} terminal`, '返回对话')
      expect(view.element.querySelector('.mobile-mote-context'), `${variant} terminal has no context strip`).toBeNull()
      expect(chromeRows().map(node => node.className), `${variant} terminal has only its header above the output`).toEqual([expect.stringContaining('mobile-header--session')])
      await click(button(header(view.element), '查看对话'))
      await waitForElement(view.element, `.mobile-mote-context[data-variant="${variant}"]`)
    }
    expect(f.submit).not.toHaveBeenCalled()
  })

  it('shows connecting, disconnected and unpaired progress from the typed connection state, with the details entry in each', async () => {
    const overlay = document.createElement('div'); document.body.append(overlay)
    const platform = createBrowserPlatform({ overlayContainer: () => overlay })
    // Each message claims a different progress than its typed state; only the state and pairing fact may decide.
    const cases = [
      [{ state: 'connecting', message: '已连接 Mac', paired: true }, 'connecting', '正在连接 Mac', ['done', 'done', 'current']],
      [{ state: 'disconnected', message: '正在连接 Mac', paired: true }, 'disconnected', '连接中断', ['done', 'done', 'attention']],
      [{ state: 'unavailable', message: '连接中断，正在自动重连。', paired: false }, 'unpaired', '连接你的 Mac', ['current', 'pending', 'pending']],
      [{ state: 'unavailable', message: '请在 Mac 的手机连接中复制链接，在这台设备打开。' }, 'unavailable', '连接需要处理', ['unknown', 'unknown', 'attention']]
    ] as const
    const view = await mount(<MobileApp client={null} connection={cases[0][0]} platform={platform} />)
    for (const [connection, state, title, steps] of cases) {
      await view.render(<MobileApp client={null} connection={connection} platform={platform} />)
      const page = view.element.querySelector<HTMLElement>('.mobile-connect-page')!
      expect(page.dataset.connectState, connection.message).toBe(state)
      expect(page.querySelector('h1')?.textContent).toBe(title)
      const items = [...page.querySelectorAll<HTMLElement>('.mobile-connect-steps > li')]
      expect(items.map(item => item.dataset.stepState), `${state} progress`).toEqual(steps)
      expect(items.filter(item => item.getAttribute('aria-current') === 'step')).toHaveLength(1)
      expect(page.querySelector('img.brand-icon')).not.toBeNull()
      expect(button(page, '连接详情')).toBeDefined()
    }
    await click(button(view.element, '连接详情'))
    expect(overlay.querySelector('[role="dialog"] h2')?.textContent).toBe('连接你的 Mac')
    expect(view.element.querySelector('.mobile-navigation-bar')).toBeNull()
  })
})
