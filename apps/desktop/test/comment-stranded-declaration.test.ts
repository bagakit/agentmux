import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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
 */

/**
 * 一行块注释内容，去掉 JSDoc 的前导 `*` 之后，是不是一条独立的声明语句。
 *
 * 只认行首：`import …` / `export …` 打头。散文提及（"不 import api"、"变成 import 期失败"）
 * 都有前置词，不会命中。
 */
const STRANDED_DECLARATION =
  /^(?:export\s+(?:const|let|var|function|class|interface|type|enum|default|abstract|async)\b|export\s*\{|export\s*\*|import\s+[\w{*'"]|import\s*\()/

/**
 * `@example` 之后的注释行豁免。
 *
 * 在 doc 注释里放用法示例是本仓既有的合法惯例（`ConversationSpeakerAvatar.tsx:50` 就有一处，
 * 里面是 JSX 调用）。今天那处示例不含声明语句，所以这个豁免眼下不放过任何东西——**这正是要
 * 现在就写进去的原因**：等到有人在 `@example` 里写一行 `export const config = …` 演示用法时，
 * 守卫会把一条正当的示例判成残留，而那时改守卫的人手边没有这段推理。禁令要挡的是还没写出来的
 * 那一行，豁免也一样。
 *
 * 抽成函数而不是内联进扫描，是为了让下面那条测试有一个**可以直接质询的对象**：测试里若自己
 * 再写一遍同样的条件，放宽豁免时两边会一起放宽，测试跟着变松（同 reference-name-containment
 * 里那条豁免的实测结论）。
 */
function isExampleBlock(seenExampleTag: boolean): boolean {
  return seenExampleTag
}

/** 一处被困住的声明。 */
export interface StrandedDeclaration {
  readonly path: string
  readonly line: number
  readonly text: string
}

/**
 * 扫一份源码文本，报出所有被困在块注释里的声明。
 *
 * 只跟**块**注释（`/* … *&#47;`）。行注释 `//` 后面写声明是常见的临时注掉代码，那是作者的显式
 * 意图，不是粘贴事故；块注释里出现一条声明才是「本该在注释外面」的信号。
 */
export function strandedDeclarationsIn(path: string, text: string): StrandedDeclaration[] {
  const found: StrandedDeclaration[] = []
  let inBlock = false
  let seenExampleTag = false
  let lineNumber = 0
  for (const raw of text.split('\n')) {
    lineNumber += 1
    const trimmed = raw.trim()
    if (!inBlock) {
      // 单行 `/* … *\/` 不进入块状态：它装不下一条跨行声明，也不是这个错的形状。
      if (trimmed.startsWith('/*') && !trimmed.includes('*/')) {
        inBlock = true
        seenExampleTag = false
      }
      continue
    }
    if (trimmed.includes('*/')) {
      inBlock = false
      seenExampleTag = false
      continue
    }
    const body = trimmed.startsWith('*') ? trimmed.slice(1).trim() : trimmed
    if (body.startsWith('@example')) {
      seenExampleTag = true
      continue
    }
    if (isExampleBlock(seenExampleTag)) continue
    if (STRANDED_DECLARATION.test(body)) {
      found.push({ path, line: lineNumber, text: trimmed })
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
  })

  it('豁免是"@example 之后"，不是"整个注释块"', () => {
    // 最危险的放宽方式是把豁免从"@example 之后的行"扩成"含有 @example 的整个块"——那样
    // 一处示例就会让同一个 doc 注释里其余位置的残留全部隐形。而"再跑一遍同样的条件"抓不住这次
    // 放宽：那样写出来的检查会跟着豁免一起放宽，两边一起变松（先例的实测结论）。
    // 所以判据换成：**同一个块里，@example 之前的残留必须仍然被抓到。**
    const mixed = [
      '/**',
      ' * 说明。',
      'export const stranded = {',   // @example 之前 → 必须抓到
      ' * @example',
      ' * export const sample = 1',  // 示例里的声明 → 豁免
      ' */'
    ].join('\n')
    const found = strandedDeclarationsIn('s.ts', mixed)
    expect(found.map((f) => f.line)).toEqual([3])

    // 豁免函数本身可被直接质询：见过 @example 才豁免，没见过不豁免。
    expect(isExampleBlock(true)).toBe(true)
    expect(isExampleBlock(false)).toBe(false)

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

  it('没有任何跟踪的 TypeScript 文件把声明困在块注释里', () => {
    const offenders = trackedTypeScriptFiles()
      .flatMap(({ path, text }) => strandedDeclarationsIn(path, text))
      .map(({ path, line, text }) => `${path}:${line}  ${text}`)

    expect(offenders).toEqual([])
  })
})
