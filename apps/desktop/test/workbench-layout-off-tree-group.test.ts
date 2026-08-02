import { describe, expect, it } from 'vitest'
import {
  addTab,
  createWorkspaceLayout,
  findGroup,
  groupIds,
  moveTabToNewGroup,
  removeTab,
  type TabGroup,
  type WorkspaceLayout
} from '../src/renderer/src/lib/workbench-layout'

/**
 * `removeTab` 收掉一个空分组的判据，必须问「它在不在分屏树里」。
 *
 * `WorkspaceLayout` 用两种表示同时描述分组：`root`（分屏树）与 `groups`（平铺数组）。**没有任何生产
 * 代码强制这两者一致**——`groupIds(root)` 在本仓的生产调用方是零处。于是「一个分组进了 `groups` 却
 * 不在 `root` 里」是一个类型合法、可构造的状态。
 *
 * 判据此前写的是 `layout.root.type === 'leaf'`。它想说的是「只剩一个分组，别把它删了」，而这句话只在
 * 「每个分组都在 root 树里」这个**未写出来的前提**下与那个意思等价。前提一旦不成立，判据就漏掉那一
 * 族，而且**漏的方向取决于主区恰好有没有分屏**——这是实测出来的，不是推出来的：
 *
 *   - 主区未分屏 → 命中 `root.type === 'leaf'` 提前返回 → 那个分组留着。
 *   - 主区已分屏 → 落到下面：`removeLeaf` 因为它不在树里而不改动树，但 `groups.filter` 把它**删了**。
 *     它的 Tab 记录还在 `state.tabs` 里却不再属于任何分组：一个永不显示、永不可关的孤儿（正是
 *     `addTabOrThrow` 那段 JSDoc 描述的形状）。若它当时还是 `activeGroupId`，`findSiblingGroupId`
 *     因为它在树里没有兄弟而返回 `null`，`activeGroupId` 就停在一个已不存在的 id 上。全程零报错。
 *
 * 所以这个文件守两件事，缺一不可：
 *   1. 不在树里的分组，关掉最后一张 Tab 之后**必须还在**（两种主区形态都要，因为缺陷只在其中一种下
 *      发作，只测一种就是在测那个恰好没问题的方向）；且 `activeGroupId` 永不指向已不存在的分组。
 *   2. 在树里的次级分组，关掉最后一张 Tab 之后**必须被收掉**。
 *
 * 第 2 条不是顺手写的回归：只有它在场，第 1 条才不能用「让 `removeTab` 永远别收分组」蒙过去。本仓记过
 * 这一族——「只守了一侧出口」。
 */

/** 主区未分屏：root 就是唯一那片叶子。 */
function unsplitMain(): WorkspaceLayout {
  return createWorkspaceLayout('main', ['agent:one'])
}

/** 主区已分屏：root 是 split，两片叶子都在 `groups` 里。 */
function splitMain(): WorkspaceLayout {
  return moveTabToNewGroup(
    createWorkspaceLayout('main', ['agent:one', 'file:a.ts']),
    'file:a.ts',
    'main',
    'main',
    'right',
    'main-2'
  )
}

/**
 * 主区已分屏，且**次级分组里有两张 Tab**。
 *
 * 上面的 `splitMain` 每个分组都只有一张 Tab，所以在它身上关 Tab 一定把分组关空——`sourceOrder.length > 0`
 * 那一项恒为假、永不承重。要让那一项成为唯一决定结果的条件，必须有一个分组关掉一张之后**还剩一张**。
 */
function splitMainWithTwoTabsInSecondGroup(): WorkspaceLayout {
  return addTab(splitMain(), 'main-2', 'file:b.ts')
}

/**
 * 往 `groups` 里塞一个**不进 `root`** 的真分组。
 *
 * 没有生产 API 能做出这个状态，是刻意手工构造的——它就是「把浮层做成一个不在主区分屏树里渲染的真
 * 分组」那条路会得到的形状。判据要守的正是这一族，所以样本必须真的长成这样。
 */
function withOffTreeGroup(layout: WorkspaceLayout, groupId: string, tabId: string): WorkspaceLayout {
  const group: TabGroup = { id: groupId, tabOrder: [tabId], activeTabId: tabId, recentTabIds: [tabId] }
  return { ...layout, groups: [...layout.groups, group] }
}

/** 分屏树里的叶子，有哪些在 `groups` 里查不到（反过来不算：不在树里的分组是本文件的正当状态）。 */
function treeLeavesMissingFromGroups(layout: WorkspaceLayout): string[] {
  const present = new Set(layout.groups.map((group) => group.id))
  return groupIds(layout.root).filter((id) => !present.has(id))
}

describe('removeTab 的收组判据要问「它在不在分屏树里」', () => {
  it.each([
    ['主区未分屏', unsplitMain],
    ['主区已分屏', splitMain]
  ])('%s 时，不在树里的分组关掉最后一张 Tab 之后仍然在场', (_label, makeMain) => {
    const layout = withOffTreeGroup(makeMain(), 'floating', 'file:float.ts')
    const closed = removeTab(layout, 'floating', 'file:float.ts')

    // 分组还在，只是空了。删掉它就等于把它名下的 Tab 记录变成孤儿。
    expect(findGroup(closed, 'floating'), '不在树里的分组被静默删掉了').not.toBeNull()
    expect(findGroup(closed, 'floating')?.tabOrder).toEqual([])
    // 它不在树里，收组那一步本来就不该动树。
    expect(closed.root).toEqual(layout.root)
  })

  it('主区已分屏、且不在树里的分组正是活动分组时，activeGroupId 不会指向已不存在的分组', () => {
    // 这一条与上面那条测的是同一次调用的两个不同后果：即使有人把分组留下了，`activeGroupId` 仍然
    // 可能被 `findSiblingGroupId` 的 `null` 带到别处；反过来若分组被删而 activeGroupId 不动，
    // 指向的就是个不存在的 id。两个后果各自独立，所以各钉一条。
    const base = withOffTreeGroup(splitMain(), 'floating', 'file:float.ts')
    const layout: WorkspaceLayout = { ...base, activeGroupId: 'floating' }

    const closed = removeTab(layout, 'floating', 'file:float.ts')

    expect(
      findGroup(closed, closed.activeGroupId),
      `activeGroupId 指向 ${closed.activeGroupId}，而 groups 里只有 ${closed.groups.map((g) => g.id).join(', ')}`
    ).not.toBeNull()
  })

  it('唯一那个分组关掉最后一张 Tab 之后仍然在场（否则整个 workspace 没有分组可显示）', () => {
    // 这一条钉的是判据里的 `leafIds.length === 1` 那一项。它与旧的 `root.type === 'leaf'` 逐点等价
    // （split 恒有两个子节点，故叶子数为 1 ⟺ root 本身就是叶子），但等价不等于有人守。
    const closed = removeTab(unsplitMain(), 'main', 'agent:one')

    expect(findGroup(closed, 'main'), '最后一个分组被收掉了').not.toBeNull()
    expect(closed.root).toEqual({ type: 'leaf', groupId: 'main' })
    expect(closed.activeGroupId).toBe('main')
  })

  it('在树里的次级分组关掉最后一张 Tab 之后必须被收掉（否则上面几条可以靠「永不收组」蒙过）', () => {
    const closed = removeTab(splitMain(), 'main-2', 'file:a.ts')

    expect(findGroup(closed, 'main-2'), '空的次级分组没有被收掉').toBeNull()
    expect(closed.root).toEqual({ type: 'leaf', groupId: 'main' })
    expect(closed.activeGroupId).toBe('main')
  })

  it('在树里的分组还剩 Tab 时不许被收掉（钉判据里的 `sourceOrder.length > 0` 那一项）', () => {
    // 这一项此前无人守：本文件其余每条都是「关掉某个分组的**最后**一张 Tab」，那时 sourceOrder 恒为空，
    // 于是判据的第一项恒为假、永不决定结果——把它整项删掉，六条照旧全绿。而它防的是最贵的那一种：
    // 分组里还有别的 Tab 就把分组收掉，剩下那张 Tab 的记录还在 state.tabs 里却不再属于任何分组，
    // 成为永不显示、永不可关的孤儿（addTabPlacement 那段 JSDoc 描述的形状）。
    const layout = splitMainWithTwoTabsInSecondGroup()
    // 前提自检：main-2 真的有两张 Tab，否则这条用例退化成「关最后一张」而测不到那一项。
    expect(findGroup(layout, 'main-2')?.tabOrder).toEqual(['file:a.ts', 'file:b.ts'])

    const closed = removeTab(layout, 'main-2', 'file:a.ts')

    expect(findGroup(closed, 'main-2'), '分组里还剩 Tab 却被收掉了').not.toBeNull()
    expect(findGroup(closed, 'main-2')?.tabOrder).toEqual(['file:b.ts'])
    // 树也不该动：收组才动树，这次不是收组。
    expect(groupIds(closed.root).sort()).toEqual(['main', 'main-2'])
  })

  it('以上每条的结果里，分屏树的每片叶子都在 groups 里查得到', () => {
    // 收组会同时改 `root` 与 `groups`，两边各改一半就会留下「树里有、数组里没有」的叶子——那是
    // 渲染时直接取不到分组的形状。上面几条只看被关的那个分组，这条看两种表示有没有对上。
    const cases: WorkspaceLayout[] = [
      removeTab(withOffTreeGroup(unsplitMain(), 'floating', 'file:float.ts'), 'floating', 'file:float.ts'),
      removeTab(withOffTreeGroup(splitMain(), 'floating', 'file:float.ts'), 'floating', 'file:float.ts'),
      removeTab(unsplitMain(), 'main', 'agent:one'),
      removeTab(splitMain(), 'main-2', 'file:a.ts')
    ]
    for (const layout of cases) {
      expect(treeLeavesMissingFromGroups(layout), JSON.stringify(layout.root)).toEqual([])
    }
  })
})
