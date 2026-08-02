import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

/**
 * preload 暴露的每一片能力，渲染层都必须真的调用。
 *
 * `ipc-parity.test.ts` 守的是**上一段缝**：main 的注册面 ↔ preload 的 invoke 面。那道门通了之后，
 * 一条能力仍然可以完整地一路铺到 `window.agentmux` 然后无人使用——三层齐备、零消费者。这一族在本仓
 * 复发过多次：git 的 6/10 个写方法（#206）、整座开 PR 子系统（#207）、`git.aheadBehind`（#334）、
 * `terminal-search` 的 addon 订阅（#164）。每一次的形状都一样：实现、注册、暴露都在场且各自有测试，
 * 只有「谁调它」缺席，而**没有任何东西会红**——preload 那一侧是个对象字面量，多一个属性永远合法。
 *
 * 这道门建立时实测出一条死线：`gh.authStatus`。main 有实现（`gh-service.ts`，四条测试）、IPC 注册、
 * preload 暴露俱全，渲染层只用 `prReadiness`；而 `PrReadiness` 的注释正写明它就是为取代
 * 「`gh.authStatus` / `git.status` / `git.aheadBehind` 三次独立 await」而存在的。所以那不是漏接线，
 * 是取代之后没删——一条被自己的替代者作废的能力，在门外活了下来。
 *
 * 判据为什么必须走类型检查器，而不是按名字匹配：
 *   `getSymbolAtLocation` 给出的是**这个取值位真正解析到的那个声明**。按名字数会把 `seen.add`
 *   当成 `workspaces.add` 的消费者，把 `controllers.get` 当成 `config.get`，把 `regionIds.push`
 *   当成注册面的一次调用。这不是理论风险：本仓实测有 32 个叶子名字在渲染层存在**同名但不同源**的
 *   取值位，名字匹配数出 643 次，符号身份只认 164 次——四倍的假消费者，足以让任何一条死线蒙混过关。
 *
 * 它同时穿透 `lib/api.ts` 与 `lib/control-api.ts` 那两层适配器：`control.respond` /
 * `onCancellation` 只被 `control-api.ts` 调，而它是渲染层的一等消费者。按语法猜的判据会把这三片
 * 误报成死线，然后被人加进豁免清单——豁免一旦存在，真死线也会往里躲。这里一条豁免都没有。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP = path.resolve(HERE, '..')
const RENDERER_ROOT = path.join(DESKTOP, 'src/renderer/src')
const CONTRACTS = path.join(DESKTOP, 'src/shared/contracts.ts')
const PRELOAD = path.join(DESKTOP, 'src/preload/index.ts')

/** 渲染层的每个 .ts/.tsx。程序要一次性建齐，否则跨文件的取值位解析不出符号。 */
function rendererSources(dir = RENDERER_ROOT): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...rendererSources(full))
    else if (/\.tsx?$/.test(full)) out.push(full)
  }
  return out
}

type Leaf = { key: string; symbol: ts.Symbol }

type Surface = {
  program: ts.Program
  checker: ts.TypeChecker
  /** 契约里 `AgentMuxPreloadApi` 的每一片能力：`group.method` → 它的声明符号。 */
  leaves: Leaf[]
  /** 每片能力被哪些渲染层文件调用（相对 renderer 根的路径）。 */
  consumers: Map<string, Set<string>>
}

let cached: Surface | null = null

/** 建一次程序，四条断言共用——每条各建一次要多花好几秒。 */
function surface(): Surface {
  if (cached) return cached
  const files = rendererSources()
  const program = ts.createProgram([...files, CONTRACTS], {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    skipLibCheck: true,
    noEmit: true
  })
  const checker = program.getTypeChecker()

  const contracts = program.getSourceFiles().find((file) => file.fileName === CONTRACTS.replace(/\\/g, '/'))
    ?? program.getSourceFiles().find((file) => file.fileName.endsWith('shared/contracts.ts'))
  expect(contracts, 'contracts.ts 没进程序——判据的取值源缺席').toBeTruthy()

  const declarations: ts.TypeAliasDeclaration[] = []
  ts.forEachChild(contracts!, (node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === 'AgentMuxPreloadApi') declarations.push(node)
  })
  // 恰好一个：契约改名或拆成两个声明时，是这一条先红，而不是叶子集合静默变空。
  expect(declarations, 'contracts.ts 里 AgentMuxPreloadApi 应当恰好有一个声明').toHaveLength(1)
  const alias = declarations[0]!

  const apiType = checker.getTypeAtLocation(alias.name)
  const leaves: Leaf[] = []
  for (const group of checker.getPropertiesOfType(apiType)) {
    const groupType = checker.getTypeOfSymbolAtLocation(group, alias)
    for (const member of checker.getPropertiesOfType(groupType)) {
      leaves.push({ key: `${group.getName()}.${member.getName()}`, symbol: member })
    }
  }

  const bySymbol = new Map<ts.Symbol, string>(leaves.map((leaf) => [leaf.symbol, leaf.key]))
  const consumers = new Map<string, Set<string>>()
  for (const source of program.getSourceFiles()) {
    if (!source.fileName.includes('/renderer/src/')) continue
    const relative = path.relative(RENDERER_ROOT, source.fileName)
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node)) {
        const key = leafKeyOf(checker, bySymbol, node)
        if (key) {
          const seen = consumers.get(key) ?? new Set<string>()
          seen.add(relative)
          consumers.set(key, seen)
        }
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(source, visit)
  }

  cached = { program, checker, leaves, consumers }
  return cached
}

/**
 * 这个取值位读的是哪一片契约能力——没有就返回 null。
 *
 * 走 `getSymbolAtLocation` 而不是比名字：符号是「这个位置解析到的那个声明」，与拼法无关也与同名者
 * 无关。re-export 会包一层 alias，所以要先解到本体。
 */
function leafKeyOf(
  checker: ts.TypeChecker,
  bySymbol: Map<ts.Symbol, string>,
  node: ts.PropertyAccessExpression
): string | null {
  const found = checker.getSymbolAtLocation(node.name)
  if (!found) return null
  const target = (found.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(found) : found
  return bySymbol.get(target) ?? null
}

/** preload 那个 `api` 对象字面量真正装上的叶子。 */
function preloadLiteralLeaves(source = readFileSync(PRELOAD, 'utf8')): string[] {
  const ast = ts.createSourceFile('preload.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'api' &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const group of node.initializer.properties) {
        if (!ts.isPropertyAssignment(group) || !ts.isObjectLiteralExpression(group.initializer)) continue
        for (const member of group.initializer.properties) {
          if (!member.name) continue
          out.push(`${group.name.getText(ast)}.${member.name.getText(ast)}`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(ast, visit)
  return out
}

describe('preload ↔ renderer 的对齐（对象字面量多一个属性永远合法，故 tsc 不会红）', () => {
  it('提取器都取到了东西——判据不能落空', () => {
    // 叶子集合为空会让下面「每片都有人调」变成恒真：空集合上的循环一次都不跑。契约重构成别的形状时，
    // 是这一条先红，而不是死线检测静默变成空转。
    const { leaves, consumers } = surface()
    expect(leaves.length, '契约里一片能力都没取到——AgentMuxPreloadApi 的形状变了').toBeGreaterThan(80)
    expect(consumers.size, '渲染层一次调用都没解析到——符号解析整体失效了').toBeGreaterThan(80)
    // 叶子名不许重复：`group.method` 撞名会让两片能力共用一条记录，其中一片死了也看不出来。
    expect(new Set(leaves.map((leaf) => leaf.key)).size).toBe(leaves.length)
  })

  it('契约声明的每一片，preload 都真的装上了（两侧互为全集）', () => {
    // 只查一侧不够：契约声明了而 preload 没装 → `window.agentmux.x.y` 是 undefined，tsc 却因为
    // `api` 标了 `AgentMuxPreloadApi` 而放过不了……实际上会红。反过来才是静默的那一侧：preload 多装
    // 一片契约没声明的，对象字面量的多余属性在这个位置合法，于是那片能力永远不会被下面那条门看见。
    const declared = new Set(surface().leaves.map((leaf) => leaf.key))
    const installed = new Set(preloadLiteralLeaves())
    expect([...declared].filter((key) => !installed.has(key)), '契约声明了但 preload 没装').toEqual([])
    expect([...installed].filter((key) => !declared.has(key)), 'preload 装了但契约没声明').toEqual([])
  })

  it('preload 暴露的每一片能力，渲染层都真的调用', () => {
    // 一条豁免都没有——包括穿过 `lib/api.ts` 与 `lib/control-api.ts` 两层适配器的那几片。符号身份
    // 认得出适配器里的调用就是调用；一旦这里开始需要豁免清单，真死线就会往清单里躲。
    const { leaves, consumers } = surface()
    const dead = leaves.map((leaf) => leaf.key).filter((key) => !consumers.has(key))
    expect(dead, 'preload 暴露了但渲染层零调用——接上它，或者连同 IPC 注册与契约声明一起删掉').toEqual([])
  })

  it('自检：判据按符号身份判，不按名字——同名不同源不算消费者', () => {
    // 这条守的是守卫自己，而且守的正是它最容易被写坏的那一处。
    //
    // 若判据退化成「名字在叶子名集合里就算被调」，`seen.add` 会冒充 `workspaces.add`、
    // `controllers.get` 会冒充 `config.get`、`regionIds.push` 会冒充一次注册调用。本仓实测有 32 个
    // 叶子名存在这样的同名者，名字匹配数出的调用比符号身份多四倍——足以让任何一条真死线蒙混过关。
    //
    // 断言落在**严格小于**上而不是某个具体数字：数字会随渲染层增删漂移，而「符号身份必须比名字匹配
    // 更严」是这道门的性质本身。
    const { program, checker, leaves } = surface()
    const bySymbol = new Map<ts.Symbol, string>(leaves.map((leaf) => [leaf.symbol, leaf.key]))
    const leafNames = new Set(leaves.map((leaf) => leaf.key.split('.')[1]!))
    let byName = 0
    let bySymbolCount = 0
    const impostors = new Set<string>()
    for (const source of program.getSourceFiles()) {
      if (!source.fileName.includes('/renderer/src/')) continue
      const visit = (node: ts.Node): void => {
        if (ts.isPropertyAccessExpression(node) && leafNames.has(node.name.text)) {
          byName += 1
          if (leafKeyOf(checker, bySymbol, node) === null) impostors.add(node.name.text)
          else bySymbolCount += 1
        }
        ts.forEachChild(node, visit)
      }
      ts.forEachChild(source, visit)
    }
    expect(bySymbolCount, '符号身份一次都没认出来——解析整体失效').toBeGreaterThan(0)
    expect(bySymbolCount).toBeLessThan(byName)
    // 且同名冒充者确实在场：没有它们时上面那条不等式无从成立，这条把前提本身钉住。
    expect(impostors.size, '渲染层里应当存在与叶子同名但不同源的取值位').toBeGreaterThan(0)
  })
})
