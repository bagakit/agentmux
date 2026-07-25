import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createWorkspaceLayout, addTab } from '../src/renderer/src/lib/workbench-layout.js'
import { createWorkbenchTab, type WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import {
  activeTopicIdFromLayout,
  layoutForActiveTopic
} from '../src/renderer/src/lib/scratch-topic-layout.js'

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

// 上面那组测投影：知道当前 Topic 是谁之后，只显示它的 Tab。
// 下面这组测**当前 Topic 是谁**——投影再对，喂给它一个 null 也什么都不会发生。
//
// 用户看到的症状：「现在选择 topic , 没有像 branch 那样只展示自己的 tabs, 而是展示所有」。
// 根因不在投影，在于当前 Topic 曾经存在 store 的一个字段里，而只有 Topic 面板的点击会写它。
// 从别的路径进入一个 Topic，那个字段还是 null，于是 `if (!activeTopicId) return layout`
// 原样返回——所有 Topic 的 Tab 混在一起。

describe('当前 Topic 由活动 Tab 的绑定派生', () => {
  function withActive(tabId: string) {
    const layout = fullLayout()
    return {
      ...layout,
      groups: layout.groups.map((group) => ({ ...group, activeTabId: tabId }))
    }
  }

  it('点该 Topic 自己的 Tab 进入，也只看到它的 Tab', () => {
    // 这条路径不经过 openScratchTopic：用户直接点了 Tab 条上属于 topic-b 的那张。
    const layout = withActive('b-1')
    const topicId = activeTopicIdFromLayout(layout, tabs)
    expect(topicId).toBe('topic-b')
    expect(layoutForActiveTopic(layout, tabs, topicId).groups[0]!.tabOrder).toEqual(['b-1', 'loose'])
  })

  it('会话恢复后落在某张 Tab 上，同样只看到它所属 Topic 的 Tab', () => {
    // 恢复时没有任何人调用 openScratchTopic，活动 Tab 是持久化下来的。
    const layout = withActive('a-2')
    const topicId = activeTopicIdFromLayout(layout, tabs)
    expect(topicId).toBe('topic-a')
    expect(layoutForActiveTopic(layout, tabs, topicId).groups[0]!.tabOrder).toEqual(['a-1', 'a-2', 'loose'])
  })

  it('从 Board 的 Topic 行跳过去，看到的也只有那个 Topic', () => {
    // Board 走 openScratchTopic 绑定，落点是该 Topic 的 launcher Tab——派生同样成立，
    // 不需要它额外写一个字段。
    const layout = withActive('a-1')
    expect(activeTopicIdFromLayout(layout, tabs)).toBe('topic-a')
  })

  it('活动 Tab 不属于任何 Topic 时不隐藏任何东西', () => {
    // 普通 workspace tab 意味着"现在不在任何 Topic 里"，此时藏起别的 Tab 是错的。
    const layout = withActive('loose')
    expect(activeTopicIdFromLayout(layout, tabs)).toBeNull()
    expect(layoutForActiveTopic(layout, tabs, null).groups[0]!.tabOrder)
      .toEqual(['a-1', 'a-2', 'b-1', 'loose'])
  })

  it('没有活动 Tab 时诚实地回答"不知道"', () => {
    const layout = fullLayout()
    const empty = { ...layout, groups: layout.groups.map((group) => ({ ...group, activeTabId: null })) }
    expect(activeTopicIdFromLayout(empty, tabs)).toBeNull()
  })

  it('Workbench 从 layout 派生当前 Topic，而不是读那个只有面板会写的字段', () => {
    // 这条钉住接线：派生函数本身全绿，也证明不了渲染面真的用了它。改回读 store 字段会红。
    expect(workspaceWorkbenchSource).toContain('activeTopicIdFromLayout(storedLayout, tabs)')
    expect(workspaceWorkbenchSource).not.toContain('state.activeScratchTopicId')
  })
})
