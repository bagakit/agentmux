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
 * 两条都走 TS parser 而不是正则，且各自带在场自检：谓词永远为假、或扫描落空时，是自检先红，
 * 而不是「一个违规都没找到」静默通过（[[false-green-gate-patterns]]）。
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

/** 子树里是否出现过这些标识符中的任意一个。 */
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
 * 行字面量里**不合格**的属性名。
 *
 * 合格的定义有两条，必须同时满足：
 *   1. 值从 `sources`（循环变量 `session` / 本地 `catalog`）派生。简写属性（`{ sessionId }`）算派生
 *      ——它的值就是那个同名局部变量。
 *   2. 值**不**碰入参对象（`forbidden`，即 `input`）。这一条是写这个文件时被自己的自检逼出来的：
 *      事故的原样是 `unacknowledgedThreads: input.unacknowledgedThreads?.[session.id] ?? 0`，它在下标里
 *      提到了 `session`，于是只判「派生自 session」的谓词对它完全放行——那条判据会漏掉它本来要抓的
 *      那一行（[[mutation-must-change-one-thing]] 的同族：判据比它自称守的事弱）。列的值只能来自这一
 *      行的 session 和 Provider catalog；再从入参侧取一次，就是给「这一列可以按调用点缺席」开的口子。
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
    const derived = referencesAny(property.initializer, sources)
    const touchesInput = referencesAny(property.initializer, forbidden)
    if (!derived || touchesInput) offenders.push(name)
  }
  return offenders
}

describe('名册只有一条"这一行需要我吗"的轴，且每一列都真的接上了', () => {
  const source = parse(LIB)
  const build = functionNamed(source, 'buildAgentRoster')

  it('入参没有可选成员——可选入参就是"这一列可以永久缺席"的许可证', () => {
    expect(build, 'buildAgentRoster 不在 agent-roster.ts 里了——这条门的扫描落空了').toBeDefined()

    // 谓词自检：现场合成一份带可选成员的入参，它必须被抓到。少了这一步，`optionalInputMembers`
    // 恒返回空数组也会让这条断言绿着——那正是它要防的形状。
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
    // 反向：全必填的入参不许被误报，否则这条门只是恒红。
    const clean = functionNamed(parseText('export function f(input: { a: number; b: string }): void {}'), 'f')
    expect(optionalInputMembers(clean!)).toEqual([])

    expect(optionalInputMembers(build!)).toEqual([])
  })

  it('每一列都由 session/catalog 派生——写死的常量是"没人喂数"的另一种写法', () => {
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

    // 谓词自检：三种写法都必须被抓到——写死的常量、从入参兜底取值（事故原样，注意它下标里
    // 提到了 `session`，只判「派生自 session」会放行它）、以及展开。
    const synthetic = rowLiteralIn(
      functionNamed(
        parseText(
          `function f(input: I) { return [{ sessionId: session.id, usage: { kind: 'unsupported', text: '', title: '' }, unreadCount: input.unacknowledgedThreads?.[session.id] ?? 0, ...extra }] }`
        ),
        'f'
      )!
    )
    expect(underivedProperties(synthetic!, ['session', 'catalog'], ['input'])).toEqual([
      'usage',
      'unreadCount',
      '...展开'
    ])
    // 反向：全部从 session/catalog 派生的字面量不许被误报，否则这条门只是恒红。
    const clean = rowLiteralIn(
      functionNamed(parseText(`function f() { return [{ sessionId: session.id, scopes: g(catalog) }] }`), 'f')!
    )
    expect(underivedProperties(clean!, ['session', 'catalog'], ['input'])).toEqual([])

    expect(underivedProperties(literal!, ['session', 'catalog'], ['input'])).toEqual([])
  })
})
