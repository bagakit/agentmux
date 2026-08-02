// 分屏树的 SSOT。工作区的 tab-group 布局（workbench-layout.ts）与 tab 内的 region 布局
// （workbench-view-layout.ts）是**同一棵树**：一个带方向与比例的二叉分屏，叶子上挂各自的载荷。
// 两边只有叶子载荷不同（groupId vs regionId），所以「比例夹取、按路径改比例、关闭叶子后找兄弟」
// 这套树代数只应存在一份——此前它被抄了两份并已经漂移（比例上界、比例可选性、关闭后的重聚焦
// 三处各不相同），本文件把它收回一处。
//
// 叶子载荷用泛型 Leaf 表达；两个具体节点类型是它的实例（见各自文件的 type 别名）。

export type SplitTreeNode<Leaf> =
  | ({ type: 'leaf' } & Leaf)
  | {
      type: 'split'
      direction: 'horizontal' | 'vertical'
      first: SplitTreeNode<Leaf>
      second: SplitTreeNode<Leaf>
      ratio: number
    }

// 直接写成交集，而不是 Extract<SplitTreeNode<Leaf>, {type:'leaf'}>：后者在 Leaf 还是类型参数时
// 不保证被解成这个交集，会让泛型函数里的叶子入参类型对不上。
export type SplitTreeLeaf<Leaf> = { type: 'leaf' } & Leaf

// 分屏比例的下限＝渲染层 Panel 的 minSize（WorkspaceWorkbench.tsx 里所有 <Panel> 都是 minSize={15}）。
// 两者必须是同一个数：拖动落点被 react-resizable-panels 夹在 [minSize, 100-minSize] 内，若写回 store
// 的比例允许比它更极端，面板会在下一次渲染把自己弹回边界、视觉上跳一下。此前 region 树用 0.1、
// tab-group 树用 0.15，前者就落在「模型允许、视图不允许」的缝里。取 0.15 让「模型能存的最窄」与
// 「视图能显示的最窄」重合。上界对称派生（1 - 0.15 = 0.85），不再单列第二个常量。
// 改这个数就是产品决策——一个面板最窄能到多窄——所以整仓只此一处。
export const MIN_SPLIT_RATIO = 0.15

export function clampSplitRatio(ratio: number): number {
  return Math.max(MIN_SPLIT_RATIO, Math.min(1 - MIN_SPLIT_RATIO, ratio))
}

function updateRatioAtSegments<Leaf>(
  root: SplitTreeNode<Leaf>,
  path: string[],
  ratio: number
): SplitTreeNode<Leaf> {
  if (path.length === 0) return root.type === 'split' ? { ...root, ratio } : root
  if (root.type !== 'split') return root
  const [segment, ...rest] = path
  if (segment === 'first') return { ...root, first: updateRatioAtSegments(root.first, rest, ratio) }
  if (segment === 'second') return { ...root, second: updateRatioAtSegments(root.second, rest, ratio) }
  return root
}

// nodePath 用 '.' 分段（'first.second'…），空串＝根。比例在此统一夹取一次，调用方不再各自夹。
export function setSplitRatioAtPath<Leaf>(
  root: SplitTreeNode<Leaf>,
  nodePath: string,
  ratio: number
): SplitTreeNode<Leaf> {
  return updateRatioAtSegments(root, nodePath ? nodePath.split('.') : [], clampSplitRatio(ratio))
}

function firstLeafId<Leaf>(
  root: SplitTreeNode<Leaf>,
  leafId: (leaf: SplitTreeLeaf<Leaf>) => string
): string {
  return root.type === 'leaf' ? leafId(root) : firstLeafId(root.first, leafId)
}

// 关闭一片叶子后谁接管焦点：它的**兄弟**。在二叉分屏里，删掉一片叶子时它的兄弟子树被提升到父节点
// 的位置——正是视觉上长大、占掉被关格所空出那块地方的那一格，所以焦点落到兄弟才符合用户「关掉这格、
// 看向补上来的那格」的动作。兄弟本身是子树时取其第一片叶子（与 removeLeaf/removeRegionNode 提升子树后
// 的读序一致）。返回 null 表示 target 不在树里、或 root 本身就是叶子（没有兄弟）。
export function findSiblingLeafId<Leaf>(
  root: SplitTreeNode<Leaf>,
  leafId: (leaf: SplitTreeLeaf<Leaf>) => string,
  targetId: string
): string | null {
  if (root.type === 'leaf') return null
  if (root.first.type === 'leaf' && leafId(root.first) === targetId) {
    return firstLeafId(root.second, leafId)
  }
  if (root.second.type === 'leaf' && leafId(root.second) === targetId) {
    return firstLeafId(root.first, leafId)
  }
  return (
    findSiblingLeafId(root.first, leafId, targetId) ??
    findSiblingLeafId(root.second, leafId, targetId)
  )
}
