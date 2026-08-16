// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

// NewTabSurface 会拉进 TerminalView → xterm addon（模块加载期就要 `self`）。本测试关心的是
// Resume 这个入口，终端渲染不在范围内；与本仓其他 NewTabSurface 测试同一处理。
vi.mock('../src/renderer/src/components/TerminalView.js', () => ({ TerminalView: () => null }))

import type { AgentSessionRecoveryCandidate, AppConfig } from '../src/shared/contracts.js'
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab, initialWorkbenchRegionId } from '../src/renderer/src/lib/workbench-tabs.js'

// ---------------------------------------------------------------------------
// 「读数与动作指向同一个对象」（docs/design/agentmux-desktop-interaction.md）。
//
// 缺陷原形：按钮写着 `Resume (17)`，而 onClick 恒定 `recoverSession(recoveryCandidates[0])`。
// 控件报出 17 个候选，却只有一个够得着；另外 16 个没有任何入口，而程序认为自己成功了——
// 既不报错，也没有任何测试会红。此前守这里的是三行 `expect(source).toContain(...)`：
// 源码里有 'recoveryCandidates' 和 'Resume' 两个字符串，缺陷原形完全满足它。
//
// 所以这里真渲染、真点击：判据是**被恢复的那个 id 等于用户点的那一行**。
// ---------------------------------------------------------------------------

const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {
    codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true }
  },
  workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: '/repo', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}

function candidate(id: string, workspacePath: string): AgentSessionRecoveryCandidate {
  return {
    agentSessionId: id,
    hostId: 'local',
    workspacePath,
    providerId: 'codex',
    executorId: 'codex',
    capabilities: {} as AgentSessionRecoveryCandidate['capabilities'],
    label: `Codex · ${workspacePath}`,
    createdAt: 1,
    updatedAt: 2,
    run: { hostId: 'local', runId: id } as AgentSessionRecoveryCandidate['run']
  }
}

const initialState = useAppStore.getState()
let container: HTMLDivElement
let root: Root
let resumed: string[]

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  resumed = []
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useAppStore.setState(initialState, true)
  vi.restoreAllMocks()
})

async function launcher(candidates: AgentSessionRecoveryCandidate[]) {
  const tabId = 'launcher-tab'
  const regionId = initialWorkbenchRegionId(tabId)
  const tab = createWorkbenchTab(tabId, { regionId, kind: 'launcher', workspaceId: 'workspace' })
  useAppStore.setState({
    config,
    activeWorkspaceId: 'workspace',
    tabs: { [tabId]: tab },
    layouts: { workspace: createWorkspaceLayout('pane', [tabId]) },
    recoveryCandidates: candidates,
    recoverSession: (async (sessionId: string) => { resumed.push(sessionId) }) as never,
    error: null
  })
  await act(async () => root.render(<NewTabSurface tabGroupId="pane" tabId={tabId} regionId={regionId} />))
}

/** 页脚里那个 Resume 控件——不论它今天是按钮还是菜单触发器。 */
function resumeControl(): HTMLElement | null {
  return [...container.querySelectorAll<HTMLElement>('.launch-surface__footer button')]
    .find((el) => /resume/i.test(el.textContent ?? '')) ?? null
}

const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]

/** Radix 的触发器开在 pointerdown 上，不是 click——与 hover-dropdown-menu.test.tsx 同一处理。 */
async function press(target: Element) {
  await act(async () => target.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true, cancelable: true, pointerType: 'mouse', button: 0, buttons: 1
  })))
}

describe('启动页的 Resume 入口', () => {
  it('没有候选就没有这个入口', async () => {
    await launcher([])
    expect(resumeControl()).toBeNull()
  })

  it('恰好一个候选：直接恢复它，且不报一个没有可选项的计数', async () => {
    await launcher([candidate('only', '/repo')])
    const control = resumeControl()
    expect(control, '有一个候选却没有 Resume 入口').not.toBeNull()
    // 「(1)」是在报一个数，而没有第二个东西可挑——那个数唯一的作用是让人以为可以选。
    expect(control!.textContent).not.toMatch(/\d/)
    await act(async () => control!.click())
    expect(resumed).toEqual(['only'])
  })

  it('多个候选：恢复的是用户点的那一个，不是第一个', async () => {
    await launcher([candidate('first', '/a'), candidate('second', '/b'), candidate('third', '/c')])
    const trigger = resumeControl()!
    expect(trigger.textContent).toContain('3')

    await press(trigger)
    const items = menuItems()
    // 三个候选就得列出三行——少一行就是少一个够得着的会话，而这正是缺陷原形（只够得着一个）。
    expect(items).toHaveLength(3)

    const second = items.find((item) => item.textContent?.includes('/b'))
    expect(second, '菜单行没有带上能把同源候选区分开的 workspace 路径').toBeDefined()
    await act(async () => second!.click())
    expect(resumed).toEqual(['second'])
  })
})
