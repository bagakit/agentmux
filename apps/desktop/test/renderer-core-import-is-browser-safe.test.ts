import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * renderer 侧对 `@agentmux/core` 的**值**导入只许走窄子路径，不许走根 barrel。
 *
 * 来由：`ShortcutSettingsPane.tsx` 曾写 `import { BUILT_IN_AGENT_PROVIDER_IDS } from '@agentmux/core'`。
 * 根 barrel（`packages/core/src/index.ts`）`export *` 了 40 个模块，其中 33 个直接 import `node:` 内建。
 * 打 renderer 时 vite 把这些换成 `__vite-browser-external`，于是 rollup 在
 * `agent-native-locator.js` 上报 `"isAbsolute" is not exported by "__vite-browser-external"`，
 * **整个打包失败**。
 *
 * 这一条**必须有守卫**，因为三个正常关卡全都看不见它：
 *   - `vitest` 跑在 node 环境，`node:path` 真的在，测试全绿；
 *   - `tsc --noEmit` 只看类型，根 barrel 确实导出了那个符号，干净；
 *   - `git status` / review 看不出——那行 import 和旁边几十行长得一模一样。
 * 只有 `pnpm package:mac` 那一步会红，而那一步要跑好几分钟、而且通常是最后才跑。
 *
 * ## 为什么只管「值」导入
 *
 * `import type` 在编译期就被擦掉，运行时/打包期一个字节都不剩，所以 renderer 里 60 处 core 导入
 * 绝大多数是 `import type`，它们走根 barrel 完全安全。按「出现了 `@agentmux/core`」去禁会把这些
 * 全打红，守卫必然因为吵而被删掉。判据因此是 TypeScript 自己的 `isTypeOnly`。
 *
 * ## 为什么不按文件名/目录白名单
 *
 * 判据是「这个文件会不会进 renderer 的打包图」。`src/main/**` 跑在 node 里，用根 barrel 是对的
 * （实测 16 处）；`src/renderer/**` 与 `src/shared/**` 会被 renderer 打进去。所以规则按这两个
 * **目录角色**走，而不是列一张文件清单——清单会和代码漂开。
 */

const DESKTOP = resolve(new URL('../', import.meta.url).pathname)

/** renderer 打包图能到的两处源码根。`main/` 跑在 node 里，不在这条规则内。 */
const BROWSER_ROOTS = ['src/renderer', 'src/shared']

const ROOT_SPECIFIER = '@agentmux/core'

type CoreImport = { file: string; specifier: string; typeOnly: boolean }

function sourceFiles(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.tsx?$/.test(entry.name)) found.push(path)
    }
  }
  walk(join(DESKTOP, root))
  return found
}

/**
 * 每一条导入 `@agentmux/core*` 的语句，连同它是不是 type-only。
 *
 * 走真 parser 而不是正则：本仓测试里有好几处**断言内容**长得像 import 语句，按行匹配会把它们算进来
 * （仓内已知的一族盲点，见 `tracked-imports-resolve-in-index.test.ts` 的同一段理由）。
 */
function coreImports(roots: readonly string[]): CoreImport[] {
  const found: CoreImport[] = []
  for (const root of roots) {
    for (const file of sourceFiles(root)) {
      const text = readFileSync(file, 'utf8')
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          const specifier = node.moduleSpecifier.text
          if (specifier === ROOT_SPECIFIER || specifier.startsWith(`${ROOT_SPECIFIER}/`)) {
            // 整句 `import type {…}`，或者句内每个绑定都带 `type`，都算擦得掉。
            const clause = node.importClause
            const bindings = clause?.namedBindings
            const everyBindingIsType = bindings !== undefined && ts.isNamedImports(bindings)
              && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly)
            found.push({
              file: file.slice(DESKTOP.length),
              specifier,
              typeOnly: clause?.isTypeOnly === true || everyBindingIsType
            })
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
  }
  return found
}

describe('renderer 侧的 core 导入必须是浏览器安全的', () => {
  it('确实扫到了 core 导入——扫到空内容会让下面每条断言恒真', () => {
    // 这条测试整族的白绿形态：目录写错、后缀改了、parser 没认出来，扫描结果就是空集合，
    // 而 `[].filter(…)` 得到的还是空集合，`toEqual([])` 照样绿（仓内「空集合上的谓词断言恒成立」）。
    const all = coreImports(BROWSER_ROOTS)
    expect(all.length).toBeGreaterThan(20)
    // 两侧都要有收获：只有 renderer 有命中时，shared 那条规则是空转的。
    expect(all.some((entry) => entry.file.startsWith('/src/renderer'))).toBe(true)
    expect(all.some((entry) => entry.file.startsWith('/src/shared'))).toBe(true)
    // 也要真的扫到过**值**导入，否则「值导入必须走子路径」这条永远没有被检验的对象。
    expect(all.filter((entry) => !entry.typeOnly).length).toBeGreaterThan(0)
  })

  it('值导入一律走窄子路径，根 barrel 只许 type-only', () => {
    const offenders = coreImports(BROWSER_ROOTS)
      .filter((entry) => entry.specifier === ROOT_SPECIFIER && !entry.typeOnly)
      .map((entry) => `${entry.file}: import { … } from '${entry.specifier}'`)

    // 维护者看到的提示：把它换成具体子路径（`@agentmux/core/provider-id` 这种），
    // 或者改成 `import type`。核心包的 exports map 里已经有 14 条子路径。
    expect(offenders).toEqual([])
  })

  it('用到的每条子路径都真的在 core 的 exports map 里', () => {
    // 子路径拼错不会被上面那条抓到（它只看等不等于根），而 vite 解析失败的信息又和 node 内建那种
    // 长得完全不同。顺手在这里钉住：写错就当场红，而不是等打包。
    const exportsMap = JSON.parse(
      readFileSync(resolve(DESKTOP, '../../packages/core/package.json'), 'utf8')
    ).exports as Record<string, unknown>
    const declared = new Set(Object.keys(exportsMap).map((key) => key.replace(/^\./, ROOT_SPECIFIER)))
    expect(declared.size).toBeGreaterThan(1)

    const unknown = [...new Set(coreImports(BROWSER_ROOTS).map((entry) => entry.specifier))]
      .filter((specifier) => !declared.has(specifier))
      .sort()

    expect(unknown).toEqual([])
  })
})
