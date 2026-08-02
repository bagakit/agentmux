import { describe, expect, it } from 'vitest'
import {
  MIN_SPLIT_RATIO,
  clampSplitRatio,
  findSiblingLeafId,
  setSplitRatioAtPath,
  type SplitTreeNode
} from '../src/renderer/src/lib/split-tree'

type Leaf = { id: string }
type Node = SplitTreeNode<Leaf>
const leaf = (id: string): Node => ({ type: 'leaf', id })
const idOf = (node: { id: string }): string => node.id

describe('split-tree substrate（两棵分屏树的 SSOT）', () => {
  describe('clampSplitRatio 与 MIN_SPLIT_RATIO', () => {
    // 下限写死 0.15，不从 MIN_SPLIT_RATIO 派生：若 MIN_SPLIT_RATIO 被改（比如漂回旧 region 树的 0.1），
    // 这两条必须变红——那正是本次合并要消除的漂移。上界是 1 - 0.15 = 0.85，同样写死历史字面量。
    it('把过窄的比例夹到 0.15、过宽的夹到 0.85', () => {
      expect(clampSplitRatio(0.02)).toBe(0.15)
      expect(clampSplitRatio(0.98)).toBe(0.85)
    })

    it('区间内的比例原样透传', () => {
      expect(clampSplitRatio(0.5)).toBe(0.5)
      expect(clampSplitRatio(0.15)).toBe(0.15)
      expect(clampSplitRatio(0.85)).toBe(0.85)
    })

    it('MIN_SPLIT_RATIO 就是渲染层 Panel 的 minSize（0.15 ⟺ minSize={15}）', () => {
      // 这个数是产品决策「一个面板最窄能到多窄」。它必须与 WorkspaceWorkbench.tsx 的 minSize={15}
      // 同值，否则模型能存到视图弹不回的比例。钉死 0.15。
      expect(MIN_SPLIT_RATIO).toBe(0.15)
    })
  })

  describe('setSplitRatioAtPath', () => {
    const tree = (): Node => ({
      type: 'split',
      direction: 'horizontal',
      first: leaf('a'),
      second: { type: 'split', direction: 'vertical', first: leaf('b'), second: leaf('c'), ratio: 0.5 },
      ratio: 0.5
    })

    it('空路径改根节点的比例（顺带夹取）', () => {
      const next = setSplitRatioAtPath(tree(), '', 0.02)
      expect(next.type === 'split' && next.ratio).toBe(0.15)
    })

    it('按 . 分段深入到内层 split 并只改那一个比例', () => {
      const next = setSplitRatioAtPath(tree(), 'second', 0.7)
      expect(next.type === 'split' && next.ratio).toBe(0.5) // 根不动
      expect(next.type === 'split' && next.second.type === 'split' && next.second.ratio).toBe(0.7)
    })
  })

  describe('findSiblingLeafId', () => {
    it('叶子的兄弟就是同一个 split 的另一片叶子', () => {
      const root: Node = { type: 'split', direction: 'horizontal', first: leaf('a'), second: leaf('b'), ratio: 0.5 }
      expect(findSiblingLeafId(root, idOf, 'a')).toBe('b')
      expect(findSiblingLeafId(root, idOf, 'b')).toBe('a')
    })

    it('兄弟是子树时取其第一片叶子（与删叶后子树被提升的读序一致）', () => {
      // root = [ a | (b|c) ]。a 的兄弟是右子树，删掉 a 后右子树被提升——用户看向补上来那块的第一格 b。
      const root: Node = {
        type: 'split',
        direction: 'horizontal',
        first: leaf('a'),
        second: { type: 'split', direction: 'horizontal', first: leaf('b'), second: leaf('c'), ratio: 0.5 },
        ratio: 0.5
      }
      expect(findSiblingLeafId(root, idOf, 'a')).toBe('b')
    })

    it('单叶子（无兄弟）返回 null', () => {
      expect(findSiblingLeafId(leaf('only'), idOf, 'only')).toBeNull()
    })
  })
})
