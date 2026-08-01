import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * 没有任何 TypeScript 源文件把一条**真声明**困在块注释里。
 *
 * 这条守卫的来由是 `packages/core/src/providers/copilot.ts` 里的一处复制粘贴残留：一行
 * `export const COPILOT_HOOKS: AgentNativeHookSpecification = {` 落在 `/** … *&#47;` 内部，
 * 而真正的声明在 22 行之后。读注释的人会看到一句看起来千真万确的导出语句。
 *
 * 它之所以需要**检测器**而不只是一次清理：这个错对现有一切工具全盲。整行是注释，所以
 * `tsc --noEmit` 干净退出，全仓 2050 条测试全绿，本仓也没有 eslint 配置（实测 `.eslintrc*`
 * 与 `eslint.config.*` 都不存在）。也就是说，没有任何东西会在下一次粘贴时说话——而
 * 「手工清理不留检测器等于没清」在本仓已经实证过一次（见 reference-name-containment）：
 * 清理只作用于当时存在的文件，守卫要挡的是还没写出来的那一行。
 *
 * 判据是**行首锚定的声明形状**，不是「注释里出现了 export/import 这些词」。后者会误报十几处：
 * 本仓的注释大量用散文提及这些词（实测 10 处，例如 runtime-endpoint-reclaim.ts 里的
 * 「放在模块顶层会把那个错误变成 import 期失败」）。散文里这些词总有前后文包裹，被困住的声明
 * 则独占一行、从行首开始。这个区别正是可判的那一条。
 *
 * **「注释从哪里开始、到哪里结束」这件事交给 TypeScript 自己的 scanner，不自己按行猜。**
 * 这个检测器的第一版用逐行状态机判块边界，有四个盲点，**四个都用真注入证过会静默放过**：
 *   1. 声明与 `/**` 同行（`/** export const X = {`）——开头那行整行被 continue 掉，从没被检测。
 *   2. 块从行中开启（`const x = 1 /* …`）——只在 trim 后以 `/*` 打头时才进块状态。
 *   3. `*&#47;` 出现在模板字符串或散文里——见到就关块，后面真的搁浅声明不再被跟踪。
 *   4. `@example` 之后到块尾整段豁免（见下面 {@link exemptAsExample} 那段）。
 * 前三个是同一个病：**词法边界不能靠行首形状推断**。`ts.createScanner` 是本仓已有依赖
 * （typescript 5.9.3）里成熟的词法器，它认得模板字符串、认得行中开块，也就一次性消掉这三个面。
 * 自己扩状态机等于重写一个词法器，而那正是「先翻项目里已有的依赖能做什么」要避免的。
 */

/**
 * 一行块注释内容，去掉 JSDoc 的前导 `*` 之后，是不是一条独立的声明语句。
 *
 * 只认行首：`import …` / `export …` 打头。散文提及（"不 import api"、"变成 import 期失败"）
 * 都有前置词，不会命中。
 */
const STRANDED_DECLARATION =
  /^(?:export\s+(?:const|let|var|function|class|interface|type|enum|default|abstract|async)\b|export\s*\{|export\s*\*|import\s+[\w{*'"]|import\s*\()/

/** JSDoc 的块标签：一行去掉前导 `*` 之后以 `@名字` 打头。 */
const BLOCK_TAG = /^@[a-z]/i

/**
 * 这一行是不是"某个 `@example` 里的示例代码"，因而不算搁浅。
 *
 * 在 doc 注释里放用法示例是本仓既有的合法惯例（`ConversationSpeakerAvatar.tsx:50` 就有一处）。
 * 但豁免的**范围**是这条判据最容易悄悄放宽的地方，所以两条边界都写死：
 *
 * - **纵向**：`@example` 的作用域到**下一个块标签**为止，这是 JSDoc/TSDoc 自己的规则（一个块标签
 *   的内容延伸到下一个块标签或注释结束），不是我另立的约定。第一版是"见过 @example 就一路豁免到
 *   块尾"，于是 `@example` 之后隔着 `@param` 再写的残留也隐形——那正是这个检测器自己那条测试
 *   声称要防的「整块豁免」，而它当时只放了 `@example` **之前**的样本，从没验过之后的。
 * - **横向**：只有带前导 `*` 的行才可能是示例。JSDoc 块里每一行都带那个星号；一行从**第 0 列**
 *   开始就已经脱离了 doc 结构本身——那恰是 copilot.ts 那次事故的形状（粘进来的 `export const`
 *   顶在行首）。所以哪怕它落在 `@example` 作用域里，也一律要报。
 *
 * 抽成函数而不是内联进扫描，是为了让下面那条测试有一个**可以直接质询的对象**：测试里若自己
 * 再写一遍同样的条件，放宽豁免时两边会一起放宽，测试跟着变松（同 reference-name-containment
 * 里那条豁免的实测结论）。
 */
export function exemptAsExample(input: {
  /** 当前是否落在某个 `@example` 的作用域里（到下一个块标签为止）。 */
  inExampleScope: boolean
  /** 这一行去掉缩进后是否以 JSDoc 的 `*` 打头。 */
  hasDocPrefix: boolean
}): boolean {
  return input.inExampleScope && input.hasDocPrefix
}

/** 一处被困住的声明。 */
export interface StrandedDeclaration {
  readonly path: string
  readonly line: number
  readonly text: string
}

/**
 * 源码里每一段多行块注释，连同它起始处的行号。
 *
 * 用 `ts.createScanner` 而不是按行找 `/*`：词法边界只有词法器判得准（模板字符串里的 `/*`、
 * 行中开启的块、散文里的 `*&#47;`）。行注释 `//` 不在此列——`//` 后面写声明是常见的临时注掉代码，
 * 那是作者的显式意图，不是粘贴事故。
 */
function multiLineComments(text: string): { startLine: number; body: string }[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.JSX, text)
  const out: { startLine: number; body: string }[] = []
  let kind = scanner.scan()
  while (kind !== ts.SyntaxKind.EndOfFileToken) {
    if (kind === ts.SyntaxKind.MultiLineCommentTrivia) {
      const start = scanner.getTokenStart()
      const body = text.slice(start, scanner.getTokenEnd())
      // 单行 `/* … *\/` 装不下一条跨行声明，也不是这个错的形状。
      if (body.includes('\n')) {
        out.push({ startLine: text.slice(0, start).split('\n').length, body })
      }
    }
    kind = scanner.scan()
  }
  return out
}

/** 一份源码里有多少段多行块注释。给"词法器真的在真实文件里找到了注释"那条自证用。 */
function countMultiLineComments(text: string): number {
  return multiLineComments(text).length
}

/** 扫一份源码文本，报出所有被困在块注释里的声明。 */
export function strandedDeclarationsIn(path: string, text: string): StrandedDeclaration[] {
  const found: StrandedDeclaration[] = []
  for (const { startLine, body } of multiLineComments(text)) {
    let inExampleScope = false
    const lines = body.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index]!
      const trimmed = raw.trim()
      // 注释的头尾两行本身携带 `/*` 与 `*\/` 记号。头一行的**记号之后**仍可能藏着声明
      //（`/** export const X = {` 正是盲点 1），所以剥掉记号继续判，而不是整行跳过。
      const stripped =
        index === 0 ? trimmed.replace(/^\/\*+/, '').trim() : trimmed.replace(/\*\/\s*$/, '').trim()
      const hasDocPrefix = stripped.startsWith('*')
      const content = hasDocPrefix ? stripped.slice(1).trim() : stripped
      if (BLOCK_TAG.test(content)) {
        // 块标签切换作用域：`@example` 开启，任何别的块标签结束它（JSDoc 自己的规则）。
        inExampleScope = content.startsWith('@example')
        continue
      }
      if (exemptAsExample({ inExampleScope, hasDocPrefix })) continue
      if (STRANDED_DECLARATION.test(content)) {
        found.push({ path, line: startLine + index, text: trimmed })
      }
    }
  }
  return found
}

/**
 * 所有被 git 跟踪的 TypeScript 源文件。
 *
 * 从 git 取清单而不是遍历目录：`dist/`、`out/`、`release/` 里的构建产物不被跟踪，于是不必
 * 维护一份排除清单——一份排除清单与真实构建目录是两处必然 drift 的常量。
 */
function trackedTypeScriptFiles(): { path: string; text: string }[] {
  const repository = new URL('../../../', import.meta.url)
  const listing = execFileSync('git', ['ls-files', '-z', '*.ts', '*.tsx'], {
    cwd: repository,
    maxBuffer: 64 * 1024 * 1024
  })
  const out: { path: string; text: string }[] = []
  for (const path of listing.toString('utf8').split('\0')) {
    if (!path) continue
    try {
      out.push({ path, text: readFileSync(new URL(path, repository), 'utf8') })
    } catch {
      continue // 跟踪但工作区里没有（未 checkout）——没有内容可扫。
    }
  }
  return out
}

describe('块注释里没有困住任何真声明', () => {
  it('检测器看得见它要找的形状——包括当初真实发生的那一行', () => {
    // 没有这条，一个瞎了的检测器会靠"什么也没找到"把下面那条禁令刷绿。
    // 样本逐字用当初 copilot.ts:54 的那一行。
    const regression = [
      '/**',
      ' * Copilot 的 hook 合同。',
      'export const COPILOT_HOOKS: AgentNativeHookSpecification = {',
      ' *',
      ' * 三个基础键每个事件都有。',
      ' */',
      'export const COPILOT_HOOKS: AgentNativeHookSpecification = {'
    ].join('\n')
    const found = strandedDeclarationsIn('sample.ts', regression)
    expect(found).toHaveLength(1)
    expect(found[0]!.line).toBe(3)

    // 带前导 `*` 的同一个错也要抓到——粘贴进 JSDoc 时编辑器常会补上那个星号。
    expect(strandedDeclarationsIn('s.ts', '/**\n * export const a = 1\n */').map((f) => f.line))
      .toEqual([2])
    // 各种声明打头都算：本仓真实出现过的是 `export const`，但同族的形状一样是错。
    for (const declaration of [
      'export function f() {',
      'export class C {',
      'export interface I {',
      'export type T = {',
      'export default foo',
      'export { a }',
      "export * from './x.js'",
      "import { a } from './x.js'",
      "import('./x.js')"
    ]) {
      expect(
        strandedDeclarationsIn('s.ts', `/**\n * ${declaration}\n */`),
        `${declaration} 是声明形状，必须被抓到`
      ).toHaveLength(1)
    }
  })

  it('散文提及不误报——这是本仓注释的真实写法，实测 10 处', () => {
    // 判据是"整行就是一条声明"，不是"出现了这些词"。下面每一句都取自本仓真实注释的写法；
    // 若把判据放宽成子串搜索，它们会全部变红，守卫就只能被删掉——一个必然误报的守卫活不下来。
    for (const prose of [
      '路径时会抛，放在模块顶层会把那个错误变成**import 期**失败，连带打死整个模块的所有导出。',
      '组件不读 Store、不 import api：身份用什么名字，都由调用方通过 props 传入。',
      'Pure window-geometry projections. No Electron or fs import so the derivation can be asserted',
      '让子进程去 import normalizer（那里有跨事件的花名册 Map）不划算。',
      '顺序与 index.css 的 @import 一致：层叠顺序即文件顺序。',
      '它 export const 出去的那张表由调用方自己缓存。'
    ]) {
      expect(
        strandedDeclarationsIn('s.ts', `/**\n * ${prose}\n */`),
        `散文提及不该命中：${prose.slice(0, 30)}`
      ).toEqual([])
    }

    // 注释**外面**的真声明当然不算——否则整棵树都是"违规"。
    expect(strandedDeclarationsIn('s.ts', 'export const a = 1\n')).toEqual([])
    // 行注释后面的声明是显式的临时注掉，不是粘贴事故，不管。
    expect(strandedDeclarationsIn('s.ts', '// export const a = 1\n')).toEqual([])
    // 单行 `/* … */` 装不下这个错，也不该进入块状态而把后面的真声明吞成"注释内"。
    expect(strandedDeclarationsIn('s.ts', '/* 一句说明 */\nexport const a = 1\n')).toEqual([])
    // 一整条声明被一段**单行**块注释包住，与 `//` 注掉同类：作者的显式意图，不是粘贴事故。
    // 这一条是实测补的——摘掉 multiLineComments 里那个"含换行"过滤，6 条照旧全绿（真实树里
    // 一处这种形状都没有，所以那颗变异只在这个样本上现形）。判据里每个收窄都要有人守，否则
    // 它是一条随时可以被"顺手放宽"的免检口。
    expect(strandedDeclarationsIn('s.ts', '/* export const a = 1 */\n')).toEqual([])
  })

  it('扫描真的读到了整棵树，而不是一份空清单', () => {
    // 没有这条，任何让文件遍历返回空的错误（glob 写错、扫描根指错、读取全失败）都会让下面的
    // 禁令靠"什么也没扫到"变绿。这个失败形态在本仓已实证过（见 reference-name-containment
    // 里那条同名断言的注释）。
    const scanned = trackedTypeScriptFiles()
    expect(scanned.length).toBeGreaterThan(500)
    const paths = new Set(scanned.map(({ path }) => path))
    // 出事的那个文件必须在扫描范围内——它是这条守卫存在的原因。
    expect(paths.has('packages/core/src/providers/copilot.ts')).toBe(true)
    // 两个 workspace 都要覆盖：这条规则约束的是全仓源码组织，不是 desktop 一家。
    expect(paths.has('apps/desktop/src/main/config-store.ts')).toBe(true)
    // .tsx 也在内——renderer 的组件几乎全是 .tsx，漏掉它等于漏掉半个 desktop。
    expect([...paths].some((path) => path.endsWith('.tsx'))).toBe(true)

    // 读到文件还不够：**词法器必须真的在这些文件里找到块注释**。scanner 建错（语言变体、
    // ScriptTarget）或 trivia 判断写错时，每份源码都会分解出零段注释，于是下面那条禁令在
    // "一段都没检查"的情况下变绿——这正是本仓反复踩到的空集假绿形态。
    // 阈值取自实测（2026-09-01：568 份跟踪源码里 223 份含多行块注释，其中 .tsx 32 份），留出
    // 增删余量；它守的是"数量级不为零"，不是某个精确数字。
    const commentCounts = scanned.map(({ text }) => countMultiLineComments(text))
    const withComments = commentCounts.filter((count) => count > 0).length
    expect(withComments, '词法器在整棵树里一段块注释都没找到').toBeGreaterThan(150)
    // .tsx 单独再钉一次：JSX 语言变体建错时它会在泛型/JSX 处走偏。
    expect(
      scanned.filter(({ path, text }) => path.endsWith('.tsx') && countMultiLineComments(text) > 0)
        .length,
      '.tsx 里一段块注释都没找到——语言变体可能建错了'
    ).toBeGreaterThan(20)
  })

  it('豁免的两条边界：@example 到下一个块标签为止，且只覆盖带 * 的行', () => {
    // 最危险的放宽方式是把豁免从"@example 的作用域"扩成"含有 @example 的整个块"——那样
    // 一处示例就会让同一个 doc 注释里其余位置的残留全部隐形。而"再跑一遍同样的条件"抓不住这次
    // 放宽：那样写出来的检查会跟着豁免一起放宽，两边一起变松（先例的实测结论）。
    const mixed = [
      '/**',
      ' * 说明。',
      'export const stranded = {',   // @example 之前 → 必须抓到
      ' * @example',
      ' * export const sample = 1',  // 示例里的声明 → 豁免
      ' */'
    ].join('\n')
    expect(strandedDeclarationsIn('s.ts', mixed).map((f) => f.line)).toEqual([3])

    // **纵向边界**：@example 的作用域到下一个块标签为止。第一版是"见过就一路豁免到块尾"，于是
    // 隔着一个 @param 之后的残留照旧隐形（实测：那一版这里返回 []）。这一面此前无人守——那条
    // 测试只放了 @example **之前**的样本。
    const afterNextTag = [
      '/**',
      ' * @example',
      ' * export const sample = 1',
      ' * @param options 说明',
      ' * export const stranded = {',   // 已出了 @example 作用域 → 必须抓到
      ' */'
    ].join('\n')
    expect(strandedDeclarationsIn('s.ts', afterNextTag).map((f) => f.line)).toEqual([5])

    // **横向边界**：从第 0 列开始的行已经脱离 doc 结构，正是 copilot.ts 那次事故的形状；哪怕它
    // 落在 @example 作用域里也要报。否则"在示例里粘错东西"成了一个免检口。
    const noPrefixInsideExample = [
      '/**',
      ' * @example',
      'export const stranded = {',
      ' */'
    ].join('\n')
    expect(strandedDeclarationsIn('s.ts', noPrefixInsideExample).map((f) => f.line)).toEqual([3])

    // 豁免函数本身可被直接质询：两个条件都成立才豁免，缺一不可。
    expect(exemptAsExample({ inExampleScope: true, hasDocPrefix: true })).toBe(true)
    expect(exemptAsExample({ inExampleScope: false, hasDocPrefix: true })).toBe(false)
    expect(exemptAsExample({ inExampleScope: true, hasDocPrefix: false })).toBe(false)

    // 而块一结束，豁免就失效——下一个注释块里的残留照样要红。
    const nextBlock = [
      '/**',
      ' * @example',
      ' * export const sample = 1',
      ' */',
      'const real = 1',
      '/**',
      ' * 另一段说明。',
      'export const alsoStranded = {',
      ' */'
    ].join('\n')
    expect(strandedDeclarationsIn('s.ts', nextBlock).map((f) => f.line)).toEqual([8])
  })

  it('词法边界由 scanner 判——三种"按行猜"会放过的形状都要抓到', () => {
    // 这三条都用真注入证过第一版（逐行状态机）会静默放过。它们是同一个病的三个面：
    // 注释从哪儿开始、到哪儿结束，不能靠行首形状推断。
    //
    // 1. 声明与 `/**` 同行：那一行整行被当作"开头"跳过，记号之后的声明从没被检测。
    expect(
      strandedDeclarationsIn('s.ts', '/** export const X = {\n * 说明\n */').map((f) => f.line),
      '开头行的记号之后仍要判'
    ).toEqual([1])

    // 2. 块从行中开启：`/*` 不在行首，于是压根没进块状态。
    expect(
      strandedDeclarationsIn('s.ts', 'const x = 1 /* 开头\nexport const X = {\n */').map((f) => f.line),
      '行中开启的块也是块'
    ).toEqual([2])

    // 3. `*/` 出现在散文里：见到就关块，其后真的搁浅声明不再被跟踪。scanner 知道注释在哪结束。
    expect(
      strandedDeclarationsIn(
        's.ts',
        '/**\n * 文中提到 *\\/ 这个记号\nexport const X = {\n */'
      ).map((f) => f.line),
      '散文里的记号不结束注释'
    ).toEqual([3])

    // 反面：模板字符串里的 `/*` 不是注释，其后的真声明当然不算搁浅。按行猜会把整个尾部吞进
    // "注释内"，从而既漏报又误报。
    expect(strandedDeclarationsIn('s.ts', 'const s = `\n/*\n`\nexport const X = 1')).toEqual([])
    // .tsx 的泛型/JSX 也要能扫过去而不炸——扫描器按 JSX 变体建。
    expect(strandedDeclarationsIn('s.tsx', 'const a = <div>x</div>\n/**\n * 说明\n */')).toEqual([])
  })

  it('没有任何跟踪的 TypeScript 文件把声明困在块注释里', () => {
    const offenders = trackedTypeScriptFiles()
      .flatMap(({ path, text }) => strandedDeclarationsIn(path, text))
      .map(({ path, line, text }) => `${path}:${line}  ${text}`)

    expect(offenders).toEqual([])
  })
})
