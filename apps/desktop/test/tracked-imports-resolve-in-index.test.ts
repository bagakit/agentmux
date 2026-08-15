import { execFileSync, spawnSync } from 'node:child_process'
import { posix, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * 已入库的源码，每一条相对 import 都必须解析到**同样已入库**的东西。
 *
 * 来由：`packages/core/src/client.ts:24` 曾 `import { runBoundedReconnect } from './ctxmux-reconnect.js'`，
 * 而那个文件从未 `git add` 过——`git ls-tree HEAD packages/core/src/` 里没有它。于是 `git clone` 出来的
 * 仓库编译不出来，而本机 `tsc --noEmit` 干净：工作树里躺着那个文件。同一提交里 `ctxmux-stream-end.ts`
 * 同形。`App.tsx:19` 还有过第二例（import 一个从来不存在的 `./lib/quick-switch-shortcut`）。
 *
 * 这个状态**危险且悄无声息**：本机测试全绿、本机 tsc 干净、`git status` 只显示一个 `??`（在几十个
 * 未跟踪文件里毫不显眼），而 CI 上的全新 clone、以及任何同事的 clone，都编不出来。改动越大越容易发生
 * ——新建一批文件时漏 add 一两个，剩下的改动照常提交。
 *
 * ## 判据为什么是「索引」而不是「工作树」
 *
 * 问的是「fresh clone 能不能编译」，而 clone 拿到的恰恰是**索引/提交里的那份树**。所以两侧都从索引取：
 * 用 `git cat-file` 读索引里的文件内容去解析 import，用 `git ls-files` 的路径集去判目标在不在。
 *
 * 这样并行开发不会误报：同事在途新建的文件（工作树里有、还没 add）此时**引用方也还没 add**，两边都不
 * 在索引里，不参与判定；等他们提交时两边一起进索引，仍然自洽。而「只 add 了引用方、漏了被引用方」——
 * 也就是那次真事故的形状——两边不一致，立刻红。按工作树判会反过来：正常的在途工作天天误报，守卫必然
 * 因为吵而被删掉。
 *
 * ## 为什么 gitignored 的目标合法
 *
 * `packages/core/bin/agentmux-hook.js` import `../dist/agent-hook-command.js`：`dist/` 是构建产物，
 * clone 之后 `pnpm build` 生成，本来就不该入库。所以「目标被 gitignore 覆盖」是显式放行的一类，而不是
 * 写死一张 `dist` 白名单——判据是「这个目标是不是**故意**不入库的」，问 git 自己，而不是我们猜哪些目录
 * 算产物。产物路径改名（`dist` → `build`）时守卫跟着走，不需要有人记得同步一张清单。
 *
 * ## 为什么用真词法器
 *
 * `grep "from '\."` 会把字符串字面量里的假 import 当真。本仓至少有五处测试断言的**内容**长成 import
 * （`comment-stranded-declaration.test.ts:192` 的 `'./x.js'` 是给检测器喂的样本、`surface-tool-dock.test.ts`
 * 与 `topic-agent-status.test.ts` 用 `toContain("from './SelectorList'")` 守共享组件的接线、
 * `runtime-endpoint-reclaim.test.ts:319` 同形、`monaco-register-astro.test.ts:146` 里还有一条
 * `.astro` 的示例源码）。按行匹配会把它们全判成 import 到不存在的模块——按行猜词法边界是本仓已知的一族
 * 盲点，所以走 TypeScript 自己的 parser，只认真正的 `import` / `export from` / `import()` / `require()`
 * 节点。
 */

/** 仓根绝对路径。测试文件在 `apps/desktop/test/`，往上三层。 */
const REPOSITORY = resolve(new URL('../../../', import.meta.url).pathname)

/** 索引里的一条源码：路径 + blob sha（内容按 sha 取，不读工作树）。 */
type IndexedSource = { path: string; sha: string }

/**
 * 索引里的全部路径，以及其中属于源码的那些。
 *
 * 用 `-s` 一次拿到 sha，省掉逐文件 `git show`（642 个文件那样跑要几百次子进程）。
 */
function readIndex(): { paths: Set<string>; sources: IndexedSource[] } {
  const rows = execFileSync('git', ['ls-files', '-s', '-z'], {
    cwd: REPOSITORY,
    maxBuffer: 64 * 1024 * 1024
  })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)

  const paths = new Set<string>()
  const sources: IndexedSource[] = []
  for (const row of rows) {
    // `<mode> <sha> <stage>\t<path>`
    const match = /^\d+ ([0-9a-f]{40}) \d+\t(.*)$/.exec(row)
    expect(match, `git ls-files -s 输出这一行解析不了：${row}`).not.toBeNull()
    const [, sha, path] = match!
    paths.add(path)
    if (/\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/.test(path) && !path.includes('node_modules/')) {
      sources.push({ path, sha })
    }
  }
  return { paths, sources }
}

/**
 * 按 sha 批量取索引里的文件内容。
 *
 * `git cat-file --batch` 一次子进程读完全部：stdin 每行一个 sha，stdout 是
 * `<sha> blob <size>\n<内容>\n` 的连续流。按 size 切而不是按分隔符找，内容里有换行也不会切错。
 */
function readBlobs(shas: string[]): string[] {
  const batch = spawnSync('git', ['cat-file', '--batch'], {
    cwd: REPOSITORY,
    input: `${shas.join('\n')}\n`,
    maxBuffer: 256 * 1024 * 1024
  })
  expect(batch.status, `git cat-file --batch 失败：${batch.stderr?.toString('utf8')}`).toBe(0)

  const buffer = batch.stdout
  const contents: string[] = []
  let offset = 0
  for (let index = 0; index < shas.length; index++) {
    const headerEnd = buffer.indexOf(0x0a, offset)
    expect(headerEnd, `第 ${index} 个 blob 的头读不到（sha ${shas[index]}）`).toBeGreaterThan(-1)
    const size = Number(buffer.toString('utf8', offset, headerEnd).split(' ')[2])
    expect(Number.isFinite(size), `第 ${index} 个 blob 的头没有长度：sha ${shas[index]}`).toBe(true)
    contents.push(buffer.toString('utf8', headerEnd + 1, headerEnd + 1 + size))
    offset = headerEnd + 1 + size + 1 // 内容后面还有一个换行
  }
  return contents
}

/** 一条相对 import 及其在文件里的行号。 */
type Specifier = { spec: string; line: number }

/**
 * 用 TypeScript 的 parser 取出全部**相对** import 说明符。
 *
 * 覆盖四种真入口：`import … from`、`export … from`（含 `export *`）、动态 `import()`、`require()`。
 * 字符串字面量里长得像 import 的内容不在其中——那正是按行匹配抓错的东西。
 */
function relativeSpecifiers(path: string, text: string): Specifier[] {
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.ESNext,
    true,
    path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const found: Specifier[] = []
  const take = (node: ts.Node | undefined): void => {
    if (node === undefined || !ts.isStringLiteralLike(node) || !node.text.startsWith('.')) return
    found.push({
      spec: node.text,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
    })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) take(node.moduleSpecifier)
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      take(node.moduleReference.expression)
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression
      const dynamic = callee.kind === ts.SyntaxKind.ImportKeyword
      const required = ts.isIdentifier(callee) && callee.text === 'require'
      if (dynamic || required) take(node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/**
 * 一条相对说明符可能落在哪些仓内路径上。
 *
 * 本仓是 ESM + TS：`./x.js` 的真身通常是 `x.ts`（tsc 要求写出 `.js` 扩展），desktop 侧还有一批省略
 * 扩展名的写法（Vite 解析），另有目录 `index` 形式。全部候选一起判在不在索引里——只要命中一个就算解析
 * 得到，因为真正要证的是「这个 import 在 clone 出来的树里有东西可指」，不是「按哪条规则解析」。
 */
function candidatesFor(importer: string, spec: string): string[] {
  const base = posix.normalize(posix.join(posix.dirname(importer), spec))
  const candidates = [base]
  const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, '')
  if (stripped !== base) {
    candidates.push(`${stripped}.ts`, `${stripped}.tsx`, `${stripped}.mts`, `${stripped}.cts`)
  }
  // 只有 base 已带**代码**扩展名时才跳过补扩展名（那种已被 base / strip 两支覆盖）。
  // 末段带点却不是代码扩展名的写法（`./probe-process.test`、`./x.png`）仍要按省略扩展名解析，
  // 补上 `.ts/.tsx/.js`——否则 `.test` 会被当成扩展名，漏掉真身 `probe-process.test.ts`。
  if (!/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(base)) {
    candidates.push(`${base}.ts`, `${base}.tsx`, `${base}.js`)
  }
  candidates.push(`${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`)
  return candidates
}

/**
 * 这个目标是不是**故意**不入库的（构建产物）。
 *
 * 问 git 自己的 ignore 规则，不写死目录名。`check-ignore` 对未被忽略的路径退 1，对被忽略的退 0。
 */
function deliberatelyUntracked(target: string): boolean {
  return spawnSync('git', ['check-ignore', '-q', target], { cwd: REPOSITORY }).status === 0
}

describe('已入库的源码只 import 已入库的东西', () => {
  const { paths, sources } = readIndex()
  const contents = readBlobs(sources.map((entry) => entry.sha))

  it('每条相对 import 都在索引里解析得到（否则 fresh clone 编不出来）', () => {
    // 空集取胜的挡板：这条守卫的价值全在扫过的文件数上，扫到 0 个也会「通过」。
    expect(sources.length, '索引里一个源码文件都没扫到，判据没有生效').toBeGreaterThan(400)

    const orphans: string[] = []
    let checked = 0
    sources.forEach((entry, index) => {
      for (const { spec, line } of relativeSpecifiers(entry.path, contents[index]!)) {
        checked++
        const candidates = candidatesFor(entry.path, spec)
        if (candidates.some((candidate) => paths.has(candidate))) continue
        // 索引里没有：要么是构建产物（合法），要么就是漏 add。
        if (candidates.some((candidate) => deliberatelyUntracked(candidate))) continue
        orphans.push(`${entry.path}:${line} import '${spec}'`)
      }
    })

    // 同一挡板的第二侧：说明符一条都没解析出来时，上面的循环体压根不执行。
    expect(checked, '一条相对 import 都没解析出来，词法器那一步失效了').toBeGreaterThan(1000)

    expect(
      orphans,
      '这些 import 的目标既不在 git 索引里、也不是被 gitignore 的构建产物——clone 出来的仓库编译不出来，' +
        '通常是新建文件时漏了 git add'
    ).toEqual([])
  })

  it('词法器只认真正的 import，不认字符串里长成 import 的内容', () => {
    // 自检，防止上面那条恒绿。本仓有多处测试断言的**内容**是 import 语句文本（守共享组件接线用的
    // `toContain("from './SelectorList'")` 之类）；按行匹配会把它们判成 import 到不存在的模块。
    const sample = [
      "import { real } from './real-module.js'",
      "export { thing } from './exported.js'",
      "const lazy = await import('./dynamic.js')",
      "expect(source).toContain(\"from './not-an-import'\")",
      "const text = 'import x from \\'./also-not.js\\''"
    ].join('\n')

    const specs = relativeSpecifiers('sample.ts', sample).map((entry) => entry.spec)
    expect(specs).toEqual(['./real-module.js', './exported.js', './dynamic.js'])
  })
})
