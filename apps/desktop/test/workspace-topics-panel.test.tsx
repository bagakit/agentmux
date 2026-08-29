// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// api 在模块加载时就判断跑在哪个宿主里；不先立起这个全局，import 阶段就炸。
vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { SessionSnapshot, ScratchTopicSnapshot, WorkspaceRecord } from '../src/shared/contracts.js'
import { createWorkspaceLayout, splitWorkbenchRegion } from '@agentmux/layout'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics.js'

type AgentSessionSnapshot = Extract<SessionSnapshot, { kind: 'agent' }>

const fixture = vi.hoisted(() => ({
  snapshot: [] as ScratchTopicSnapshot[],
  state: {
    layouts: {} as Record<string, unknown>,
    tabs: {} as Record<string, unknown>,
    workspaceFileRevisions: {} as Record<string, number>,
    sessions: [] as unknown[],
    // 这两片是显示名链的高档输入。手搭的 store 替身必须覆盖组件真读的**每一个** slice：少一个，
    // 组件里的 `agentNames[id]` 会在 undefined 上取下标抛 TypeError，而栈指向生产文件，看起来像
    // 组件回归（记忆 hand-rolled-store-fake-must-cover-every-slice）。
    agentNames: {} as Record<string, string>,
    timelines: {} as Record<string, unknown>,
    scratchTopicOrder: [] as string[],
    pinnedItems: {} as Record<string, string[]>,
    createScratchTopic: vi.fn(),
    openScratchTopic: vi.fn(),
    renameScratchTopic: vi.fn(),
    setScratchTopicOrder: vi.fn(),
    selectSession: vi.fn(),
    reportError: vi.fn(),
    togglePinnedItem: vi.fn()
  }
}))

// 组件靠 useEffect 调 api.scratch.listTopics 取数——renderToStaticMarkup 不跑 effect，所以这一族走
// happy-dom 真渲染。listTopics 成为可控输入。
vi.mock('../src/renderer/src/lib/api.js', () => ({
  api: {
    scratch: {
      listTopics: vi.fn(async () => fixture.snapshot)
    }
  }
}))

vi.mock('../src/renderer/src/store.js', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
    { getState: () => fixture.state }
  )
}))

import { WorkspaceTopicsPanel } from '../src/renderer/src/components/WorkspaceTopicsPanel.js'

const workspace: WorkspaceRecord = {
  id: SCRATCH_WORKSPACE_ID,
  name: 'Scratch',
  hostId: 'local',
  path: '/scratch',
  kind: 'folder'
}

/** id 用真 Scratch Topic 形状（`<kind>:<slug>`），directoryPath 与之派生，保证 topicsWithAgents 认得。 */
function topic(id: string, title: string): ScratchTopicSnapshot {
  const dir = `/scratch/topic--${id.replace(':', '--')}`
  return { id, directoryPath: dir, topicPath: `${dir}/topic.md`, title, summary: '', collaborators: [] }
}

let container: HTMLDivElement
let root: Root

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(WorkspaceTopicsPanel, { workspace, onRevealDirectory: vi.fn() }))
  })
  // effect 里的 listTopics().then(setTopics) 是个微任务链，冲一次事件循环让它落地再断言。
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

function rows(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.workspace-topic-item')]
}

function titlesInOrder(): string[] {
  return rows().map((row) => row.querySelector('.selector-row__identity strong')?.textContent ?? '')
}

function rowByTitle(title: string): HTMLElement {
  const row = rows().find((one) => one.querySelector('.selector-row__identity strong')?.textContent === title)
  expect(row, `没渲染出 Topic「${title}」——判据落空，后面的断言会恒真`).not.toBeUndefined()
  return row!
}

function isPinnedAtRest(title: string): boolean {
  // 静息态标记：没有任何 hover / focus，标记就该在 DOM 里。
  return rowByTitle(title).querySelector('.workspace-topic-entry__pin') !== null
}

/** 对某行开右键菜单，返回菜单里那些 role=menuitem 的元素（Radix 把内容 portal 到 body）。 */
async function openContextMenu(title: string): Promise<HTMLElement[]> {
  const row = rowByTitle(title)
  await act(async () => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }))
  })
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.replaceChildren()
  fixture.snapshot = []
  fixture.state.scratchTopicOrder = []
  fixture.state.pinnedItems = {}
  fixture.state.sessions = []
  fixture.state.tabs = {}
  fixture.state.layouts = {}
  // 显示名链的两个高档输入也要复位，否则一条测试的改名/首条 prompt 会漏进下一条，
  // 把恒真断言伪装成通过（记忆 weak-assertion-patterns）。
  fixture.state.agentNames = {}
  fixture.state.timelines = {}
  fixture.state.selectSession.mockReset()
  fixture.state.openScratchTopic.mockReset()
  fixture.state.togglePinnedItem.mockReset()
})

describe('Topic live Agent presence', () => {
  it('does not open a Topic while Enter confirms IME composition', async () => {
    fixture.snapshot = [topic('view:ime', 'IME Topic')]
    await mount()
    const row = rowByTitle('IME Topic').querySelector<HTMLElement>('.workspace-topic-entry')!
    expect(row).not.toBeNull()
    await act(async () => row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })))
    expect(fixture.state.openScratchTopic).not.toHaveBeenCalled()
    await act(async () => row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(fixture.state.openScratchTopic).toHaveBeenCalledWith('view:ime', SCRATCH_WORKSPACE_ID)
  })

  it('opens a Topic from the row click and targets Scratch explicitly', async () => {
    fixture.snapshot = [topic('view:click', 'Clickable Topic')]
    await mount()
    const row = rowByTitle('Clickable Topic').querySelector<HTMLElement>('.workspace-topic-entry')!

    await act(async () => row.click())

    expect(fixture.state.openScratchTopic).toHaveBeenCalledWith('view:click', SCRATCH_WORKSPACE_ID)
  })

  it('renders only live Agents in layout tab order and opens the selected Session', async () => {
    const shared = topic('view:shared', 'Shared Topic')
    shared.collaborators = [
      { fileName: 'codex.offline.identity.md', sessionId: 'offline', providerId: 'codex' }
    ]
    fixture.snapshot = [shared]
    const sessions: AgentSessionSnapshot[] = ['alpha', 'beta'].map((id) => ({
      id, kind: 'agent', providerId: 'codex', executorId: 'codex',
      capabilities: {
        terminal: true, timeline: 'complete-events', permission: 'observe',
        providerResume: true, replyCorrelation: 'none'
      },
      hostId: 'local', workspacePath: shared.directoryPath, label: id,
      createdAt: 1, updatedAt: 1, processState: 'running', latestOutputBytes: 0,
      status: { state: 'working', source: 'run-process', observedAt: 1 },
      control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
    }))
    fixture.state.sessions = sessions
    fixture.state.tabs = Object.fromEntries(sessions.map(({ id }) => {
      const tabId = `tab-${id}`
      return [tabId, createWorkbenchTab(tabId, {
        regionId: `region-${id}`, kind: 'agent', phase: 'attached',
        workspaceId: workspace.id, sessionId: id
      })]
    }))
    // Input order deliberately opposes the user's tab order. Removing the sort must fail.
    fixture.state.layouts = { [workspace.id]: createWorkspaceLayout('main', ['tab-beta', 'tab-alpha']) }

    await mount()

    const avatars = [...rowByTitle('Shared Topic').querySelectorAll<HTMLButtonElement>('.agent-avatar')]
    // Exact nonempty roster also rejects "render nothing" and the durable offline collaborator.
    expect(avatars.map((avatar) => avatar.getAttribute('aria-label'))).toEqual(['beta · working', 'alpha · working'])
    await act(async () => avatars[0]!.click())
    expect(fixture.state.selectSession).toHaveBeenCalledWith('beta')
  })
  it('puts active avatars inside their own Region, retains background/unknown, and omits ended Agents', async () => {
    const shared = topic('view:shared', 'Shared Topic')
    fixture.snapshot = [shared]
    const sessions = ['left', 'right', 'background', 'unknown', 'ended', 'interrupted'].map((id) => ({
      id, kind: 'agent', providerId: 'codex', executorId: 'codex',
      hostId: 'local', workspacePath: shared.directoryPath, label: id,
      createdAt: 1, updatedAt: 1,
      processState: id === 'ended' ? 'exited' : id === 'interrupted' ? 'interrupted' : 'running',
      status: { state: id === 'unknown' ? 'disconnected' : 'working', source: 'run-process', observedAt: 1 }
    }))
    fixture.state.sessions = sessions
    const tab = createWorkbenchTab('split', {
      regionId: 'left-cell', kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: 'left'
    })
    tab.topicId = shared.id
    tab.layout = splitWorkbenchRegion(tab.layout, 'left-cell', 'right', 'right-cell')
    tab.regions['right-cell'] = { regionId: 'right-cell', kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: 'right' }
    fixture.state.tabs = { split: tab }
    fixture.state.layouts = { [workspace.id]: createWorkspaceLayout('main', ['split']) }
    await mount()
    const row = rowByTitle('Shared Topic')
    const cells = [...row.querySelectorAll<HTMLElement>('.topic-workbench-topology__tab-glyph__cell')]
    expect(cells).toHaveLength(2)
    expect(cells.map((cell) => cell.dataset.regionKind)).toEqual(['agent', 'agent'])
    const avatars = [...row.querySelectorAll<HTMLButtonElement>('.agent-avatar')]
    expect(avatars.map((avatar) => avatar.getAttribute('aria-label')))
      .toEqual(['background · working', 'unknown · disconnected'])
    const tabButton = row.querySelector<HTMLButtonElement>('[data-topic-tab-id="split"]')!
    await act(async () => tabButton.click())
    expect(fixture.state.openScratchTopic).not.toHaveBeenCalled()
    // Serializing and reloading the durable layout retains the same geometry/identity projection.
    fixture.state.tabs = JSON.parse(JSON.stringify(fixture.state.tabs))
    fixture.state.layouts = JSON.parse(JSON.stringify(fixture.state.layouts))
    await mount()
    expect([...rowByTitle('Shared Topic').querySelectorAll('.agent-avatar')].map((avatar) => avatar.getAttribute('aria-label')))
      .toEqual(['left · working', 'right · working', 'background · working', 'unknown · disconnected'])
  })

})

/**
 * Topic pin。三处各自能静默烂掉，一条判据钉一处：
 *
 *   1. **组合而非排序**：pin 是一次分区，坐在 orderTopics 的拖拽序之上。fixture 故意排成非字典序
 *      （c, a, b），这样把 partitionPinned 换成一个 `.sort()` 会立刻显形——已排序的 fixture 抓不到。
 *   2. **scope 派生**：Topic 的 scope 是 SCRATCH_WORKSPACE_ID。把它换成别的 key（或让 pin 走全局）
 *      读到的就是错误的桶。用「pin 挂在别的 scope 下时这一行绝不显示已 pin」把这条钉死。
 *   3. **静息态可见 + 只留一个常驻动作**：已 pin 在不 hover 时就看得出来，而它是个 svg 标记不是第二枚
 *      常驻图标按钮（那会跟标题抢宽度，也会撞 surface-tool-dock 那条「行上只留一个常驻动作」）。
 */
describe('Topics 面板的 pin', () => {
  it('pin 是坐在拖拽序之上的分区，不是重新排序', async () => {
    // fixture 故意非字典序：c, a, b。orderTopics 在无用户序时原样返回它，partitionPinned 只把 b 提前。
    fixture.snapshot = [topic('view:c', 'Topic C'), topic('view:a', 'Topic A'), topic('view:b', 'Topic B')]
    fixture.state.pinnedItems = { [SCRATCH_WORKSPACE_ID]: ['view:b'] }
    await mount()

    expect(titlesInOrder().length, '三行都没渲染出来，下面的顺序断言会恒真').toBe(3)
    // pin 的 b 提到最前；未 pin 的两行保留拖拽序（c 在 a 前）——绝不是被排成字典序 a,b,c。
    // 把 partitionPinned 换成 `.sort()` 会得到 A,B,C，这条即红。
    expect(titlesInOrder()).toEqual(['Topic B', 'Topic C', 'Topic A'])
  })

  it('分区坐在用户拖拽序之上：未 pin 段按拖拽序，pin 段被提前', async () => {
    // 模拟用户把 a 拖到最前（scratchTopicOrder），磁盘序仍是 c,a,b。orderTopics → a,c,b；pin b → b,a,c。
    fixture.snapshot = [topic('view:c', 'Topic C'), topic('view:a', 'Topic A'), topic('view:b', 'Topic B')]
    fixture.state.scratchTopicOrder = ['view:a', 'view:c', 'view:b']
    fixture.state.pinnedItems = { [SCRATCH_WORKSPACE_ID]: ['view:b'] }
    await mount()

    // b 被提前，a、c 之间仍是用户拖出来的 a 在 c 前——拖一个未 pin 的行不会「跳到 pin 上面去」。
    expect(titlesInOrder()).toEqual(['Topic B', 'Topic A', 'Topic C'])
  })

  it('pin 的 scope 是 SCRATCH_WORKSPACE_ID：挂在这个 scope 下才算已 pin', async () => {
    fixture.snapshot = [topic('view:a', 'Topic A'), topic('view:b', 'Topic B')]
    fixture.state.pinnedItems = { [SCRATCH_WORKSPACE_ID]: ['view:b'] }
    await mount()

    expect(isPinnedAtRest('Topic B'), 'Scratch scope 下 pin 的 Topic 没显示已 pin').toBe(true)
    expect(isPinnedAtRest('Topic A'), '没 pin 的 Topic 却显示已 pin').toBe(false)
  })

  it('pin 严格按 scope 读：挂在别的 scope 下不会串到 Topic 上', async () => {
    // 同一个 id 挂在一个**不是** SCRATCH_WORKSPACE_ID 的桶里。若读取丢了 scope（比如 pin 走全局、
    // 或把所有桶 flat 到一起），这一行就会错误地显示已 pin——这条即红。
    fixture.snapshot = [topic('view:b', 'Topic B')]
    fixture.state.pinnedItems = { 'some-other-scope': ['view:b'] }
    await mount()

    expect(isPinnedAtRest('Topic B'), 'pin 从错误的 scope 串了过来——scope 没有被真正用上').toBe(false)
  })

  it('已 pin 在静息态就看得出来，且它不是第二枚常驻图标按钮', async () => {
    fixture.snapshot = [topic('view:b', 'Topic B')]
    fixture.state.pinnedItems = { [SCRATCH_WORKSPACE_ID]: ['view:b'] }
    await mount()

    const row = rowByTitle('Topic B')
    const mark = row.querySelector('.workspace-topic-entry__pin')
    expect(mark, '已 pin 的静息态标记没渲染').not.toBeNull()
    // 标记是个 svg，不是按钮——行上仍只有一枚常驻图标按钮（Reveal-in-Files），没被挤掉也没被压住。
    expect(mark!.tagName.toLowerCase()).toBe('svg')
    expect(row.querySelectorAll('button.icon-button').length, '行上出现了不止一个常驻图标按钮').toBe(1)
    expect(row.querySelector('button.icon-button')?.className).toContain('workspace-topic-reveal')
  })

  it('右键菜单切换 pin，写回派生的 SCRATCH_WORKSPACE_ID scope', async () => {
    fixture.snapshot = [topic('view:a', 'Topic A'), topic('view:b', 'Topic B')]
    fixture.state.pinnedItems = { [SCRATCH_WORKSPACE_ID]: ['view:b'] }
    await mount()

    // 未 pin 的 a：菜单说 "Pin Topic"；点它写回带 scope 的 toggle。
    const aItems = await openContextMenu('Topic A')
    const pin = aItems.find((item) => (item.textContent ?? '').includes('Pin Topic'))
    expect(pin, '未 pin 的 Topic 右键菜单里没有 Pin Topic 项').not.toBeUndefined()
    await act(async () => pin!.click())
    // scope 必须是派生的常量：换成别的字面量、或丢掉 scope，这条即红。
    expect(fixture.state.togglePinnedItem).toHaveBeenCalledWith(SCRATCH_WORKSPACE_ID, 'view:a')

    // 已 pin 的 b：菜单说 "Unpin Topic"——状态在菜单文案上也读得出来。
    const bItems = await openContextMenu('Topic B')
    expect(bItems.some((item) => (item.textContent ?? '').includes('Unpin Topic')), '已 pin 的 Topic 菜单没给 Unpin').toBe(true)
  })

  it('每行都在 tab 序里（tabindex=0），右键菜单键盘可达', async () => {
    // Radix ContextMenu 的 Trigger 就是这一行；行在 tab 序里，Shift+F10 / 菜单键即可唤出——
    // pin/unpin 因此不因「进了右键菜单」而只剩鼠标一条路。dnd-kit 的 useSortable 给了 tabIndex=0。
    fixture.snapshot = [topic('view:a', 'Topic A')]
    await mount()
    expect(rowByTitle('Topic A').tabIndex).toBe(0)
  })
})

/**
 * 头像簇上显示的是**显示名**（经 resolveAgentName 那条唯一求值链），不是 session.label。
 * session.label 是链的最低一档（Main 建的 `executorLabel · workspaceLabel`），对「同 provider、同目录
 * 的多个 Agent」逐字相同——直接拿它当 aria-label/tooltip，两枚头像的读屏与悬浮提示就一模一样。
 *
 * 这一组把链的每一档钉在**真实渲染的 aria-label**（`AgentAvatar` 写成 `${label} · ${state}`）上。
 * 除 fallback 档外，把生产代码那行改回 `label: agent.live?.label ?? agent.sessionId` 都会让对应用例变红。
 */
describe('Topic Agent 头像用显示名链，不是 session.label', () => {
  /** 一个活着的 codex Agent session，落在给定 Topic 目录下。label 传入，作为链最低一档的 fallback。 */
  function liveCodex(id: string, label: string, topicDir: string): AgentSessionSnapshot {
    return {
      id, kind: 'agent', providerId: 'codex', executorId: 'codex',
      capabilities: {
        terminal: true, timeline: 'complete-events', permission: 'observe',
        providerResume: true, replyCorrelation: 'none'
      },
      hostId: 'local', workspacePath: topicDir, label,
      createdAt: 1, updatedAt: 1, processState: 'running', latestOutputBytes: 0,
      status: { state: 'working', source: 'run-process', observedAt: 1 },
      control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
    }
  }

  /** 一份最小 timeline：首条用户消息的 content 就是「首条 prompt」派生源（firstPromptFromTimeline 只读这个）。 */
  function timelineWithPrompt(id: string, content: string): unknown {
    return { agentSessionId: id, revision: 1, items: [{ id: `${id}-msg`, kind: 'user_message', content }] }
  }

  /** 取某 Topic 行里全部头像的 aria-label；自证查到了 `expected` 枚，避免空集合上断言恒真。 */
  function avatarLabels(title: string, expected: number): string[] {
    const avatars = [...rowByTitle(title).querySelectorAll<HTMLElement>('.agent-avatar')]
    expect(avatars.length, `Topic「${title}」渲染出的头像数不符——判据落空，下面的断言会恒真`).toBe(expected)
    return avatars.map((avatar) => avatar.getAttribute('aria-label') ?? '')
  }

  it('同 provider 同目录同兜底名的两个 Agent，改名后仍可区分（本条要解的缺陷）', async () => {
    // 真实场景：Main 用 executor+workspace 派生 label，所以同 provider + 同路径 ⇒ 两个 session.label 逐字相同。
    const shared = topic('view:pair', 'Pair Topic')
    fixture.snapshot = [shared]
    // 两个 session 的兜底 label **完全相同**——这正是缺陷复现的前提。
    fixture.state.sessions = [
      liveCodex('s1', 'Codex · scratch', shared.directoryPath),
      liveCodex('s2', 'Codex · scratch', shared.directoryPath)
    ]

    // 先证前提：不给改名时，两枚头像的 aria-label 逐字相同。这条**不是**用来抓 mutation 的
    // （mutation 下同样相同），而是证明这个 fixture 真的复现了缺陷，而非因别的原因偶然不同。
    await mount()
    const beforeRename = avatarLabels('Pair Topic', 2)
    expect(beforeRename).toEqual(['Codex · scratch · working', 'Codex · scratch · working'])

    // 各给一个用户改名（链最高档）。求值走链后，两枚头像必须**各不相同**且等于改名值。
    // 把生产那行改回 `agent.live?.label ?? agent.sessionId`，改名被丢弃，两者又相同 ⇒ 本条即红。
    fixture.state.agentNames = { s1: 'Alpha Renamed', s2: 'Beta Renamed' }
    await mount()
    const afterRename = avatarLabels('Pair Topic', 2)
    expect(afterRename).toEqual(['Alpha Renamed · working', 'Beta Renamed · working'])
    expect(afterRename[0]).not.toBe(afterRename[1])
  })

  it('链档次：用户改名压过 timeline 派生名', async () => {
    // 同一 session 既有用户改名、又有首条 prompt。改名是最高档，必须赢——自动来源绝不越过用户意图。
    // mutation 下 label 变回 session.label，既不是改名也不是派生名 ⇒ 本条即红。
    const solo = topic('view:prec', 'Precedence Topic')
    fixture.snapshot = [solo]
    fixture.state.sessions = [liveCodex('s1', 'Codex · scratch', solo.directoryPath)]
    fixture.state.agentNames = { s1: 'Chosen By User' }
    fixture.state.timelines = { s1: timelineWithPrompt('s1', 'derive me from the prompt') }
    await mount()

    expect(avatarLabels('Precedence Topic', 1)).toEqual(['Chosen By User · working'])
  })

  it('timeline 派生名一路到达头像（无改名时）', async () => {
    // 无用户改名、只有首条 prompt：应落到「派生」档。deriveNameFromPrompt 取首行、把内部空白压成单空格、
    // 限长 48。这里的 prompt 短且只有多余空格，期望值即压平后的字面（不调用被测函数算，硬写常量）。
    // mutation 下 label 变回 session.label ⇒ 拿不到派生名 ⇒ 本条即红。
    const solo = topic('view:derive', 'Derive Topic')
    fixture.snapshot = [solo]
    fixture.state.sessions = [liveCodex('s1', 'Codex · scratch', solo.directoryPath)]
    fixture.state.timelines = { s1: timelineWithPrompt('s1', 'Investigate   the   flaky   test') }
    await mount()

    expect(avatarLabels('Derive Topic', 1)).toEqual(['Investigate the flaky test · working'])
  })

  it('无改名、无 timeline 时落到兜底名 session.label（防过度纠正：链无输入时不能凭空造名）', async () => {
    // 这条守的是相反方向的 mutation——「修复」不能在链一无所有时发明一个名字。它与把生产那行改回
    // `agent.live?.label ?? agent.sessionId` **不可区分**（两者此时都产出 session.label），所以它
    // 抓不到那次 revert，也不该假装能；它抓的是「fallback 档被改坏／被越过」这一类。
    const solo = topic('view:fallback', 'Fallback Topic')
    fixture.snapshot = [solo]
    fixture.state.sessions = [liveCodex('s1', 'Codex · scratch', solo.directoryPath)]
    await mount()

    expect(avatarLabels('Fallback Topic', 1)).toEqual(['Codex · scratch · working'])
  })
})
