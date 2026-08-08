import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

/**
 * 名册的每一列都必须由真实数据算出来，而不是由一个没人传的入参"算"出来。
 *
 * 事故本身：`RosterRow` 上曾有一列 `unacknowledgedThreads: number`，注释写着「与 awaitingReply 并列，
 * 因为它们回答的是同一个问题」，界面上有一枚 `N msg` 徽标读它。它的值来自 `buildAgentRoster` 的一个
 * **可选**入参 `unacknowledgedThreads?: Record<string, number>`，而唯一调用点
 * （`AgentRoster.tsx` 里的 `buildAgentRoster({ sessions, providerCatalog })`）从不传它——于是每一行恒为 0，
 * 那枚徽标与它的 aria 文案是永不出现的死代码。它的两条测试自己构造入参来证明「传进去就带出来」，
 * 合成的 fixture 等于自证，恒绿（[[synthesized-fixture-is-self-certification]]）。
 *
 * 这里的判据刻意**不点名** `unacknowledgedThreads`：数一个符号名守不住下一个人换个拼法再抄一份
 * （[[counting-a-symbol-misses-other-spellings]]）。守的是让这类列成为可能的那两个结构：
 *
 *   A. 入参不许有可选成员——可选入参正是「这一列可以永久缺席」的那张许可证。改成必填，TypeScript
 *      自己就会逼每个调用点显式表态；一列的值到底从哪来，就成了调用点必须回答的问题。
 *   B. 行字面量的每个属性都必须由 `session`/`catalog` 派生——常量字面量是同一个谎的另一种写法。
 *      这一条有实测的先例：把 `usage: agentUsageDisplay(session)` 换成写死的
 *      `{kind:'unsupported',text:'',title:''}`，`agent-roster.test.ts` 那 23 条断言全绿，
 *      而用户看得见的 token 用量静默消失（那个 describe 的注释记着这次实测）。判定层有人守、
 *      接线层无人守，是本仓反复出现的形状。
 *
 *      B 的判据本轮加固过两层：第一版把「派生」判成「提到」（`referencesAny`），于是
 *      `workspacePath: session.id ? '' : ''` 被放行——`session` 在三元条件里出现，两支却是同一个
 *      常量 `''`，值恒为 `''`，这一列没接上真数据（review agent 实测 `2/2 green`、`16/16 combined`）。
 *      「提到 source」不是「值随 source 变」：条件里的 source 只有当两支的值**不同**时才真的左右结果。
 *      改用 {@link valueDependsOnSource} 判值依赖——三元两支相同即视为源无关常量。
 *
 *      第二层（本轮）：两支的「相同」此前用 `getText().trim()`（原始文本）比，于是
 *      `session.id ? '' : ""` 又绕过——两支运行期都是空串，只是一个单引号一个双引号，**文本**不同就
 *      被当成派生。这正是 191f607 给另外四条守卫治过的病在本文件的残留（「匹配一种拼法」而非
 *      「归一后比较」）。现在两支经 {@link canonicalConstant} 归一后再比：引号风格、`0`/`0x0` 这类
 *      等价拼法不再算「不同」。
 *
 *      第三层（本轮再补）：归一化此前只认**扁平字面量**两支，于是**嵌套常量三元**又绕过——
 *      `session.busy ? (x ? '' : '') : ''` 两支运行期都是 `''`，可 `(x ? '' : '')` 与 `''` 的文本不同，
 *      被当成派生（本轮实测这条 bypass 存活，见下方 `nestConst` 的成对自检）。现在 {@link canonicalConstant}
 *      **递归**归一三元、并穿透括号——它是纯**结构折叠**、不做算术求值，所以照旧不会误伤 `'a' : 'b'`
 *      这类真派生。注意这不需要 TypeChecker：两支各自折到同一常量身份，是语法层就看得穿的事。
 *
 * 两条都走 TS parser 而不是正则，且各自带在场自检：谓词永远为假、或扫描落空时，是自检先红，
 * 而不是「一个违规都没找到」静默通过（[[false-green-gate-patterns]]）。
 *
 * 仍在的盲点（诚实记录）：值依赖是**语法**层的，不做**算术/字符串求值**、常量折叠或跨变量数据流——
 * `const blank = ''; workspacePath: session.id ? blank : blank2` 若 `blank !== blank2` 逐字不同会被
 * 当成派生（哪怕两个变量运行期相等）；`session.id ? 'a' + 'b' : 'ab'`（要把 `'a'+'b'` 化简成 `'ab'` 才知两支
 * 相等）、`session.a ? (session, 'x') : 'x'`（逗号运算丢弃 session、要求值顺序分析）、以及把常量藏进一个
 * 提到 session 的 helper 调用（`f(session)` 而内部丢弃入参）都仍被算派生。**嵌套常量三元**曾在此列，
 * 本轮已由 {@link canonicalConstant} 的结构折叠收掉，不再是盲点。抓剩下这些要 TypeChecker 的常量求值
 * 与过程间分析，本文件是 createSourceFile 词法/语法走查够不到——这是有意接受的边界，不是遗漏。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIB = path.resolve(HERE, '../src/renderer/src/lib/agent-roster.ts')

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, ts.sys.readFile(file) ?? '', ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function parseText(text: string): ts.SourceFile {
  return ts.createSourceFile('synthetic.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

/** 具名函数声明。找不到时返回 undefined，由调用方断言在场。 */
function functionNamed(source: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  let found: ts.FunctionDeclaration | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return found
}

/**
 * 一个函数的入参里，声明为可选的那些成员名。
 *
 * 只看**内联的类型字面量**（`input: { a: X; b?: Y }`）——`buildAgentRoster` 就是这么写的，而写成内联
 * 字面量正是让「加一个可选字段」变成一行小改动的原因。参数自身的 `?`（`input?: {...}`）也算：那让整个
 * 入参可缺席，是同一张许可证的更大号版本。
 */
function optionalInputMembers(fn: ts.FunctionDeclaration): string[] {
  const optional: string[] = []
  for (const param of fn.parameters) {
    if (param.questionToken && ts.isIdentifier(param.name)) optional.push(param.name.text)
    const type = param.type
    if (!type || !ts.isTypeLiteralNode(type)) continue
    for (const member of type.members) {
      if (member.questionToken && member.name && ts.isIdentifier(member.name)) optional.push(member.name.text)
    }
  }
  return optional
}

/** 函数体里第一个含 `sessionId` 属性的对象字面量——投影出来的那一行。 */
function rowLiteralIn(fn: ts.FunctionDeclaration): ts.ObjectLiteralExpression | undefined {
  let found: ts.ObjectLiteralExpression | undefined
  const visit = (node: ts.Node): void => {
    if (
      found === undefined &&
      ts.isObjectLiteralExpression(node) &&
      node.properties.some(
        (property) => property.name !== undefined && ts.isIdentifier(property.name) && property.name.text === 'sessionId'
      )
    ) {
      found = node
      return
    }
    ts.forEachChild(node, visit)
  }
  if (fn.body) ts.forEachChild(fn.body, visit)
  return found
}

/** 子树里是否出现过这些标识符中的任意一个。用于 `touchesInput`：碰了入参**在哪都算**。 */
function referencesAny(node: ts.Node, names: readonly string[]): boolean {
  let hit = false
  const visit = (child: ts.Node): void => {
    if (hit) return
    if (ts.isIdentifier(child) && names.includes(child.text)) {
      hit = true
      return
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
  return hit
}

/**
 * 一个字面量结点的**归一化常量身份**——两个运行期相等的常量，无论怎么拼，都归到同一个字符串。
 *
 * 这一层是本轮修的：三元两支的比较此前直接用 `getText().trim()`（原始文本），于是
 * `session.id ? '' : ""` 被放行——两支运行期都是空串，但一个用单引号一个用双引号，**文本**不同，
 * 于是 `!==` 成立、被当成派生。这正是 191f607 给另外四条守卫治过的病（「匹配一种拼法」而非
 * 「归一后比较」）在本文件的残留：换个引号/数字写法就绕过同一档判据（[[counting-a-symbol-misses-other-spellings]]）。
 * 现在字符串按解析后的字符值比、数字按数值比、true/false/null 各归一，引号风格与 `0`/`0x0` 这类
 * 等价拼法不再算「不同」。
 *
 * 本轮再补一层**结构折叠**：括号原样穿透，三元**递归**归一——两支归一到同一身份，则整个三元就是那个
 * 常量，条件是什么都不影响。补这层的原因是先前它对非字面量一律 `getText()` 兜底，于是
 * `session.busy ? (x ? '' : '') : ''` 又绕过：两支运行期都是 `''`，可 `(x ? '' : '')` 与 `''` 的**文本**
 * 不同，被当成派生（本轮实测这条 bypass 存活，见下方 valueDependsOnSource 的成对自检里 `nestConst`）。
 * 关键是这层**不做算术/字符串求值**（`'a' + 'b'` 不化简为 `'ab'`），只做结构折叠——两支各自还折不出
 * 同一身份时仍落回 `getText()` 兜底当「不同」，宁可漏抓也不误伤。
 */
function canonicalConstant(node: ts.Node): string {
  let current: ts.Node = node
  while (ts.isParenthesizedExpression(current)) current = current.expression
  if (ts.isConditionalExpression(current)) {
    const whenTrue = canonicalConstant(current.whenTrue)
    const whenFalse = canonicalConstant(current.whenFalse)
    // 两支归一到同一常量身份→整个三元就是那个常量；否则落回原始文本兜底当「不同」。
    return whenTrue === whenFalse ? whenTrue : `text:${current.getText().trim()}`
  }
  if (ts.isStringLiteralLike(current)) return `str:${current.text}`
  if (ts.isNumericLiteral(current)) return `num:${Number(current.text)}`
  if (current.kind === ts.SyntaxKind.TrueKeyword) return 'bool:true'
  if (current.kind === ts.SyntaxKind.FalseKeyword) return 'bool:false'
  if (current.kind === ts.SyntaxKind.NullKeyword) return 'null'
  return `text:${current.getText().trim()}`
}

/**
 * 这个表达式的**值**是否会随 `sources` 改变——即它是不是真的从 session/catalog **派生**，而不只是
 * 顺口**提到**了它们。
 *
 * 这是本轮修的核心：第一版用 `referencesAny`（提到即算派生），于是 `session.id ? '' : ''` 被放行——
 * `session` 出现在三元的**条件**里，但两个分支都是常量 `''`，无论 session 是什么值都恒为 `''`，
 * 这一列根本没接上真数据。review agent 实测这个 bypass `2/2 green`（记忆
 * expected-value-must-not-derive-from-mutation-target 的同族：判据比它自称守的事弱）。
 *
 * 「提到」与「派生」的区别落在**三元条件**上：条件决定走哪一支，只有当两支的值**不同**时，条件里的
 * source 才真的能改变结果；两支归一后相等（`? '' : ''`、`? '' : ""`、`? 0 : 0x0`）时条件无关紧要，值是
 * 源无关的常量。别处（属性访问、调用实参、二元运算元、下标）里出现 source 都是值位，直接算派生。
 *
 * 两支的相等用 {@link canonicalConstant} 归一后比，而非原始文本：见其说明——文本比只认一种拼法，
 * 换引号或换数字写法就把恒等的两支伪装成「不同」而绕过。
 */
function valueDependsOnSource(node: ts.Node, sources: readonly string[]): boolean {
  if (ts.isIdentifier(node)) return sources.includes(node.text)
  if (ts.isConditionalExpression(node)) {
    if (valueDependsOnSource(node.whenTrue, sources) || valueDependsOnSource(node.whenFalse, sources)) return true
    // 分支的值都与 source 无关：只有当条件提到 source **且**两支归一后不相等，条件才真的左右结果。
    return (
      referencesAny(node.condition, sources) &&
      canonicalConstant(node.whenTrue) !== canonicalConstant(node.whenFalse)
    )
  }
  let dependent = false
  ts.forEachChild(node, (child) => {
    if (!dependent && valueDependsOnSource(child, sources)) dependent = true
  })
  return dependent
}

/**
 * 行字面量里**不合格**的属性名。
 *
 * 合格的定义有两条，必须同时满足：
 *   1. 值真的从 `sources`（循环变量 `session` / 本地 `catalog`）**派生**——不是顺口提到。简写属性
 *      （`{ sessionId }`）算派生：它的值就是那个同名局部变量。判据是 {@link valueDependsOnSource}
 *      而非 `referencesAny`：本轮修的正是这条。第一版用「提到即算派生」，于是
 *      `workspacePath: session.id ? '' : ''` 被放行——`session` 在三元条件里出现，但两支都是常量 `''`，
 *      值恒为 `''`，这一列没接上真数据（review agent 实测 `2/2 green`、`16/16 combined`）。
 *      「提到」不等于「派生」：条件里的 source 只有在两支的值不同时才真的能改变结果。
 *   2. 值**不**碰入参对象（`forbidden`，即 `input`）。这一条是写这个文件时被自己的自检逼出来的：
 *      事故的原样是 `unacknowledgedThreads: input.unacknowledgedThreads?.[session.id] ?? 0`，它在下标里
 *      提到了 `session`，于是只判「派生自 session」的谓词对它完全放行——那条判据会漏掉它本来要抓的
 *      那一行（[[mutation-must-change-one-thing]] 的同族：判据比它自称守的事弱）。列的值只能来自这一
 *      行的 session 和 Provider catalog；再从入参侧取一次，就是给「这一列可以按调用点缺席」开的口子。
 *      `touchesInput` 用 `referencesAny`：碰了入参在哪都算，包括藏在下标里。
 *
 * 展开（`...x`）报为不合格：它把「这一列从哪来」这个问题藏进另一个对象。
 */
function underivedProperties(
  literal: ts.ObjectLiteralExpression,
  sources: readonly string[],
  forbidden: readonly string[]
): string[] {
  const offenders: string[] = []
  for (const property of literal.properties) {
    if (ts.isSpreadAssignment(property)) {
      offenders.push('...展开')
      continue
    }
    const name = property.name !== undefined && ts.isIdentifier(property.name) ? property.name.text : '<非标识符键>'
    if (ts.isShorthandPropertyAssignment(property)) {
      if (!sources.includes(name)) offenders.push(name)
      continue
    }
    if (!ts.isPropertyAssignment(property)) {
      offenders.push(name)
      continue
    }
    const derived = valueDependsOnSource(property.initializer, sources)
    const touchesInput = referencesAny(property.initializer, forbidden)
    if (!derived || touchesInput) offenders.push(name)
  }
  return offenders
}

describe('名册只有一条"这一行需要我吗"的轴，且每一列都真的接上了', () => {
  const source = parse(LIB)
  const build = functionNamed(source, 'buildAgentRoster')

  // 为什么每条自检各占一个 it（#742，本轮实测）：这两条门原先各把「谓词自检」与「生产判据」挤在
  // 同一个 it 里，且生产判据排在最后。于是任何一条自检失败都让生产判据变成**死代码**——变异
  // 「canonicalConstant 不再递归三元」实测只打红 nested 那条自检，`underivedProperties(literal!)`
  // 那句从未执行（记忆 two-throws-in-one-it-mask-each-other）。判别器：两个不同变异若报出同一个
  // 用例名，它们就在互相掩盖。拆开之后每个变异各红各的，计数本身也变成了可读的信号。
  it('前提自检：扫描确实落在 buildAgentRoster 上', () => {
    expect(build, 'buildAgentRoster 不在 agent-roster.ts 里了——这条门的扫描落空了').toBeDefined()
  })

  it('前提自检：optionalInputMembers 抓得到可选成员与整个可选入参', () => {
    // 谓词自检：现场合成一份带可选成员的入参，它必须被抓到。少了这一步，`optionalInputMembers`
    // 恒返回空数组也会让生产判据绿着——那正是它要防的形状。
    const synthetic = functionNamed(
      parseText(
        'export function buildAgentRoster(input: { sessions: readonly S[]; unreadCount?: Record<string, number> }): R[] { return [] }'
      ),
      'buildAgentRoster'
    )
    expect(optionalInputMembers(synthetic!)).toEqual(['unreadCount'])
    // 整个入参可缺席是同一张许可证的更大号版本，也要抓得到。
    const wholeParam = functionNamed(parseText('export function f(input?: { a: number }): void {}'), 'f')
    expect(optionalInputMembers(wholeParam!)).toEqual(['input'])
  })

  it('前提自检：全必填的入参不许被误报', () => {
    // 反向：否则这条门只是恒红，修法把合法写法一起收进来也不会有人发现。
    const clean = functionNamed(parseText('export function f(input: { a: number; b: string }): void {}'), 'f')
    expect(optionalInputMembers(clean!)).toEqual([])
  })

  it('入参没有可选成员——可选入参就是"这一列可以永久缺席"的许可证', () => {
    expect(optionalInputMembers(build!)).toEqual([])
  })

  it('前提自检：投影那一行的对象字面量找得到，且确实是一整排列', () => {
    const literal = rowLiteralIn(build!)
    expect(literal, '投影那一行的对象字面量找不到了——判据落在了空处').toBeDefined()

    // 在场自检：这一行确实有一整排列，而不是扫到了某个只有 sessionId 的小对象。少了这条，
    // 字面量被改成两三个属性时这条门会安静地缩小覆盖面。
    const names = literal!.properties.map((property) =>
      property.name !== undefined && ts.isIdentifier(property.name) ? property.name.text : '?'
    )
    expect(names.length).toBeGreaterThan(8)
    expect(names).toContain('awaitingReply')
    expect(names).toContain('usage')
  })

  it('前提自检：四种"没人喂数"的写法都被抓到（含"提到但不派生"的伪装）', () => {
    // 谓词自检：四种写法都必须被抓到——写死的常量、从入参兜底取值（事故原样，注意它下标里
    // 提到了 `session`，只判「派生自 session」会放行它）、展开、以及**「提到但不派生」的伪装**
    // （`session.id ? '' : ''`：条件里提到 session，两支却是同一个常量，值恒为 ''）——最后这种正是
    // review agent 测得 2/2 green 的 bypass。
    const synthetic = rowLiteralIn(
      functionNamed(
        parseText(
          `function f(input: I) { return [{ sessionId: session.id, usage: { kind: 'unsupported', text: '', title: '' }, workspacePath: session.id ? '' : '', unreadCount: input.unacknowledgedThreads?.[session.id] ?? 0, ...extra }] }`
        ),
        'f'
      )!
    )
    expect(underivedProperties(synthetic!, ['session', 'catalog'], ['input'])).toEqual([
      'usage',
      'workspacePath',
      'unreadCount',
      '...展开'
    ])
  })

  it('前提自检：真的从 session/catalog 派生的字面量不许被误报', () => {
    // 反向：否则这条门只是恒红。这里成对钉住「三元条件里用 source 决定两个**不同**的真值」是合法
    // 派生——修法不能把这种正常写法一并误伤。
    const clean = rowLiteralIn(
      functionNamed(
        parseText(
          `function f() { return [{ sessionId: session.id, scopes: g(catalog), attention: session.busy ? 'a' : 'b' }] }`
        ),
        'f'
      )!
    )
    expect(underivedProperties(clean!, ['session', 'catalog'], ['input'])).toEqual([])
  })

  it('前提自检：三元两支运行期恒等、只是拼法不同也算"没人喂数"', () => {
    // 归一化自检（本轮加的第二层）：三元两支运行期恒等、只是拼法不同（引号风格 `'' : ""`、
    // 数字写法 `0 : 0x0`）也必须被抓——否则换个拼法就复活「提到但不派生」的 bypass。这一对成对钉住：
    // 恒等两支报为不合格，同一列换成**真的不同**的两支（`'a' : 'b'`）仍合法，修法不误伤正常派生。
    const spellings = rowLiteralIn(
      functionNamed(
        parseText(
          `function f() { return [{ sessionId: session.id, quoteConst: session.id ? '' : "", numConst: session.id ? 0 : 0x0, realDerive: session.busy ? 'a' : 'b' }] }`
        ),
        'f'
      )!
    )
    expect(underivedProperties(spellings!, ['session', 'catalog'], ['input'])).toEqual(['quoteConst', 'numConst'])
  })

  it('前提自检：嵌套常量三元也算"没人喂数"', () => {
    // 结构折叠自检（本轮加的第三层）：**嵌套常量三元**必须被抓。此前 canonicalConstant 只认扁平字面量
    // 两支，对非字面量落 getText() 兜底，于是 `session.busy ? (x ? '' : '') : ''` 存活——两支运行期都是
    // '' 却因 `(x ? '' : '')` 与 '' 文本不同被当成派生。
    // 死掉的确切变异：把 canonicalConstant 退回「只认扁平字面量、非字面量一律 getText() 兜底」（删掉它
    // 里面穿透括号 + 递归归一三元那一段），本条 nestConst 立刻从 offenders 消失、**本条**由绿转红。
    // 这一对成对钉住：嵌套常量三元报为不合格，同一列换成**真的不同**的嵌套两支
    // （`session.a ? (session.b ? 'z' : 'y') : 'x'`）仍合法，修法不误伤。
    // 仍不覆盖（诚实记录，见文件头）：算术折叠 `? 'a'+'b' : 'ab'`、逗号运算 `? (session,'x') : 'x'`、
    // 跨变量 `? blank : blank2`——它们要 TypeChecker 的常量求值/过程间分析，语法层够不到。
    const nested = rowLiteralIn(
      functionNamed(
        parseText(
          `function f() { return [{ sessionId: session.id, nestConst: session.busy ? (x ? '' : '') : '', realNest: session.a ? (session.b ? 'z' : 'y') : 'x' }] }`
        ),
        'f'
      )!
    )
    expect(underivedProperties(nested!, ['session', 'catalog'], ['input'])).toEqual(['nestConst'])
  })

  it('每一列都由 session/catalog 派生——写死的常量是"没人喂数"的另一种写法', () => {
    const literal = rowLiteralIn(build!)
    expect(underivedProperties(literal!, ['session', 'catalog'], ['input'])).toEqual([])
  })
})
