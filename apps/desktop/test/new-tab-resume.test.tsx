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
import { api } from '../src/renderer/src/lib/api.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab, initialWorkbenchRegionId } from '../src/renderer/src/lib/workbench-tabs.js'

// Actual NewTabSurface consumer: scope, rows and the executed Session identity must agree.
// Rich selection remains discoverable even when this project has no saved Sessions.

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
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async identity => ({
    agentSessionId: identity.agentSessionId, source: { providerId: 'codex', nativeSessionId: identity.agentSessionId }, items: [], nextCursor: null
  }))
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

function resumeControl(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('.launcher-resume-trigger')
}
const rows = () => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
async function click(target: HTMLElement) { await act(async () => target.click()) }
function button(label: RegExp) {
  const target = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => label.test(item.textContent ?? ''))
  if (!target) throw new Error(`Missing button: ${label}`)
  return target
}

describe('启动页的 Resume 入口', () => {
  it('没有候选仍能打开项目/全局选择器，明确显示空状态', async () => {
    await launcher([])
    expect(resumeControl()).not.toBeNull()
    await click(resumeControl()!)
    expect(rows()).toEqual([])
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('No saved Sessions in this project')
    await click(button(/^All projects/))
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('No saved Sessions yet')
    expect(resumed).toEqual([])
  })

  it('恰好一个候选也先展示真实身份与recap状态，由用户明确选择恢复', async () => {
    await launcher([candidate('only', '/repo')])
    await click(resumeControl()!)
    expect(rows()).toHaveLength(1)
    expect(document.querySelector('.launcher-resume__detail')?.textContent).toContain('only')
    expect(document.querySelector('.launcher-resume__detail')?.textContent).toContain('No recap available')
    expect(resumed).toEqual([])
    await click(button(/^Resume Session$/))
    expect(resumed).toEqual(['only'])
  })

  it('多个项目内候选：恢复的是用户点的那一个，行数和范围一致', async () => {
    await launcher([candidate('first', '/repo'), candidate('second', '/repo'), candidate('third', '/repo')])
    await click(resumeControl()!)
    expect(rows()).toHaveLength(3)
    expect(button(/^This project/).textContent).toContain('3')
    await click(rows().find(row => row.id.endsWith('-second'))!)
    await click(button(/^Resume Session$/))
    expect(resumed).toEqual(['second'])
  })

  it('项目无候选不把全局第一项当本项目；切全局后逐项按原归属恢复', async () => {
    await launcher([candidate('first', '/a'), candidate('second', '/b')])
    await click(resumeControl()!)
    expect(rows()).toEqual([])
    expect(resumed).toEqual([])
    await click(button(/^All projects/))
    expect(rows()).toHaveLength(2)
    await click(rows().find(row => row.id.endsWith('-second'))!)
    expect(document.querySelector('.launcher-resume__detail')?.textContent).toContain('/b')
    expect(resumed).toEqual([])
  })
})
