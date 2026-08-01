import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  canStopSessionRun,
  sessionTabTooltip,
  surfaceTabTooltip
} from '../src/renderer/src/lib/session-metadata.js'

const sessionPaneSource = readFileSync(
  new URL('../src/renderer/src/components/SessionPane.tsx', import.meta.url),
  'utf8'
)
const workspaceWorkbenchSource = readFileSync(
  new URL('../src/renderer/src/components/WorkspaceWorkbench.tsx', import.meta.url),
  'utf8'
)
const workbenchTabMenuSource = readFileSync(
  new URL('../src/renderer/src/components/WorkbenchTabContextMenu.tsx', import.meta.url),
  'utf8'
)

describe('single-line session tab projection', () => {
  it('keeps low-frequency session metadata in the tab tooltip', () => {
    const tooltip = sessionTabTooltip({
      label: 'codex · agentmux',
      id: 'd1df756e-18f5-4d3e-b309-0635b8d2999b',
      hostId: 'local',
      workspacePath: '/repos/agentmux',
      createdAt: 0,
      updatedAt: 60_000
    })

    expect(tooltip).toContain('codex · agentmux')
    expect(tooltip).toContain('Session ID: d1df756e-18f5-4d3e-b309-0635b8d2999b')
    expect(tooltip).toContain('Host: local')
    // The Agent's own cwd is always in the tooltip, so a moved View cannot pass off its host
    // workspace's name as the Agent's working directory.
    expect(tooltip).toContain('Working directory: /repos/agentmux')
    expect(tooltip).toContain('Started:')
    expect(tooltip).toContain('Active:')
  })

  it('keeps Stop Run available until the process has exited', () => {
    expect(canStopSessionRun({ processState: 'running' })).toBe(true)
    expect(canStopSessionRun({ processState: 'interrupted' })).toBe(true)
    expect(canStopSessionRun({ processState: 'exited' })).toBe(false)
  })

  it('keeps SessionPane chrome-free and owns Run actions in the pane tabbar', () => {
    expect(sessionPaneSource).not.toContain('session-info-bar')
    expect(sessionPaneSource).not.toContain('Stop Run')
    expect(workspaceWorkbenchSource).toContain('pane-action pane-action--stop')
    // Tab 菜单仍提供 Session 身份的复制；它现在产出的是自足的**地址**而非裸 id
    // （见 agent-address.ts），所以这里跟着标签走。
    expect(workbenchTabMenuSource).toContain('Copy Session Address')
  })

  it('makes stopping the default Agent Tab close action while preserving an explicit background option', () => {
    expect(workspaceWorkbenchSource).toContain("'Stop & Close'")
    expect(workspaceWorkbenchSource).toContain("'Keep Session & Close'")
    expect(workspaceWorkbenchSource).toContain('sessionIdsWithoutViewsAfterClosingTabs')
  })

  it('Terminal tab 画终端图标而不是 Agent 状态点——判据落在算标记那一层', () => {    // 这条断言原先扫的是 `WorkspaceWorkbench.tsx` 里一个内联三元的字面串
    // （`) : <SquareTerminal size={12} />`）。那段代码已经搬进 `workbench-tab-marks` 一族：算画哪几个
    // 标记是纯函数，画成什么图标是 `WorkbenchTabMarks`，两者都能被真执行。搬走之后这条文本断言指向
    // 一个不存在的字面串而红——不是那个性质丢了，是它守的地方换了。
    //
    // 为什么不把断言改成扫新文件的字面串：文本断言证明不了那条链**被执行到**（这正是搬家的起因）。
    // 「Agent 事实缺席的 Region 画终端图标」现在由 `workbench-tab-marks.test.ts` 用真渲染钉住
    // （见那里「Agent 事实缺席的 agent Region 与终端 Region 折成同一个标记」与
    // 「Agent 标记画出 Provider 图标与状态点，而不是终端图标」两条）。这里只钉住**接线仍在这个文件**、
    // 且它没有绕过那一层自己画状态点：整条渲染链一旦被谁改回内联三元，下面第二句会红。
    expect(workspaceWorkbenchSource).toContain('workbenchTabMarks(tab, agentFactsFor)')
    expect(workspaceWorkbenchSource).not.toContain('session ? <StatusDot status={session.status} />')
  })

  describe('多 Region 的构成进 tooltip', () => {
    // 标记簇在上限处截断且刻意不画 `+N`，折掉的种类改由 tooltip 兜住（见 workbench-tab-marks 的
    // `tabRegionSummary`）。这一族守的是 tooltip 这一侧：算出来了、也真的放进了那一行字。

    it('构成在场时排在名字之下、Session 身份之上', () => {
      const tooltip = sessionTabTooltip(
        {
          label: 'codex · agentmux',
          id: 'session-1',
          hostId: 'local',
          workspacePath: '/repos/agentmux',
          createdAt: 0,
          updatedAt: 60_000
        },
        'my tab',
        'Regions: Terminal, Browser'
      )
      const lines = tooltip.split('\n')
      // 位置也是判据：一张多 Region 的 Tab，"里面还有个浏览器"比 Session ID 更常被问到。
      expect(lines[0]).toBe('my tab')
      expect(lines[1]).toBe('Regions: Terminal, Browser')
      expect(lines[2]).toBe('Session ID: session-1')
    })

    it('构成缺席时不留空行——单 Region 的 Tab 是绝大多数', () => {
      const tooltip = sessionTabTooltip(
        {
          label: 'codex · agentmux',
          id: 'session-1',
          hostId: 'local',
          workspacePath: '/repos/agentmux',
          createdAt: 0,
          updatedAt: 60_000
        },
        'my tab',
        null
      )
      expect(tooltip.split('\n')[1]).toBe('Session ID: session-1')
      expect(tooltip).not.toContain('\n\n')
    })

    it('没有 Session 的 Tab 也说得出构成——文件+浏览器那种组合里没有任何 Provider 名可依', () => {
      // 这正是不能让渲染现场写 `session ? sessionTabTooltip(...) : displayName` 的理由：那样构成只有
      // 带 Session 的 Tab 才有，而最需要它的恰恰是没有 Session 的多 Region Tab。
      expect(surfaceTabTooltip('a.ts', 'Regions: File, Browser')).toBe('a.ts\nRegions: File, Browser')
      expect(surfaceTabTooltip('a.ts', null)).toBe('a.ts')
    })

    it('两条 tooltip 路径都接上了构成，没有一条把它丢在半路', () => {
      // lib 算对了但渲染现场只给其中一条传参，是这类修复最容易留下的半截活。
      expect(workspaceWorkbenchSource).toContain('tabRegionSummary(tab, agentFactsFor)')
      expect(workspaceWorkbenchSource).toContain('sessionTabTooltip(session, displayName, regionSummary)')
      expect(workspaceWorkbenchSource).toContain('surfaceTabTooltip(displayName, regionSummary)')
    })
  })
})
