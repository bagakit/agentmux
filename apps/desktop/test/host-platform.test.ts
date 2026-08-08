import { readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import {
  fileManagerName,
  hostPlatform,
  isMacPlatform,
  revealInFileManagerLabel,
  type HostPlatform
} from '../src/renderer/src/lib/host-platform.js'

/**
 * 平台判定与随平台变化的文案，渲染层只许有一处。
 *
 * 建这道门之前的实测：`navigator.userAgent.includes('Mac')` 在渲染层手抄 11 处，Windows 的判定另抄
 * 两份；而同一个「在系统文件管理器里显示」动作有三种说法——两处三态（Finder / File Explorer /
 * File Manager）、一处无条件写 "Reveal in Finder"。最后那处在 Windows 与 Linux 上直接说错话，而
 * **没有任何东西会红**：它是一句 JSX 里的字面量。
 *
 * 两处三态今天恰好一致，其中一处的注释还自称「与文件树右键菜单同一套说法」——手抄且知道自己在手抄。
 * 本仓的教训是同一条规则抄两份时，改对一份就以为改完了（[[duplicated-rule-defeats-the-fix]]）：
 * 等价性断言对今天的两份副本恒真，抓不到「新抄一份」，所以这里的判据是**结构**的——渲染层除 lib
 * 之外不得读平台，文案字面量不得在 lib 之外出现。
 *
 * 判据都走 TS parser 而不是正则：注释里出现 `navigator.userAgent` 或字符串里出现 "Reveal in" 都不该
 * 算违规，而按行猜注释边界在本仓被证过是一族盲点（[[lexical-boundaries-need-a-real-lexer]]）。
 *
 * 每条结构断言都自带在场自检：扫描根写错、glob 落空、或谓词永远为假时，是自检先红，而不是「一个
 * 违规都没找到」静默通过（[[false-green-gate-patterns]]）。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RENDERER = path.resolve(HERE, '../src/renderer/src')
const LIB_FILE = path.join(RENDERER, 'lib/host-platform.ts')

/** 渲染层的每个 TypeScript 源文件（.ts/.tsx/.mts/.cts）。 */
function rendererSources(dir = RENDERER): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...rendererSources(full))
    // `/\.tsx?$/` 会静默跳过 `.mts/.cts`。今天 `src/renderer/src` 下这类文件为零（实测），所以这是
    // 潜在而非现行的洞——但白名单式的收窄对每一种没想到的扩展名 fail open，加宽掉。
    else if (/\.[mc]?tsx?$/.test(full)) out.push(full)
  }
  return out
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, ts.sys.readFile(file) ?? '', ts.ScriptTarget.Latest, true, /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
}

/** 现场合成一份源码来质询谓词本身。自检用：不必往产品代码里种违规。 */
function parseText(text: string): ts.SourceFile {
  return ts.createSourceFile('synthetic.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}

/** 平台取值的属性名。`navigator.platform` 已废弃但仍可用，两个都要守。 */
const PLATFORM_PROPERTIES = ['userAgent', 'platform'] as const

/**
 * 这个文件里读平台的位置。行号用于报错。
 *
 * **判据是属性名，不是接收者。** 原先写的是 `isIdentifier(node.expression) && text === 'navigator'`，
 * 于是 `window.navigator.userAgent` 完全隐身——它的接收者是一个 `PropertyAccessExpression` 而不是
 * `Identifier`。review agent 实测过这条：把 lib 之外的一处改成 `window.navigator.userAgent.includes('Mac')`
 * 后本文件 5 条全绿、`tsc` 也退 0（`noUnusedLocals` 没开，于是那个变成死引用的 import 也不报）。
 * 按接收者判是在猜写法：`window.` / `globalThis.` / 先存进局部变量再读，每一种都要另写一个分支。
 * 按属性名判则一次覆盖全部接收者（[[forbidden-shape-guard-misfires]]：谓词手抄比取值手抄更隐蔽）。
 *
 * 元素访问（`navigator['userAgent']`）另走一支——那是另一种词法形状，同一个语义。
 *
 * 代价是可能误伤一个合法的领域字段（某个 record 真有个 `.platform`）。今天渲染层零命中（含未入库
 * 文件），且这个方向的误伤是**响亮**的：它会红，然后由人决定加一条显式豁免；反方向的漏报是静默的
 * ——在 Windows 上说错话，一条断言都不红。所以宁可宽。
 */
function platformReadsIn(source: ts.SourceFile): number[] {
  const hits: number[] = []
  const at = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && PLATFORM_PROPERTIES.includes(node.name.text as never)) {
      hits.push(at(node))
    } else if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      PLATFORM_PROPERTIES.includes(node.argumentExpression.text as never)
    ) {
      hits.push(at(node))
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return hits
}

/** lib 里那几个函数在这个文件里的每一次调用，连实参个数一起报。 */
const HOST_PLATFORM_FUNCTIONS = [
  'hostPlatform',
  'isMacPlatform',
  'fileManagerName',
  'revealInFileManagerLabel'
] as const

/**
 * lib 里那几个函数在这个文件里的每一次调用，连实参个数一起报。
 *
 * **不按 `isIdentifier(node.expression)` 判**——那样只认最朴素的 `revealInFileManagerLabel(...)`，
 * review agent 实测有三种写法从它眼皮底下溜过去（平台被硬钉成 mac 却全绿）：
 *   - `(revealInFileManagerLabel)('mac')`——被括号包住的 callee 是 `ParenthesizedExpression`
 *   - `const rl = revealInFileManagerLabel; rl('mac')`——别名
 *   - `lib.revealInFileManagerLabel('mac')`——成员调用
 * 所以这里先剥括号、再顺着别名回溯到原名、成员调用取其属性名，把 callee 归一到一个函数名再判。
 */
function calleeName(expression: ts.Expression, aliases: Map<string, string>): string | undefined {
  let node: ts.Expression = expression
  while (ts.isParenthesizedExpression(node)) node = node.expression
  if (ts.isIdentifier(node)) return aliases.get(node.text) ?? node.text
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  return undefined
}

/** 收集 `const x = <host-platform 函数>` 这类别名，让 callee 能回溯到原名。 */
function hostPlatformAliases(source: ts.SourceFile): Map<string, string> {
  const aliases = new Map<string, string>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      let init: ts.Expression = node.initializer
      while (ts.isParenthesizedExpression(init)) init = init.expression
      const target = ts.isIdentifier(init)
        ? init.text
        : ts.isPropertyAccessExpression(init)
          ? init.name.text
          : undefined
      if (target && HOST_PLATFORM_FUNCTIONS.includes(target as never)) aliases.set(node.name.text, target)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return aliases
}

/**
 * 这次调用的实参是**转发本函数收到的形参**，还是**这里新造的一个平台值**？
 *
 * 为什么必须分这两类（#735）：原判据是「实参个数 > 0 即违规」，理由写着「显式传参只有两种来源：
 * 要么手上已有一个 platform（那它自己又是从哪来的），要么是写死的字面量」。**那句枚举漏了第三种**
 * ——把自己的可选形参一路透传下去，而那正是 `host-platform.ts` 的每个导出（`hostPlatform(userAgent?)`
 * / `isMacPlatform(userAgent?)` / `fileManagerName(platform?)` / `revealInFileManagerLabel(platform?)`）
 * 被设计出来支持的写法，lib 自己的注释也明写「参数一路传下去而不在这里兜默认值，`navigator` 缺席的
 * 处理就只有一处」。#610 的 `selectionForceGestureHint(userAgent?)` 是本仓第一处合法的带实参调用，
 * 于是这道门对**正确代码**打红——而本仓 #731 记过：对正确代码打红的守卫会被下一个作者整条删掉。
 *
 * 判据落在「这个值是它收到的，还是它造的」。所以只认**解析得到本函数（或任一外层函数）形参**的裸
 * 标识符；`'mac'`、模板串、`'mac' as string`、`x.slice()` 一律仍是违规。
 *
 * **刻意不写成「裸标识符就放过」**：那样 `const p = 'mac'; isMacPlatform(p)` 就溜过去了——平台照旧
 * 被钉死，只是多绕一个局部。必须解析到形参声明，局部变量不算。
 *
 * 而「解析到形参」必须按语言自己的作用域规则走，不能只在外层函数的形参表里找到同名就算数（本仓
 * #648/#654 两次被同名影子绕过）。同一个函数里 `const` 不能与形参同名（tsc 会红），所以影子只可能
 * 出现在**嵌套**函数里：`function f(platform?) { const g = () => { const platform = 'mac'; …(platform) } }`。
 * 因此自下而上走，先遇到声明该名字的局部就判「现造」，先遇到形参才判「透传」——谁先出现谁算。
 */
function forwardsAnEnclosingParameter(argument: ts.Expression): boolean {
  if (!ts.isIdentifier(argument)) return false
  const name = argument.text
  for (let scope: ts.Node | undefined = argument.parent; scope; scope = scope.parent) {
    // 这一层里有没有一个同名局部？有就是影子：这个值是这里造的，不是收到的。
    const statements = ts.isBlock(scope) || ts.isSourceFile(scope) ? scope.statements : undefined
    if (
      statements?.some(
        (statement) =>
          ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some(
            (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name
          )
      )
    ) {
      return false
    }
    if (
      ts.isFunctionDeclaration(scope) ||
      ts.isFunctionExpression(scope) ||
      ts.isArrowFunction(scope) ||
      ts.isMethodDeclaration(scope)
    ) {
      const declared = scope.parameters.some(
        (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name
      )
      if (declared) return true
    }
  }
  return false
}

function hostPlatformCallsIn(
  source: ts.SourceFile
): { name: string; line: number; minted: string[] }[] {
  const calls: { name: string; line: number; minted: string[] }[] = []
  const aliases = hostPlatformAliases(source)
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression, aliases)
      if (name && HOST_PLATFORM_FUNCTIONS.includes(name as never)) {
        calls.push({
          name,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          // 「这里新造出来的」那些实参。空集 = 要么零实参，要么每个都是透传下来的形参。
          minted: node.arguments
            .filter((argument) => !forwardsAnEnclosingParameter(argument))
            .map((argument) => argument.getText(source))
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return calls
}

/** 这个文件里出现的字符串/模板字面量文本——注释与标识符不算。 */
function literalsIn(source: ts.SourceFile): string[] {
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) out.push(node.text)
    else if (ts.isTemplateExpression(node)) {
      out.push(node.head.text, ...node.templateSpans.map((span) => span.literal.text))
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return out
}

/**
 * 随平台变化的「系统文件管理器」名字集，从 lib 的 SSOT（`fileManagerName`）派生，不手抄。
 *
 * lib 没有导出一张名字表，只导出 `fileManagerName(platform)`——那就是 SSOT 的取值口。所以这里把三态
 * 各自的名字取出来（Finder / File Explorer / File Manager），再补上各名字里**独占**的词（Explorer /
 * Finder / Manager）。独占的词才安全：共享词 "File" 同属 File Explorer 与 File Manager，单独禁它会误伤
 * "File changed on disk" 这类正当文案。lib 改名时这个集合自动跟上，不会 drift。
 */
function bannedFileManagerNames(): string[] {
  const fullNames = (['mac', 'windows', 'other'] as const).map((platform) => fileManagerName(platform))
  const wordCounts = new Map<string, number>()
  for (const name of fullNames) {
    for (const word of name.split(/\s+/)) wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1)
  }
  const distinctWords = [...wordCounts].filter(([, count]) => count === 1).map(([word]) => word)
  return [...new Set([...fullNames, ...distinctWords])]
}

/** 一段文本里**整词**命中的那些名字——`includes` 会把 "Explorer" 当 "File Explorer" 的子串，整词不会，
 * 也不会误伤把禁词当子串包住的合法标识符。 */
function matchedNamesIn(text: string, names: string[]): string[] {
  const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return names.filter((name) => new RegExp(`\\b${escape(name)}\\b`).test(text))
}

describe('host-platform：渲染层唯一的平台判定与随平台变化的文案', () => {
  it('三态各自给出自己的文件管理器名字，且互不相同', () => {
    // 三个名字必须互不相同，否则「按平台说对话」这件事本身没发生。逐个钉死字面量：它们是**用户看到
    // 的词**，不是内部标识符，改动要显式。
    expect(fileManagerName('mac')).toBe('Finder')
    expect(fileManagerName('windows')).toBe('File Explorer')
    expect(fileManagerName('other')).toBe('File Manager')
    const all: HostPlatform[] = ['mac', 'windows', 'other']
    expect(new Set(all.map((platform) => fileManagerName(platform))).size).toBe(3)
    // 完整措辞由名字派生，不另手抄一遍——把 `Reveal in ` 与名字拆开后才能这样断言。
    for (const platform of all) {
      expect(revealInFileManagerLabel(platform)).toBe(`Reveal in ${fileManagerName(platform)}`)
    }
  })

  it('平台判定认得三族，且 isMac 由它派生而不是第二条判定', () => {
    const macUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    const winUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    const linuxUa = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
    expect(hostPlatform(macUa)).toBe('mac')
    expect(hostPlatform(winUa)).toBe('windows')
    expect(hostPlatform(linuxUa)).toBe('other')
    // Linux 不是「出错了」：它要拿到 other 那档的中性名字，而不是 Finder 或 Explorer。
    expect(revealInFileManagerLabel(hostPlatform(linuxUa))).toBe('Reveal in File Manager')
    // isMac 与三态必须一致——写成独立的 includes('Mac') 就会在这里分岔。
    for (const ua of [macUa, winUa, linuxUa]) {
      expect(isMacPlatform(ua)).toBe(hostPlatform(ua) === 'mac')
    }
  })

  it('渲染层除 lib/host-platform.ts 外，任何文件都不得自己读 navigator 的平台', () => {
    // 这一条是「新抄一份」的检测器。等价性断言办不到：一份对今天正确的副本与 lib 行为完全相同，
    // 行为判据恒绿（[[equivalence-cannot-catch-a-fresh-copy]]），只有结构判据能抓。
    const offenders: string[] = []
    let scanned = 0
    for (const file of rendererSources()) {
      if (file === LIB_FILE) continue
      scanned += 1
      for (const line of platformReadsIn(parse(file))) {
        offenders.push(`${path.relative(RENDERER, file)}:${line}`)
      }
    }
    // 自检：扫描根写错或递归坏掉时，是这一条先红，而不是「零违规」静默通过。
    expect(scanned, '渲染层一个文件都没扫到——扫描根不对').toBeGreaterThan(200)
    expect(offenders, '改成从 lib/host-platform 取值：hostPlatform() / isMacPlatform()').toEqual([])
    // 反向自检：谓词本身要真能报出违规。lib 自己就是那个正例——它必须读得到 navigator。
    expect(platformReadsIn(parse(LIB_FILE)).length, 'lib 自己不读 navigator——谓词或 lib 有一个坏了').toBeGreaterThan(0)
    // 但「lib 被认出来」不足以证明谓词没被收窄：lib 用的正是最朴素的 `navigator.userAgent`，
    // 任何按接收者收窄的改法在它身上照旧命中。所以自检必须**自己带上那些绕过形状**——每一种
    // 接收者、以及元素访问，都要被认出来。review agent 实测存活的那次变异就是第二行这个形状。
    for (const shape of [
      'const a = navigator.userAgent',
      'const b = window.navigator.userAgent.includes("Mac")',
      'const c = globalThis.navigator.platform',
      'const d = navigator["userAgent"]',
      'const e = nav.platform'
    ]) {
      expect(platformReadsIn(parseText(shape)).length, `谓词认不出这个形状：${shape}`).toBeGreaterThan(0)
    }
    // 正交边界：同名的**声明**与字符串不是取值，不许误报，否则这道门会逼人把合法代码改坏。
    for (const benign of [
      'type T = { userAgent: string }',
      'const s = "navigator.userAgent"',
      '// navigator.userAgent',
      'function f(userAgent: string) { return userAgent }'
    ]) {
      expect(platformReadsIn(parseText(benign)), `谓词误报了：${benign}`).toEqual([])
    }
  })

  it('三个文件管理器名字（含短写 Explorer）只许在 lib 里当字面量出现', () => {
    // 上一条守「谁在算平台」，这一条守「谁在写那三个词」。两条都要：一个文件可以完全不碰 navigator，
    // 只把 `isMac ? 'Reveal in Finder' : …` 里的 isMac 从别处拿来，照旧手抄了文案。
    //
    // 此前禁词是手抄的 `['Finder', 'File Explorer', 'File Manager']`，用 `text.includes(name)` 比对。
    // review agent 实测它有两个洞：(1) 短写 "Explorer"（Windows 文件管理器的日常叫法）不是这三个的
    // 任何子串，把 EditorPane 改成 `{'Reveal in Explorer'}` 后 6/6 全绿、tsc 沉默；(2) 手抄的清单会与
    // lib 的 SSOT 漂移（[[duplicated-rule-defeats-the-fix]]）。改成：禁词集从 `fileManagerName()`
    // 派生（三态各自的名字 ＋ 各名字里独占的词），并按**整词**比对——`includes` 会把 "Explorer" 当
    // "File Explorer" 的子串重复命中，整词则各算各的，也不会误伤把禁词当子串包住的合法标识符。
    const names = bannedFileManagerNames()
    // 自检一：短写 "Explorer"（以及 "Finder" / "Manager"）确实进了禁词集——正是从前漏掉的那个洞。
    expect(names, '禁词集丢了短写形态（Explorer/Finder/Manager）').toEqual(
      expect.arrayContaining(['Finder', 'Explorer', 'Manager', 'File Explorer', 'File Manager'])
    )
    // 自检二：共享词 "File" 不能单独进禁词集——否则 "File changed on disk" 这类正当文案会被误伤。
    expect(names, '"File" 被单独禁了，会误伤正当文案').not.toContain('File')
    const offenders: string[] = []
    let scanned = 0
    for (const file of rendererSources()) {
      if (file === LIB_FILE) continue
      scanned += 1
      const relative = path.relative(RENDERER, file)
      for (const text of literalsIn(parse(file))) {
        // 判「这句话里整词出现某个文件管理器的名字」而不是「整句恰好等于某个名字」：真实的手抄是
        // 'Reveal in Finder' 这种带前缀的整句，逐字相等的判据抓不到它。
        for (const name of matchedNamesIn(text, names)) {
          offenders.push(`${relative}: ${JSON.stringify(text)} (${name})`)
        }
      }
    }
    expect(scanned).toBeGreaterThan(200)
    expect(
      offenders,
      '文件管理器的名字是随平台变化的文案，改成调 revealInFileManagerLabel() / fileManagerName()'
    ).toEqual([])
    // 自检：每个禁词都以整词形式住在 lib 的字面量里，所以上面那条不是因为谓词永远为假才绿的。
    // 用整词比对而不是数组成员判等——短写 "Explorer" 是 "File Explorer" 里的一个词，不是独立字面量。
    const inLibText = literalsIn(parse(LIB_FILE)).join('\n')
    for (const name of names) {
      expect(matchedNamesIn(inLibText, [name]), `lib 里找不到 ${name}——SSOT 的字面量不在这`).toEqual([name])
    }
  })

  it('每个需要平台的渲染层文件，都是 import 进来的——不是巧合地不碰 navigator', () => {
    // 只守「不许读 navigator」会漏掉另一半：一个文件可以既不读 navigator 也不 import lib，然后
    // 把 isMac 硬写成 true。所以这里正面数一遍消费者：谁 import 了 lib。
    //
    // 判据是 import 路径而不是标识符出现次数——`not.toContain('isMacPlatform(')` 这种写法在本仓被
    // 裸标识符绕过过（[[guard-criterion-must-be-import-relation]]）。
    const consumers: string[] = []
    for (const file of rendererSources()) {
      if (file === LIB_FILE) continue
      const source = parse(file)
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          if (/(^|\/)host-platform(\.js)?$/.test(node.moduleSpecifier.text)) {
            consumers.push(path.relative(RENDERER, file))
          }
        }
        ts.forEachChild(node, visit)
      }
      ts.forEachChild(source, visit)
    }
    // 平台在这个应用里被真正需要（快捷键修饰键、reveal 文案、文件树多选修饰键至少三族），所以消费者
    // 不可能是零个。这条断言把「全部改读 lib」的成果钉住：有人把某处改回内联时，它自己那条会红，
    // 而这条保证不会所有人一起悄悄退回去、只剩一个空 lib。
    expect(consumers.length, 'lib 一个消费者都没有——不是零手抄，是没人接').toBeGreaterThan(5)
    // reveal 这条文案的每个入口都必须在其中。硬写清单是有意的：它们是「用户能点到系统文件管理器」的
    // 全部入口，少一个就是那个入口在非 mac 上说错话，而删掉这份清单等于把这条门变成恒真。
    for (const entry of [
      'components/EditorPane.tsx',
      'components/WorkspaceWorkbench.tsx',
      'components/file-tree/FileTreeContextMenu.tsx'
    ]) {
      expect(consumers, `${entry} 要从 lib 取 reveal 文案`).toContain(entry)
    }
  })

  it('调用点必须让平台由 lib 自己探测——新造一个平台实参等于又判了一次平台', () => {
    // 上一条只证「import 声明在场」。它证不到**调用**：`revealInFileManagerLabel('mac')` 完全满足
    // import 关系，而那正是第三次手抄平台判定——在 Windows 上无条件说 "Reveal in Finder"。
    // review agent 实测过这条变异：改 WorkspaceWorkbench.tsx 里那处之后 desktop 全套 2921 条通过，
    // 两条失败与它无关。所以这里判**实参是从哪来的**。
    //
    // 判据是「这个值是它收到的，还是它造的」，不是「有没有实参」（#735 更正）。旧判据写的是
    // 「零实参」，理由里枚举了实参的两种来源（已持有的 platform / 写死的字面量）——**漏了第三种**：
    // 把自己的可选形参透传下去，而那是 lib 每个导出都刻意支持、且注释明写要求的写法。#610 的
    // `selectionForceGestureHint(userAgent?)` 是第一处合法带实参调用，旧判据对它打红。本仓 #731：
    // 对正确代码打红的守卫会被下一个作者删掉，所以修的是判据，不是那处生产代码。
    const offenders: string[] = []
    let seen = 0
    for (const file of rendererSources()) {
      if (file === LIB_FILE) continue
      for (const call of hostPlatformCallsIn(parse(file))) {
        seen += 1
        if (call.minted.length > 0) {
          offenders.push(
            `${path.relative(RENDERER, file)}:${call.line} ${call.name}(${call.minted.join(', ')})`
          )
        }
      }
    }
    // 前提自检：一个调用都没数到就说明谓词或遍历坏了，主断言会静默通过。今天有 10+ 处调用。
    expect(seen, '一个 host-platform 调用都没找到——判据失效，主断言恒绿').toBeGreaterThan(8)
    expect(
      offenders,
      '这些调用现造了一个平台实参。要么去掉（让 lib 的缺省参数探测），要么透传本函数收到的形参；' +
        '写死字面量就是 #384 那个 bug 本身'
    ).toEqual([])
    // 反向自检：谓词认得出**现造的**实参。否则上面那条是因为永远数不到而绿的。
    expect(
      hostPlatformCallsIn(parseText("const x = revealInFileManagerLabel('mac')")).map((c) => c.minted),
      '谓词认不出写死的字面量实参——这道门恒绿'
    ).toEqual([["'mac'"]])
    // 而且认得出 review agent 实测能溜过去的三种绕过写法：括号包住的 callee、别名、成员调用。
    // 每一种都硬把平台钉成 'mac'，从前的 `isIdentifier(node.expression)` 对它们全盲。
    for (const shape of [
      "const x = (revealInFileManagerLabel)('mac')",
      "const rl = revealInFileManagerLabel; const y = rl('mac')",
      "const z = lib.revealInFileManagerLabel('mac')"
    ]) {
      expect(
        hostPlatformCallsIn(parseText(shape)).map((c) => c.minted.length),
        `谓词认不出这个绕过写法：${shape}`
      ).toEqual([1])
    }
    // 正交边界一：朴素的零实参调用不许被误报成违规。
    expect(
      hostPlatformCallsIn(parseText('const x = revealInFileManagerLabel()')).flatMap((c) => c.minted),
      '谓词把零实参调用误报成带实参了'
    ).toEqual([])
    // 正交边界二（#735 的落点）：透传本函数形参是合法的，不许打红。这一条钉住的正是 #610 那处
    // 的形状——放宽必须**只**放宽到这里。
    expect(
      hostPlatformCallsIn(
        parseText('function hint(userAgent?: string) { return isMacPlatform(userAgent) }')
      ).flatMap((c) => c.minted),
      '透传本函数的形参被误报成「现造平台值」——#610 那处合法调用会被打假红'
    ).toEqual([])
    // 而放宽没有换来容忍度：绕一个局部变量把平台钉死，照旧是违规。「裸标识符就放过」会漏掉它。
    expect(
      hostPlatformCallsIn(parseText("const p = 'mac'; const x = isMacPlatform(p)")).flatMap(
        (c) => c.minted
      ),
      '局部变量洗一遍就溜过去了——判据必须解析到形参声明，不能只认标识符'
    ).toEqual(['p'])
    // 同名影子（本仓 #648/#654 那一族）：外层形参叫 platform，内层嵌套函数自己造一个同名局部。
    // 「在任一外层形参表里找到同名就放过」会被它整条绕开，故按作用域自下而上判、谁先出现算谁。
    expect(
      hostPlatformCallsIn(
        parseText(
          'function outer(platform?: string) {' +
            "  const inner = () => { const platform = 'mac'; return fileManagerName(platform) };" +
            '  return inner()' +
            '}'
        )
      ).flatMap((c) => c.minted),
      '同名局部影子被当成形参透传放过了——判据只比对了名字，没走作用域'
    ).toEqual(['platform'])
  })
})
