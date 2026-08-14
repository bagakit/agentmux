import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Electron 主进程与 preload 不得 import「入口是未编译 TypeScript」的工作区依赖。
 *
 * ## 为什么这条会静默炸
 *
 * `electron.vite.config.ts` 给 main 和 preload 都挂了 `externalizeDepsPlugin()`：凡是列在
 * `apps/desktop/package.json` 的 `dependencies` 里的包，都**不打进产物**，而是留成运行时 `import`，
 * 由 Electron 自己的 Node 去解析。`@agentmux/core` 的 `main` 指向 `./dist/index.js`（已编译），没问题；
 * `@agentmux/layout` 的 `main` 指向 `./src/index.ts`——交给 Node 的是一份 **TypeScript 源码**。
 *
 * Node 24 能就地剥类型，所以它不是死在语法上，而是死在**模块解析**上。实测（仓内真环境，真 symlink）：
 *
 *   $ cd apps/desktop && node -e "import('@agentmux/layout')"
 *   ERR_MODULE_NOT_FOUND: Cannot find module '.../packages/layout/src/split-tree'
 *     imported from .../packages/layout/src/index.ts
 *
 * 因为 `layout/src/index.ts` 写的是 `export * from './split-tree'`（省略扩展名，靠打包器解析），而 ESM
 * 运行时不补扩展名。renderer 侧从来碰不到这个：Vite 把它当源码一起打包，扩展名由打包器补。
 *
 * 三道现有门禁全部看不见它：
 *   - `tsc`：desktop 的 `moduleResolution` 是 `Bundler`，省略扩展名本来就合法；
 *   - `vitest`：同样经打包器转换，解析规则和 Vite 一致；
 *   - 类型检查与单测都在**打包世界**里，而这条只在**运行时 ESM 世界**里成立。
 * 现形要等到起一个真的 Electron 主进程——也就是打包之后、开发机之外。
 *
 * ## 判据为什么是「入口是不是 .ts」而不是包名
 *
 * 写死「禁止 import @agentmux/layout」会在两头过期：layout 哪天加了构建步骤，这条禁令就变成拦住合法
 * 用法的噪音；而新加第二个 raw-source 包时它一句话都不会说。所以判据直接问每个依赖的 `package.json`：
 * 它交给 Node 的那个入口是不是未编译源码。layout 加了 build、`main` 指向 `dist/` 的那天，这条守卫自己
 * 就不再报它，不需要有人记得回来删名字。
 *
 * ## 为什么不改 layout 让它能被 Node 加载
 *
 * 试过：把 `'./split-tree'` 全部改写成 `'./split-tree.ts'` 后，经 pnpm 的 symlink 解析确实能 `import`
 * 成功（46 个导出）。但那要求 `allowImportingTsExtensions`，并把「主进程在生产环境里就地剥类型」变成
 * 一条真实依赖的运行路径——为一个今天没有消费者的能力，买一份长期的脆弱。layout 是渲染层的布局代数
 * （纯分屏树，零 UI/Agent 依赖），主进程本来就不该需要它。所以这里不是"修 layout"，而是把"它属于
 * 渲染层"这条本来就成立的架构事实写成可执行判据。真需要在主进程用它的那天，正确动作是给 layout 加
 * 构建步骤，那时本守卫自动放行。
 */

/** 仓根绝对路径。测试文件在 `apps/desktop/test/`，往上三层。 */
const REPOSITORY = resolve(new URL('../../../', import.meta.url).pathname)

/** 交给 Node 的入口是未编译 TypeScript 的工作区依赖：包名 → 它的入口路径（报错时要说清是哪一个）。 */
function rawSourceWorkspaceDependencies(): Map<string, string> {
  const desktop = JSON.parse(readFileSync(resolve(REPOSITORY, 'apps/desktop/package.json'), 'utf8'))
  const raw = new Map<string, string>()
  for (const [name, range] of Object.entries(desktop.dependencies ?? {})) {
    // 只有 workspace 依赖才可能是未编译源码；npm 上的包都是发布产物。
    if (typeof range !== 'string' || !range.startsWith('workspace:')) continue
    const manifestPath = resolve(REPOSITORY, 'packages', name.split('/').pop()!, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    // `exports` 优先于 `main`——Node 先看 exports。两处都取，任一是 .ts 就算未编译。
    const entries = [manifest.main, manifest.exports?.['.']?.import, manifest.exports?.['.']?.default]
    const source = entries.find((entry) => typeof entry === 'string' && /\.(ts|tsx|mts|cts)$/.test(entry))
    if (source !== undefined) raw.set(name, source)
  }
  return raw
}

/** 索引里 `apps/desktop/src/main/` 和 `src/preload/` 下的全部 TypeScript 源码（仓根相对路径）。 */
function nodeSideSources(): string[] {
  return execFileSync('git', ['ls-files', '-z', 'apps/desktop/src/main', 'apps/desktop/src/preload'], {
    cwd: REPOSITORY,
    maxBuffer: 16 * 1024 * 1024
  })
    .toString('utf8')
    .split('\0')
    .filter((path) => path.endsWith('.ts') || path.endsWith('.tsx'))
}

/**
 * 用 TypeScript 自己的 parser 取出一个文件的全部**裸模块**说明符（非相对路径的那些）。
 *
 * 不用 grep：本仓多处测试断言的**内容**长成 import 语句，按行匹配会把字符串字面量判成真 import。
 * 词法边界交给真词法器，与 `tracked-imports-resolve-in-index.test.ts` 同一理由、同一做法。
 */
function bareSpecifiers(path: string, text: string): { spec: string; line: number }[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
  const found: { spec: string; line: number }[] = []
  const take = (node: ts.Node | undefined): void => {
    if (node === undefined || !ts.isStringLiteralLike(node) || node.text.startsWith('.')) return
    found.push({ spec: node.text, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) take(node.moduleSpecifier)
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      take(node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** `@agentmux/layout` 与 `@agentmux/layout/x` 都算命中；`@agentmux/layout-extra` 不算。 */
function importsPackage(spec: string, name: string): boolean {
  return spec === name || spec.startsWith(`${name}/`)
}

describe('主进程与 preload 不 import 未编译源码的依赖', () => {
  const rawSource = rawSourceWorkspaceDependencies()
  const sources = nodeSideSources()

  it('至少有一个 raw-source 工作区依赖，否则这条判据今天没有靶子', () => {
    // 空集取胜的挡板。全部工作区包都加了构建步骤的那天，这条会红——那时删掉整个文件是正确动作，
    // 而不是让一条恒绿的守卫留在仓里冒充保护。
    expect(
      [...rawSource.keys()],
      '没有任何工作区依赖的入口是未编译 TypeScript，本守卫已无对象'
    ).not.toEqual([])
  })

  it('扫描面非空', () => {
    // 第二侧挡板：路径写错、目录改名时，下面那条会因为一个文件都没扫到而恒绿。
    expect(sources.length, 'main/preload 下一个源码文件都没扫到，判据没有生效').toBeGreaterThan(20)
  })

  it('main/preload 的每个文件都不 import 这些包（externalize 后 Electron 的 Node 加载不了）', () => {
    const violations: string[] = []
    for (const path of sources) {
      const text = readFileSync(resolve(REPOSITORY, path), 'utf8')
      for (const { spec, line } of bareSpecifiers(path, text)) {
        for (const [name, entry] of rawSource) {
          if (importsPackage(spec, name)) violations.push(`${path}:${line} import '${spec}'（入口 ${entry}）`)
        }
      }
    }

    expect(
      violations,
      '这些包会被 externalizeDepsPlugin 留成运行时 import，而它们的入口是未编译 TypeScript——' +
        'Electron 主进程起不来（ERR_MODULE_NOT_FOUND），且 tsc 与 vitest 都看不见。' +
        '要在主进程用它，先给那个包加构建步骤让 main 指向 dist/。'
    ).toEqual([])
  })
})
