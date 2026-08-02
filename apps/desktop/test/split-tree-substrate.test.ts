import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  MIN_SPLIT_RATIO,
  MIN_SPLIT_PERCENT,
  clampSplitRatio,
  collectLeafIds,
  findSiblingLeafId,
  removeLeaf,
  replaceLeaf,
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

    it('MIN_SPLIT_PERCENT 由 MIN_SPLIT_RATIO 派生（渲染层 minSize 直接消费它，不再手抄字面量）', () => {
      // 渲染层的 <Panel minSize={…}> 现在写 minSize={MIN_SPLIT_PERCENT}（WorkspaceWorkbench.tsx 四处），
      // 不再手抄裸字面量 15。两侧同源，改 MIN_SPLIT_RATIO 时 minSize 由构造随之移动——编译期保证同值，
      // 这条漂移无需再单独守。此处只钉派生关系本身（百分制 = 比例 × 100），锚点写死历史值 0.15/15。
      expect(MIN_SPLIT_RATIO).toBe(0.15)
      expect(MIN_SPLIT_PERCENT).toBe(15)
      expect(MIN_SPLIT_PERCENT).toBe(MIN_SPLIT_RATIO * 100)
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

  // collectLeafIds / replaceLeaf / removeLeaf 是把两份逐字相同的实现（workbench-layout 的
  // groupIds/replaceLeaf/removeLeaf 与 workbench-view-layout 的 regionIds/replaceRegion/removeRegionNode）
  // 折进 SSOT 后的通用版。下面每一族的期望值都**手写成字面量树**，不由实现算出、也不从任一被折叠的旧实现
  // 派生——两份实现正被合成一份，任何「拿代码当锚点」的期望都会在幸存实现自我一致地给出错误答案时照旧变绿。
  describe('collectLeafIds（折叠 groupIds/regionIds）', () => {
    it('单叶子产出它自己的 id', () => {
      expect(collectLeafIds(leaf('solo'), idOf)).toEqual(['solo'])
    })

    it('嵌套树按读序（左→右 / 上→下 先序）铺平', () => {
      // root = [ a | (b | c) ]：先序读序是 a、b、c。手写这个次序，不调用实现来生成。
      const root: Node = {
        type: 'split',
        direction: 'horizontal',
        first: leaf('a'),
        second: { type: 'split', direction: 'vertical', first: leaf('b'), second: leaf('c'), ratio: 0.5 },
        ratio: 0.5
      }
      expect(collectLeafIds(root, idOf)).toEqual(['a', 'b', 'c'])
    })
  })

  describe('replaceLeaf（折叠 replaceLeaf/replaceRegion）', () => {
    it('把命中的叶子换成另一片叶子，其余原样', () => {
      const root: Node = { type: 'split', direction: 'horizontal', first: leaf('a'), second: leaf('b'), ratio: 0.5 }
      // 期望：a 变成 x，骨架/方向/比例不动。手写整棵目标树。
      expect(replaceLeaf(root, idOf, 'a', leaf('x'))).toEqual({
        type: 'split', direction: 'horizontal', first: leaf('x'), second: leaf('b'), ratio: 0.5
      })
    })

    it('把命中的叶子换成一棵 split 子树（在这一格上再切一刀）', () => {
      const root: Node = { type: 'split', direction: 'horizontal', first: leaf('a'), second: leaf('b'), ratio: 0.5 }
      const inserted: Node = { type: 'split', direction: 'vertical', first: leaf('b'), second: leaf('new'), ratio: 0.5 }
      // 期望：b 那一格被 [ b / new ] 顶替，外层不动。
      expect(replaceLeaf(root, idOf, 'b', inserted)).toEqual({
        type: 'split',
        direction: 'horizontal',
        first: leaf('a'),
        second: { type: 'split', direction: 'vertical', first: leaf('b'), second: leaf('new'), ratio: 0.5 },
        ratio: 0.5
      })
    })

    it('root 本身就是命中的叶子时整体被替换', () => {
      expect(replaceLeaf(leaf('only'), idOf, 'only', leaf('x'))).toEqual(leaf('x'))
    })

    it('不在场的 id 不改动任何东西（结构相等）', () => {
      const root: Node = { type: 'split', direction: 'horizontal', first: leaf('a'), second: leaf('b'), ratio: 0.5 }
      expect(replaceLeaf(root, idOf, 'zzz', leaf('x'))).toEqual({
        type: 'split', direction: 'horizontal', first: leaf('a'), second: leaf('b'), ratio: 0.5
      })
    })
  })

  describe('removeLeaf（折叠 removeLeaf/removeRegionNode）——四种情形各钉一次', () => {
    it('直接子叶：删掉后兄弟被提升到父 split 的位置', () => {
      // root = [ a | b ]，删 a → 兄弟 b 被提升为整棵树。手写目标：一片叶子 b。
      const root: Node = { type: 'split', direction: 'horizontal', first: leaf('a'), second: leaf('b'), ratio: 0.5 }
      expect(removeLeaf(root, idOf, 'a')).toEqual(leaf('b'))
    })

    it('嵌套子树里的叶子：其所在 split 塌缩，外层保持骨架', () => {
      // root = [ a | (b | c) ]，删 b → 内层 split 塌成 c，外层变成 [ a | c ]。ratio/方向手写照抄原树。
      const root: Node = {
        type: 'split',
        direction: 'horizontal',
        first: leaf('a'),
        second: { type: 'split', direction: 'vertical', first: leaf('b'), second: leaf('c'), ratio: 0.3 },
        ratio: 0.5
      }
      expect(removeLeaf(root, idOf, 'b')).toEqual({
        type: 'split', direction: 'horizontal', first: leaf('a'), second: leaf('c'), ratio: 0.5
      })
    })

    it('root 本身就是要删的叶子：整棵树空了，返回 null', () => {
      expect(removeLeaf(leaf('only'), idOf, 'only')).toBeNull()
    })

    it('不在场的 id：原样返回结构相等的树', () => {
      const root: Node = {
        type: 'split',
        direction: 'horizontal',
        first: leaf('a'),
        second: { type: 'split', direction: 'vertical', first: leaf('b'), second: leaf('c'), ratio: 0.3 },
        ratio: 0.5
      }
      expect(removeLeaf(root, idOf, 'zzz')).toEqual({
        type: 'split',
        direction: 'horizontal',
        first: leaf('a'),
        second: { type: 'split', direction: 'vertical', first: leaf('b'), second: leaf('c'), ratio: 0.3 },
        ratio: 0.5
      })
    })

    it('钉住「纯递归」这个决定：同名 id 既是直接子叶又在兄弟子树里时，两份都删', () => {
      // 这是 removeLeaf JSDoc 里那条唯一会让「快捷路径」与「纯递归」分家的输入（本仓不可达，因为叶子 id
      // 互不相同）。这里刻意构造一次以钉死我们选了纯递归：root = [ dup | (dup | c) ]，删 dup。
      //   - 快捷路径（旧 workbench-layout 形状）：命中直接子叶就返回兄弟，结果 = [ dup | c ]（漏删兄弟里的）。
      //   - 纯递归（现采用）：两个 dup 都删，first 侧塌空 → 返回 second 侧塌缩后的结果 = 叶子 c。
      // 期望手写成 leaf('c')；若有人把快捷路径加回来，这条立刻变红。
      const root: Node = {
        type: 'split',
        direction: 'horizontal',
        first: leaf('dup'),
        second: { type: 'split', direction: 'vertical', first: leaf('dup'), second: leaf('c'), ratio: 0.5 },
        ratio: 0.5
      }
      expect(removeLeaf(root, idOf, 'dup')).toEqual(leaf('c'))
    })
  })
})

// ---------------------------------------------------------------------------
// 接线守卫：groupIds / regionIds 现在只是 SSOT 的**薄壳转发**。折叠后的风险不是内容错（内容已被上面
// 那族行为断言钉住），而是「壳还在不在执行、还是不是纯转发」——本仓 extracting-to-lib-only-fixes-half：
// 把逻辑抽进 lib 让内容可测了，但那层壳有没有被执行、是不是只转发，照旧无人守。所以这里用 TS parser 问
// 一个结构问题：这两个函数体是不是**恰好一句 return，且 return 的就是对 collectLeafIds 的调用、第二个
// 实参是本文件的叶子取值器**——没有第二条语句、没有分支、没有本地绑定。判据不是「源码里出现了
// collectLeafIds」（toContain 会被 import 行、注释、死赋值满足），而是「这个函数除了转发到 SSOT 之外
// 什么都不做」。每条都带自证，扫不到函数时不许恒绿。
// ---------------------------------------------------------------------------
const LIB = new URL('../src/renderer/src/lib/', import.meta.url)
const SSOT_FN = 'collectLeafIds'

/** 一个转发壳的形状分析结果。字段全部来自 AST，不看源码文本。 */
type ForwarderShape = {
  found: boolean
  statementCount: number
  isSingleReturn: boolean
  callsSsot: boolean
  argCount: number
  firstArgIsRootParam: boolean
  accessorArgName: string | null
  accessorForwardsField: string | null
}

function parseLib(relative: string): ts.SourceFile {
  const path = fileURLToPath(new URL(relative, LIB))
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

/** 顶层 `const <name> = (leaf...) => leaf.<field>` 的箭头体所访问的字段名（拿不到返回 null）。 */
function accessorField(file: ts.SourceFile, name: string): string | null {
  let field: string | null = null
  file.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return
    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || decl.name.text !== name) continue
      const init = decl.initializer
      if (init && ts.isArrowFunction(init) && ts.isPropertyAccessExpression(init.body)) {
        field = init.body.name.text
      }
    }
  })
  return field
}

function analyzeForwarder(relative: string, fnName: string): ForwarderShape {
  const file = parseLib(relative)
  let fn: ts.FunctionDeclaration | null = null
  file.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === fnName) fn = node
  })
  const shape: ForwarderShape = {
    found: false,
    statementCount: -1,
    isSingleReturn: false,
    callsSsot: false,
    argCount: -1,
    firstArgIsRootParam: false,
    accessorArgName: null,
    accessorForwardsField: null
  }
  if (!fn) return shape
  shape.found = true
  const decl = fn as ts.FunctionDeclaration
  const statements = decl.body?.statements ?? ts.factory.createNodeArray<ts.Statement>([])
  shape.statementCount = statements.length
  if (statements.length !== 1) return shape
  const only = statements[0]!
  if (!ts.isReturnStatement(only) || !only.expression || !ts.isCallExpression(only.expression)) return shape
  shape.isSingleReturn = true
  const call = only.expression
  shape.callsSsot = ts.isIdentifier(call.expression) && call.expression.text === SSOT_FN
  shape.argCount = call.arguments.length
  const rootParamName =
    decl.parameters[0] && ts.isIdentifier(decl.parameters[0].name) ? decl.parameters[0].name.text : null
  const firstArg = call.arguments[0]
  shape.firstArgIsRootParam =
    !!firstArg && ts.isIdentifier(firstArg) && firstArg.text === rootParamName && rootParamName !== null
  const secondArg = call.arguments[1]
  if (secondArg && ts.isIdentifier(secondArg)) {
    shape.accessorArgName = secondArg.text
    shape.accessorForwardsField = accessorField(file, secondArg.text)
  }
  return shape
}

describe('groupIds / regionIds 是且仅是 SSOT 的转发壳（接线守卫）', () => {
  const CASES = [
    { file: 'workbench-layout.ts', fn: 'groupIds', field: 'groupId' },
    { file: 'workbench-view-layout.ts', fn: 'regionIds', field: 'regionId' }
  ] as const

  it('自证：collectLeafIds 确实是 split-tree 导出的函数（判据的锚点不是幽灵）', () => {
    // 若 SSOT 换了名字而这里的 SSOT_FN 没跟上，下面每条 callsSsot 都会恒假——但那会红，不会假绿。
    // 这条把「锚点函数真实存在且可调用」正面钉住，顺带证明本测试文件 import 的 collectLeafIds 就是它。
    expect(typeof collectLeafIds).toBe('function')
    const ssot = parseLib('split-tree.ts')
    let exported = false
    ssot.forEachChild((node) => {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name?.text === SSOT_FN &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) exported = true
    })
    expect(exported, `split-tree.ts 未导出 ${SSOT_FN}——接线守卫的锚点不成立`).toBe(true)
  })

  it('自证：两个转发壳都被扫到了（扫不到函数时守卫不许恒绿）', () => {
    const foundCount = CASES.filter((c) => analyzeForwarder(c.file, c.fn).found).length
    expect(foundCount, '扫不到 groupIds / regionIds——判据的前提不成立，其余断言会恒真').toBe(CASES.length)
  })

  for (const { file, fn, field } of CASES) {
    it(`${file} 的 ${fn} 只有一句 return collectLeafIds(root, <${field} 取值器>)`, () => {
      const shape = analyzeForwarder(file, fn)
      expect(shape.found, `${file} 里找不到 ${fn}`).toBe(true)
      // 恰好一条语句、且是 return——排除「转发之后还偷偷做了别的」与「函数体被换成早退/别的实现」。
      expect(shape.statementCount, `${fn} 的函数体不是恰好一条语句`).toBe(1)
      expect(shape.isSingleReturn, `${fn} 的唯一语句不是 return 一个函数调用`).toBe(true)
      // 调的必须是 SSOT，不是别的同形函数。
      expect(shape.callsSsot, `${fn} 返回的调用不是 ${SSOT_FN}`).toBe(true)
      // 两个实参：root 参数本身 + 本文件的叶子取值器。
      expect(shape.argCount, `${fn} 传给 ${SSOT_FN} 的实参个数不是 2`).toBe(2)
      expect(shape.firstArgIsRootParam, `${fn} 的第一个实参不是它自己的 root 参数`).toBe(true)
      // 第二个实参是一个具名取值器，且那个取值器确实转发到本树的 id 字段（groupId / regionId）。
      expect(shape.accessorArgName, `${fn} 的第二个实参不是一个具名取值器标识符`).not.toBeNull()
      expect(
        shape.accessorForwardsField,
        `${fn} 传的取值器 ${shape.accessorArgName} 不是 (leaf) => leaf.${field}`
      ).toBe(field)
    })
  }
})
