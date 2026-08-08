import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { refreshFileExplorer } from '../src/renderer/src/components/file-tree/file-explorer-refresh.js'

/**
 * 守的缺陷（#750）：文件树的 git 着色在**首次取数之后永不刷新**。
 *
 * `useGitStatus` 只在挂载时的 effect 里取一次 porcelain，此后要靠调用方主动调它返回的 `refresh`。
 * ChangesPanel 每个写操作后都调，而 FileExplorer **连解构都没解构它**（`const { status: gitStatus }`），
 * 于是五个刷新触发点（revision 变化、窗口重获焦点、重绑 workspace 路径、头部刷新按钮、读失败重试）
 * 一律只重扫目录结构。症状：agent 在盘上改了一堆文件，树里新文件都出现了，颜色却停在打开面板那一刻，
 * 且用户**没有任何入口**能把它推回同步——只能关掉整个 Explorer 再打开。
 *
 * 修法不是在树的刷新后面顺手加一句 git，而是把「刷新 Explorer」收成一个动作
 * （`file-explorer-refresh.ts`）：要么两半都刷，要么一半都不刷，没有第三种。理由与 #271
 * （失效计数器被手抄五份）同形——分散的调用点各自决定刷什么，漏掉的那一份完全静默。
 *
 * ---
 * 这个文件交付**成对**的两层判据，各自能被不同的变异杀掉，两层缺一不可：
 *
 * 【行为层】`refreshFileExplorer` 真的两个都调、并发调、且结构那半边失败时不跳过 git 那半边。
 *   它对「壳里有没有人调这个函数」完全失明——把 FileExplorer 的五个调用点全换回
 *   `tree.refreshTree()`，行为层照旧全绿（记忆 extracting-to-lib-only-fixes-half）。
 *
 * 【接线层】FileExplorer.tsx 里两个半边**都不许被直接调用**，只有合成出来的那个刷新器可以调；
 *   而它对「那个函数体是不是空的」完全失明。
 *
 * 接线层为什么必须落在 AST 上而不是文本上：本文件与生产注释里都**正当地**写着
 * `tree.refreshTree()` 这串字（在讲那次事故是什么样的），一个 `toContain` 形状的判据会对它们发假红，
 * 而假红久了必被加豁免、豁免再吃掉真缺陷（记忆 lexical-boundaries-need-a-real-lexer）。
 *
 * 接线层为什么不能用挂载测试：这个仓没有 jsdom，`renderToStaticMarkup` 不跑 useEffect
 * （记忆 render-to-static-markup-blind-to-effects），而 #750 的主路径就是一个 effect。
 */

// ---------------------------------------------------------------------------
// 行为层
// ---------------------------------------------------------------------------
describe('refreshFileExplorer 把两个半边合成一个动作', () => {
  it('两个来源都被调用', async () => {
    const refreshTree = vi.fn(async () => true)
    const refreshGitStatus = vi.fn(async () => true)
    await refreshFileExplorer({ refreshTree, refreshGitStatus })
    expect(refreshTree).toHaveBeenCalledTimes(1)
    expect(refreshGitStatus).toHaveBeenCalledTimes(1)
  })

  it('结构重扫返回 false 时，git 那半边照旧要刷', async () => {
    // `refreshTree` 返回 false 是**正常**的一种结局（workspace 作用域已经换过、根目录读失败），
    // 不是"整次刷新失败"。写成 `if (!await refreshTree()) return` 的短路版本在上面那条用例里
    // 完全无法区分，所以这一条单独立：两者的失效条件不同，git 那半边不该被结构那半边的结局挟持。
    const refreshTree = vi.fn(async () => false)
    const refreshGitStatus = vi.fn(async () => true)
    await refreshFileExplorer({ refreshTree, refreshGitStatus })
    expect(refreshGitStatus).toHaveBeenCalledTimes(1)
  })

  it('两次取数并发发起，不是串起来等两个往返', async () => {
    // 判据落在**调用顺序**上而不是墙钟上：串行版本里 git 那半边要等 tree 的 promise resolve 之后
    // 才会被调，于是在 tree 还挂着的时刻 order 只有 ['tree']。远端 workspace 上一次 files:readDirectory
    // 可达数秒，串起来就是把每次刷新的代价翻倍。
    const order: string[] = []
    let releaseTree: ((value: boolean) => void) | undefined
    const refreshTree = () => {
      order.push('tree')
      return new Promise<boolean>((resolve) => { releaseTree = resolve })
    }
    const refreshGitStatus = async () => {
      order.push('git')
      return true
    }

    const settled = refreshFileExplorer({ refreshTree, refreshGitStatus })
    await Promise.resolve()
    expect(order, 'git 那半边在 tree 还没 resolve 时就该已经发出去了').toEqual(['tree', 'git'])

    releaseTree?.(true)
    await settled
  })

  it('任一半边抛出时如实拒绝，不静默咽掉', async () => {
    // 刻意用 Promise.all 而不是 allSettled：两个来源今天都在自己内部吞异常并以 boolean 汇报，
    // 哪天其中一个开始真的抛，`await` 的调用点（rebindWorkspacePath 的 try/catch）该如实报出来。
    // allSettled 会把那一天变成又一次静默。
    const boom = new Error('git bridge is gone')
    await expect(refreshFileExplorer({
      refreshTree: async () => true,
      refreshGitStatus: async () => { throw boom }
    })).rejects.toBe(boom)
  })
})

// ---------------------------------------------------------------------------
// 接线层
// ---------------------------------------------------------------------------

/** 这次调用读的属性名（`a.b.c()` → `c`），不是属性访问就给空串。 */
function calleePropertyName(call: ts.CallExpression): string {
  return ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : ''
}

/** 这次调用的被调者是个裸标识符时给它的名字（`f()` → `f`），否则空串。 */
function calleeIdentifierName(call: ts.CallExpression): string {
  return ts.isIdentifier(call.expression) ? call.expression.text : ''
}

type WiringFacts = {
  /** 直接调用两个半边的位置（行号 + 写法），一个都不该有。 */
  directHalfCalls: { line: number; text: string }[]
  /** `useGitStatus(...)` 的解构里 `refresh` 被绑成了什么名字。缺席则为 null。 */
  gitRefreshBinding: string | null
  /** `refreshFileExplorer({...})` 每次调用传进去的两个键各自的取值写法。 */
  combinedCallArguments: { refreshTree: string | null; refreshGitStatus: string | null }[]
  /** 依赖数组里点名 `workspaceFileRevision` 的那些 useEffect，各自体内调了哪些裸函数。 */
  revisionEffectCalls: string[][]
  /** 扫描面自检：`refreshTree` 这个名字在这个文件里总共出现几次（含合法的属性传递）。 */
  refreshTreeMentions: number
}

/**
 * 把接线事实从源码里提取出来，供下面每条断言各自质询。
 *
 * 提取器独立成函数（而不是把断言直接写在遍历里），是为了让「判据自检」能拿合成源码喂它：
 * 一个坏掉的提取器会让整族守卫静默恒绿，而恒绿的守卫比没有守卫更贵
 * （记忆 forbidden-shape-guard-misfires）。
 */
function collectWiringFacts(sourceText: string): WiringFacts {
  const source = ts.createSourceFile('FileExplorer.tsx', sourceText, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
  const facts: WiringFacts = {
    directHalfCalls: [],
    gitRefreshBinding: null,
    combinedCallArguments: [],
    revisionEffectCalls: [],
    refreshTreeMentions: 0
  }
  const lineOf = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'refreshTree') facts.refreshTreeMentions += 1

    // `const { status: gitStatus, refresh: refreshGitStatus } = useGitStatus(...)`
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      calleeIdentifierName(node.initializer) === 'useGitStatus' &&
      ts.isObjectBindingPattern(node.name)
    ) {
      for (const element of node.name.elements) {
        const sourceKey = element.propertyName ?? element.name
        if (ts.isIdentifier(sourceKey) && sourceKey.text === 'refresh' && ts.isIdentifier(element.name)) {
          facts.gitRefreshBinding = element.name.text
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const property = calleePropertyName(node)
      const identifier = calleeIdentifierName(node)

      // 直接调用结构那半边（`tree.refreshTree()`、`refreshTree()`）或 git 那半边
      // （`refreshGitStatus()`，名字由上面的解构决定）。判「调用」而不是「提到」，所以
      // 对象字面量里 `refreshTree: tree.refreshTree` 这种**传递**不会命中。
      const callsTreeHalf = property === 'refreshTree' || identifier === 'refreshTree'
      const callsGitHalf = facts.gitRefreshBinding !== null && identifier === facts.gitRefreshBinding
      if (callsTreeHalf || callsGitHalf) {
        facts.directHalfCalls.push({ line: lineOf(node), text: node.getText(source) })
      }

      if (identifier === 'refreshFileExplorer') {
        const [argument] = node.arguments
        const keys: { refreshTree: string | null; refreshGitStatus: string | null } = {
          refreshTree: null,
          refreshGitStatus: null
        }
        if (argument && ts.isObjectLiteralExpression(argument)) {
          for (const property of argument.properties) {
            const name = property.name && ts.isIdentifier(property.name) ? property.name.text : ''
            if (name !== 'refreshTree' && name !== 'refreshGitStatus') continue
            // 简写（`refreshGitStatus`）与显式赋值（`refreshTree: tree.refreshTree`）都要认，
            // 只认一种会让另一种写法的接线免检。
            if (ts.isShorthandPropertyAssignment(property)) keys[name] = name
            else if (ts.isPropertyAssignment(property)) keys[name] = property.initializer.getText(source)
          }
        }
        facts.combinedCallArguments.push(keys)
      }

      if (identifier === 'useEffect') {
        const [body, deps] = node.arguments
        const namesDeps =
          deps !== undefined &&
          ts.isArrayLiteralExpression(deps) &&
          deps.elements.some((element) => ts.isIdentifier(element) && element.text === 'workspaceFileRevision')
        if (namesDeps && body) {
          const called: string[] = []
          const walkBody = (inner: ts.Node): void => {
            if (ts.isCallExpression(inner)) {
              const name = calleeIdentifierName(inner)
              if (name) called.push(name)
            }
            ts.forEachChild(inner, walkBody)
          }
          walkBody(body)
          facts.revisionEffectCalls.push(called)
        }
      }
    }

    ts.forEachChild(node, visit)
  }
  visit(source)
  return facts
}

describe('FileExplorer 的每个刷新触发点都走合成刷新器', () => {
  const explorerPath = new URL('../src/renderer/src/components/FileExplorer.tsx', import.meta.url)
  const facts = collectWiringFacts(readFileSync(explorerPath, 'utf8'))

  it('前提自检：提取器认得出直接调用，判据没有挂在空处', () => {
    // 没有这条，提取器写坏（比如属性名拼错）会让下面「一个都没有」静默变成恒真。
    // 逐种拼法各给一个样本：`tree.refreshTree()` 是事故现场的原样，裸 `refreshTree()` 是抽出
    // 局部别名后的写法，`refreshGitStatus()` 是反方向那半边（只刷 git 不刷结构的镜像缺陷）。
    const probe = collectWiringFacts([
      `const { refresh: refreshGitStatus } = useGitStatus(id)`,
      `void tree.refreshTree()`,
      `void refreshTree()`,
      `void refreshGitStatus()`
    ].join('\n'))
    expect(probe.directHalfCalls.map((entry) => entry.text)).toEqual([
      'tree.refreshTree()',
      'refreshTree()',
      'refreshGitStatus()'
    ])
  })

  it('反向自证：把半边**传递**给合成器不算一次直接调用', () => {
    // 允许清单收窄之后，必须有人证明它没有把合法形状一起收进来——否则生产代码里那一处正当的
    // `refreshTree: tree.refreshTree` 会被判红，而假红的唯一去处是豁免。
    const probe = collectWiringFacts([
      `const { refresh: refreshGitStatus } = useGitStatus(id)`,
      `refreshFileExplorer({ refreshTree: tree.refreshTree, refreshGitStatus })`
    ].join('\n'))
    expect(probe.directHalfCalls).toEqual([])
  })

  it('前提自检：扫描面非空——refreshTree 这个名字确实出现在这个文件里', () => {
    // 把生产代码里的 `refreshTree` 整个改名（或整段删掉），上面那条「一个都没有」会变成恒真。
    // 这条把"名字还在场"做成断言，让那种情况红在这里而不是静默通过。
    expect(facts.refreshTreeMentions).toBeGreaterThan(0)
  })

  it('两个半边都不被直接调用', () => {
    const offenders = facts.directHalfCalls.map((entry) => `:${entry.line} ${entry.text}`)
    expect(offenders, '刷新触发点绕过了合成刷新器，漏掉的那一半是静默的').toEqual([])
  })

  it('useGitStatus 的 refresh 被解构出来了', () => {
    // #750 的成因就在这一行：`const { status: gitStatus }` 根本没取 refresh，于是整个组件里
    // 没有任何东西能重取 git 状态。
    expect(facts.gitRefreshBinding).not.toBeNull()
  })

  it('合成器拿到的 git 半边就是 useGitStatus 解构出来的那个，不是另一个函数', () => {
    // 只判「有 refreshGitStatus 这个键」会被 `refreshGitStatus: async () => true` 满足——
    // 键在场而取值是个跟 git 毫无关系的东西，颜色照旧永不更新。所以判取值**就是**那个绑定
    // （记忆 optional-prop-only-buys-silence：接线层要按 AST 判「值就是那次取值」）。
    expect(facts.combinedCallArguments.length).toBeGreaterThan(0)
    for (const call of facts.combinedCallArguments) {
      expect(call.refreshGitStatus).toBe(facts.gitRefreshBinding)
      expect(call.refreshTree, '结构那半边也要真的接上，不能只接 git 那半边').toMatch(/\brefreshTree$/u)
    }
  })

  it('revision 变化那条 effect 真的调了合成刷新器', () => {
    // #750 的主路径。判「那条路径上真的调了它」而不是「文件里 import 了它」：import 在场而
    // effect 里仍写着 `tree.refreshTree()` 是这个缺陷本来的形状。
    expect(facts.revisionEffectCalls.length, '没找到依赖 workspaceFileRevision 的 effect，判据挂在空处').toBeGreaterThan(0)
    for (const called of facts.revisionEffectCalls) {
      expect(called).toContain('refreshExplorer')
    }
  })
})
