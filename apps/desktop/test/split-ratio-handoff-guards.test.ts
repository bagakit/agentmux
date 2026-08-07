import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * split-tree.ts 的 `clampSplitRatio` 注释里有一段**关于别的文件长什么样**的断言：两棵分屏树的兜底位置
 * 不一样——tab-group 那侧渲染层自己夹一次，region 那侧把树里的值裸着交出去。这段话决定了「新增一个写
 * ratio 的地方要不要自己夹」，而它此前只是散文：#578 就是它变假之后没人发现（#595 让分屏提交器自己夹了，
 * 于是「最薄一处是提交器的构造参数」这句结论过期）。同一段话在 workbench-layout.ts 里还有第二份手抄。
 *
 * 本文件把那段话变成判据。它守的是**取值来源**，两个方向都要红：
 *
 * - tab-group 那侧不再夹了 → 注释的前半句变假；
 * - region 那侧开始夹了 → 注释的后半句变假，而且此时那两份手抄同时说谎。
 *
 * 判据落在 AST 上而不是行号上，理由不是洁癖：这两个函数所在的组件是并发热点，注释里写死行号的锚点
 * 在别人提交的那一刻就漂了（本仓这一族已复发 8 次，见 #600）。所以注释里点的是**函数名**，
 * 由本文件负责把名字翻译成位置。本文件自己也不写行号：`findFunction` 按名字定位，交接口按 AST
 * 节点类型枚举。
 *
 * **盲点（必须写明，别把这三条读成已经守住）**：
 *
 * 1. 这是结构守卫，不执行组件。「这两个 `<Panel>` 真的被渲染出来了吗」不在它的射程内——本仓
 *    renderToStaticMarkup 连 effect 都不跑。
 * 2. 它不知道 react-resizable-panels 拿到 `defaultSize={NaN}` 会怎样。那件事本仓没验过，所以
 *    split-tree.ts 那段注释也只敢说「无人守」，没替它编一个症状。
 * 3. 它只看这两个函数体。把某个交接搬进外层 helper 会让它看不见——那正是下面两条「恰好各 4 个交接口」
 *    的断言在挡的事：搬走一个就少一个，红在计数上而不是静默变绿。
 *
 * `latestRatio` 那一侧刻意不在这里守：#595 的五条行为测试已经按操作数把它钉住了（变异 D「两个赋值
 * 分岔」实测同时打红两条），再加一道结构判据只会多贡献假阴性。
 */

const CLAMP = 'clampSplitRatio'
const COMMITTER_CLASS = 'SplitRatioCommitter'
const SYNC_METHOD = 'synchronizePersistedRatio'

/** region 树的分屏渲染函数（裸着交那一侧）。 */
const REGION_BRANCH = 'WorkbenchRegionBranch'
/** tab-group 树的分屏渲染函数（渲染层自己夹那一侧）。 */
const TABGROUP_BRANCH = 'SplitBranch'

function parse(relative: string, kind: ts.ScriptKind): ts.SourceFile {
  const path = fileURLToPath(new URL(relative, import.meta.url))
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, kind)
}

const COMPONENT = parse('../src/renderer/src/components/WorkspaceWorkbench.tsx', ts.ScriptKind.TSX)
const COMMITTER = parse('../src/renderer/src/lib/split-ratio-commit.ts', ts.ScriptKind.TS)

function findFunction(file: ts.SourceFile, name: string): ts.FunctionDeclaration | null {
  let found: ts.FunctionDeclaration | null = null
  file.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node
  })
  return found
}

/** 这个函数体里由 `const X = clampSplitRatio(...)` 绑定出来的名字。 */
function clampedLocals(scope: ts.Node): ReadonlySet<string> {
  const names = new Set<string>()
  const walk = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === CLAMP
    ) {
      names.add(node.name.text)
    }
    ts.forEachChild(node, walk)
  }
  walk(scope)
  return names
}

type Sink = 'panel' | 'committer-ctor' | 'committer-sync'
type Handoff = { sink: Sink; operand: string; clamped: boolean }

/**
 * 一个函数体里**所有**把比例交出去的地方，按接收方分类。三种接收方就是那段注释点到的三种：
 * `<Panel defaultSize>`（第三方库）、提交器的构造参数、提交器的同步入口。
 *
 * `clamped` 判的是「这个操作数的取值里出现过夹取」——直接调 `clampSplitRatio(...)`，或者读一个由它
 * 绑定出来的局部名。所以 `(1 - ratio) * 100` 这种算术不会被误判成裸的。
 */
function ratioHandoffs(scope: ts.Node): readonly Handoff[] {
  const clamped = clampedLocals(scope)
  const mentionsClamp = (node: ts.Node): boolean => {
    let hit = false
    const walk = (inner: ts.Node): void => {
      if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === CLAMP) {
        hit = true
      }
      if (ts.isIdentifier(inner) && clamped.has(inner.text)) hit = true
      ts.forEachChild(inner, walk)
    }
    walk(node)
    return hit
  }

  const out: Handoff[] = []
  const record = (sink: Sink, operand: ts.Expression): void => {
    out.push({ sink, operand: operand.getText(), clamped: mentionsClamp(operand) })
  }
  const walk = (node: ts.Node): void => {
    if (
      ts.isJsxAttribute(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'defaultSize' &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression
    ) {
      record('panel', node.initializer.expression)
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === COMMITTER_CLASS &&
      node.arguments?.[0]
    ) {
      record('committer-ctor', node.arguments[0]!)
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === SYNC_METHOD &&
      node.arguments[0]
    ) {
      record('committer-sync', node.arguments[0]!)
    }
    ts.forEachChild(node, walk)
  }
  walk(scope)
  return out
}

describe('两棵分屏树的 ratio 兜底位置（#578：split-tree.ts 那段注释的判据）', () => {
  it('自证：两个分屏渲染函数都在，且组件真的 import 了 clampSplitRatio', () => {
    // 这一条是防恒绿的地板。函数被改名／夹取函数被换掉时，下面几条会因为「一个交接口都没找到」而
    // 空集通过——所以先把锚点本身做成断言。
    expect(findFunction(COMPONENT, REGION_BRANCH)).not.toBeNull()
    expect(findFunction(COMPONENT, TABGROUP_BRANCH)).not.toBeNull()
    const imported = COMPONENT.statements.some(
      (node) =>
        ts.isImportDeclaration(node) &&
        node.importClause?.namedBindings !== undefined &&
        ts.isNamedImports(node.importClause.namedBindings) &&
        node.importClause.namedBindings.elements.some((el) => el.name.text === CLAMP)
    )
    expect(imported).toBe(true)
  })

  it('region 侧四个交接口全部裸着交（注释的后半句）', () => {
    const handoffs = ratioHandoffs(findFunction(COMPONENT, REGION_BRANCH)!)
    // 恰好 4 个：两个 <Panel defaultSize>、构造参数、同步入口。数目本身是判据——搬走一个或新增一个
    // 都要有人回来读这段注释，因为「新增写入点要不要自己夹」的答案在这一侧是「要」。
    expect(handoffs).toHaveLength(4)
    expect(handoffs.filter((h) => h.sink === 'panel')).toHaveLength(2)
    expect(handoffs.filter((h) => h.sink === 'committer-ctor')).toHaveLength(1)
    expect(handoffs.filter((h) => h.sink === 'committer-sync')).toHaveLength(1)
    // 逐个质询，而不是抽一个：这一侧成立的前提是**每一个**都没夹。
    for (const handoff of handoffs) {
      expect({ sink: handoff.sink, operand: handoff.operand, clamped: handoff.clamped }).toEqual({
        sink: handoff.sink,
        operand: handoff.operand,
        clamped: false
      })
    }
  })

  it('tab-group 侧四个交接口全部夹过（注释的前半句）', () => {
    const handoffs = ratioHandoffs(findFunction(COMPONENT, TABGROUP_BRANCH)!)
    expect(handoffs).toHaveLength(4)
    expect(handoffs.filter((h) => h.sink === 'panel')).toHaveLength(2)
    expect(handoffs.filter((h) => h.sink === 'committer-ctor')).toHaveLength(1)
    expect(handoffs.filter((h) => h.sink === 'committer-sync')).toHaveLength(1)
    for (const handoff of handoffs) {
      expect({ sink: handoff.sink, operand: handoff.operand, clamped: handoff.clamped }).toEqual({
        sink: handoff.sink,
        operand: handoff.operand,
        clamped: true
      })
    }
  })

  it('region 侧交给提交器的那两个，被调方自己夹（#595 让「裸着交」在这条路上不构成漏点）', () => {
    // 注释里「后两处的被调方自己夹」这半句的判据。按**赋值出口**枚举而不是数 clampSplitRatio 出现
    // 几次：写 persistedRatio 的地方只许是两种形状——夹取调用的结果，或者 commitLatest 里那次
    // `= this.latestRatio`（latestRatio 已在它自己的入口归一化过，见类注释）。新增第四个写入点而
    // 忘了夹，就落不进这两种形状里。
    const writes: string[] = []
    const walk = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) &&
        node.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
        node.left.name.text === 'persistedRatio'
      ) {
        const right = node.right
        const viaClamp =
          ts.isCallExpression(right) && ts.isIdentifier(right.expression) && right.expression.text === CLAMP
        const viaLatest =
          ts.isPropertyAccessExpression(right) &&
          right.expression.kind === ts.SyntaxKind.ThisKeyword &&
          right.name.text === 'latestRatio'
        writes.push(viaClamp ? 'clamped' : viaLatest ? 'this.latestRatio' : `unguarded:${right.getText()}`)
      }
      ts.forEachChild(node, walk)
    }
    walk(COMMITTER)
    // 三个写入点：构造参数、同步入口、死区提交。前两个必须夹，第三个必须是那次转写。
    expect(writes.slice().sort()).toEqual(['clamped', 'clamped', 'this.latestRatio'])
  })
})
