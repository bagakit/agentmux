import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createWorkspaceLayout, addTab } from '../src/renderer/src/lib/workbench-layout.js'
import { createWorkbenchTab, type WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import { layoutForActiveTopic } from '../src/renderer/src/lib/scratch-topic-layout.js'

const workspaceWorkbenchSource = readFileSync(
  new URL('../src/renderer/src/components/WorkspaceWorkbench.tsx', import.meta.url),
  'utf8'
)

// 切 Branch 换掉整套 Tab 组，是因为 layouts 按 workspaceId 键控——每个 worktree 是一个
// workspace。Scratch 的所有 Topic 共用一个 workspace，所以共用一套 layout，切 Topic 时
// 别的 Topic 的 Tab 仍然留在条上。用户要的是同一种体验：切 Topic 就换那一组 Tab。
//
// 不新增数据维度：tab.topicId 已经存在，按它过滤即可。

function launcher(id: string, topicId?: string): WorkbenchTab {
  const tab = createWorkbenchTab(id, {
    regionId: `region:${id}`,
    kind: 'launcher',
    workspaceId: 'scratch'
  })
  return topicId ? { ...tab, topicId } : tab
}

const tabs: Record<string, WorkbenchTab> = {
  'a-1': launcher('a-1', 'topic-a'),
  'a-2': launcher('a-2', 'topic-a'),
  'b-1': launcher('b-1', 'topic-b'),
  'loose': launcher('loose')
}

function fullLayout() {
  let layout = createWorkspaceLayout('group', ['a-1'])
  for (const id of ['a-2', 'b-1', 'loose']) layout = addTab(layout, 'group', id)
  return layout
}

describe('切 Topic 就换那一组 Tab', () => {
  it('只留下当前 Topic 的 Tab', () => {
    const shown = layoutForActiveTopic(fullLayout(), tabs, 'topic-a')
    // loose 未绑定 Topic，按下面那条规则始终可见。
    expect(shown.groups[0]!.tabOrder).toEqual(['a-1', 'a-2', 'loose'])
  })

  it('切到另一个 Topic 就换成它的那一组', () => {
    const shown = layoutForActiveTopic(fullLayout(), tabs, 'topic-b')
    expect(shown.groups[0]!.tabOrder).toEqual(['b-1', 'loose'])
  })

  it('未绑定 Topic 的 Tab 始终可见——它不属于任何 Topic，藏起来就找不回了', () => {
    const shown = layoutForActiveTopic(fullLayout(), tabs, 'topic-b')
    // loose 没有 topicId：它不该因为你正看着某个 Topic 就消失。
    expect(layoutForActiveTopic(fullLayout(), tabs, null).groups[0]!.tabOrder).toContain('loose')
    expect(shown.groups[0]!.tabOrder).not.toContain('a-1')
  })

  it('没有选中 Topic 时显示全部——不做无谓的隐藏', () => {
    const shown = layoutForActiveTopic(fullLayout(), tabs, null)
    expect(shown.groups[0]!.tabOrder).toEqual(['a-1', 'a-2', 'b-1', 'loose'])
  })

  it('活动 Tab 被过滤掉时改为该组第一个可见的 Tab', () => {
    // 原本活动的是 a-1（topic-a）；切到 topic-b 后它不可见，活动项必须跟着走，
    // 否则界面会指向一个已经不在条上的 Tab。
    const shown = layoutForActiveTopic(fullLayout(), tabs, 'topic-b')
    // a-1 不可见了，活动项落到过滤后 tabOrder 的第一个。原序是 a-1,a-2,b-1,loose，
    // 过滤 topic-b 后是 b-1,loose——所以是 b-1。
    expect(shown.groups[0]!.tabOrder[0]).toBe('b-1')
    expect(shown.groups[0]!.activeTabId).toBe(shown.groups[0]!.tabOrder[0])
  })

  it('该 Topic 一个 Tab 都没有时不留下空组的假活动项', () => {
    const shown = layoutForActiveTopic(fullLayout(), tabs, 'topic-none')
    // loose 无 topicId 故仍可见，活动项落到它身上而不是一个不存在的 Tab。
    expect(shown.groups[0]!.tabOrder).toEqual(['loose'])
    expect(shown.groups[0]!.activeTabId).toBe('loose')
  })

  it('是纯函数：不改动传入的 layout', () => {
    const original = fullLayout()
    const before = JSON.stringify(original)
    layoutForActiveTopic(original, tabs, 'topic-a')
    expect(JSON.stringify(original)).toBe(before)
  })

  it('renders the projected layout instead of reading the unfiltered Store layout again', () => {
    // The Topic projection was already correct, but SplitNode/PaneGroup re-read Store.layouts and
    // silently replaced it with the full layout. Keep this owner-boundary contract close to the
    // projection tests so a future refactor cannot reintroduce the mixed-tab regression.
    const splitNode = workspaceWorkbenchSource.slice(
      workspaceWorkbenchSource.indexOf('function SplitNode('),
      workspaceWorkbenchSource.indexOf('function SplitBranch(')
    )
    const paneGroup = workspaceWorkbenchSource.slice(
      workspaceWorkbenchSource.indexOf('function PaneGroup('),
      workspaceWorkbenchSource.indexOf('function SplitNode(')
    )

    expect(splitNode).toContain('layout: WorkspaceLayout')
    expect(splitNode).toContain('layout={layout}')
    expect(splitNode).not.toContain('state.layouts[workspaceId]')
    expect(paneGroup).toContain('layout: WorkspaceLayout')
    expect(paneGroup).not.toContain('state.layouts[workspaceId]')
    expect(workspaceWorkbenchSource).toContain('layout={layout}')
  })
})
