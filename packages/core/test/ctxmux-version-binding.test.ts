import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { CTXMUX_COMMIT, CTXMUX_VERSION } from '../src/ctxmux-run-adapter.js'

// ---------------------------------------------------------------------------
// 「运行时上报的 CtxMux 版本/commit 必须绑定到 SHA 校验过的那份原件」的接线守护（F2）。
//
// 由来：`client.ts` 的 `runtimeDiagnostics`（ctxmux.version / ctxmux.sourceCommit）与
// `terminalEnvironment`（TERM_PROGRAM_VERSION）、以及 `ctxmux-run-adapter.ts` 的 daemonEnvironment
// 曾各自**手抄**一份 '0.1.0' / 40 位 commit 字面量。可信原件是 `ctxmux-run-adapter.ts` 里的
// `CTXMUX_VERSION` / `CTXMUX_COMMIT`——那个模块在 load 时拿它们对着 SHA 校验过的 vendored
// manifest.json 断言（verifyArtifacts：manifest.source.commit===CTXMUX_COMMIT、
// manifest.product.version===CTXMUX_VERSION，由 CTXMUX_MANIFEST_SHA256 兜底）。手抄的那几处一旦
// vendored artifact 被 bump 就静默漂移，doctor/about 面自信地报错版本，且**没有编译错误**。
//
// 为什么判据必须是结构性的（AST），不能只写 `version === CTXMUX_VERSION` 这种行为断言：今天两边
// 的取值恰好相等，所以一份**新手抄**的字面量 `'0.1.0'` 对行为断言完全透明（本仓反复踩到的「等价性
// 抓不到新手抄的一份」）。承重的是「那个属性值就是 import 进来的那个标识符」，只有 parser 看得见。
//
// 判据：逐个消费点的属性值节点必须是**指定的那个已导入标识符**（`CTXMUX_VERSION` / `CTXMUX_COMMIT`），
// 不是字符串字面量、也不是别的名字。杀死的变异：把任一处改回 `'0.1.0'` / `'c13ab1…'`（StringLiteral
// 初始化器 → 立刻红），或引到错误的常量（Identifier 文本不符 → 红）。
//
// 本守卫看不见什么：
//   1. 它不执行代码，不证明 `CTXMUX_VERSION` 自身的取值对——那由 ctxmux-run-adapter 的 manifest 断言
//      与打包端到端契约（test/fixtures/reliability-stress-worker.mjs 断言 sourceCommit）负责。这里只
//      证明「三个消费点绑到了同一个已验证源」，不再各留一份可漂移的副本。
//   2. 它只看这两个文件里被点名的这几个属性键。别处新增的手抄不在雷达上。
//   3. `api.ts` 的 dev-mock（'CtxMux 0.1.0 · protocol 14'）在 peer 持有的 renderer 路径内，本轮不动，
//      故意不纳入扫描面（见任务说明）。
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const coreRoot = join(here, '..')
const clientPath = join(coreRoot, 'src', 'client.ts')
const adapterPath = join(coreRoot, 'src', 'ctxmux-run-adapter.ts')

const ADAPTER_MODULE_SPECIFIER = './ctxmux-run-adapter.js'

/** 每个消费点：文件、属性键、期望绑定到的已导入标识符。枚举而非过滤——过滤会让删掉一处的文件自己退出判据。 */
const BINDING_SITES = [
  { path: clientPath, key: 'version', expected: 'CTXMUX_VERSION' },
  { path: clientPath, key: 'sourceCommit', expected: 'CTXMUX_COMMIT' },
  { path: clientPath, key: 'TERM_PROGRAM_VERSION', expected: 'CTXMUX_VERSION' },
  { path: adapterPath, key: 'TERM_PROGRAM_VERSION', expected: 'CTXMUX_VERSION' }
] as const

function parse(path: string, source: string): ts.SourceFile {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

/**
 * 一个源码里，属性键为 `key` 的所有 PropertyAssignment 的初始化器节点。返回节点本身，让调用方去判
 * 「是不是那个标识符」。刻意收集**全部**同名键：若某处被改回字面量，它照样在集合里、照样被质询，
 * 而不是被过滤掉。
 */
function propertyValues(sourceFile: ts.SourceFile, key: string): ts.Expression[] {
  const values: ts.Expression[] = []
  const walk = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === key
    ) {
      values.push(node.initializer)
    }
    node.forEachChild(walk)
  }
  sourceFile.forEachChild(walk)
  return values
}

/** 判定：一个初始化器节点是否恰好是名为 `name` 的裸标识符引用（不是字符串、不是成员访问、不是调用）。 */
function isIdentifierReference(node: ts.Expression, name: string): boolean {
  return ts.isIdentifier(node) && node.text === name
}

/** 一个模块从 `specifier` 具名导入的标识符集合（用于证明 client.ts 真的从 adapter 引了这两个常量）。 */
function namedImportsFrom(sourceFile: ts.SourceFile, specifier: string): Set<string> {
  const names = new Set<string>()
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== specifier) continue
    const clause = statement.importClause
    if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue
    for (const element of clause.namedBindings.elements) {
      if (!element.isTypeOnly) names.add(element.name.text)
    }
  }
  return names
}

describe('CtxMux 运行时版本/commit 绑定到 SHA 校验过的原件（F2）', () => {
  const sources = new Map<string, ts.SourceFile>()
  for (const path of new Set(BINDING_SITES.map((site) => site.path))) {
    sources.set(path, parse(path, readFileSync(path, 'utf8')))
  }

  it('每个消费点的属性值都是那个已导入常量，而不是手抄的字面量', () => {
    for (const site of BINDING_SITES) {
      const values = propertyValues(sources.get(site.path)!, site.key)
      // 该键至少出现一次；出现的每一次都必须绑定到期望的标识符（否则「某一处被改回字面量」漏网）。
      expect(
        values.length,
        `${site.path} 里找不到属性键 ${site.key}——消费点被移走或改名了，判据已失去靶子`
      ).toBeGreaterThanOrEqual(1)
      for (const value of values) {
        expect(
          isIdentifierReference(value, site.expected),
          `${site.path} 的 ${site.key} 不是对已导入常量 ${site.expected} 的引用（值节点类型 ` +
            `${ts.SyntaxKind[value.kind]}）——手抄的字面量会在 artifact bump 时静默漂移`
        ).toBe(true)
      }
    }
  })

  it('client.ts 确实从 ctxmux-run-adapter 具名导入了这两个常量（否则绑的是别处的同名符号）', () => {
    const imported = namedImportsFrom(sources.get(clientPath)!, ADAPTER_MODULE_SPECIFIER)
    expect(imported.has('CTXMUX_VERSION'), 'client.ts 没从 adapter 导入 CTXMUX_VERSION').toBe(true)
    expect(imported.has('CTXMUX_COMMIT'), 'client.ts 没从 adapter 导入 CTXMUX_COMMIT').toBe(true)
  })

  it('自检：这两个常量确实是从 adapter 导出的运行时值（导入求值成功即证明可达）', () => {
    // 若 adapter 没导出它们，本文件顶部的 import 会在编译期失败；这里再对取值做一次形状断言，
    // 确保它们是非空字符串而不是某种意外的 undefined 透传。
    expect(typeof CTXMUX_VERSION).toBe('string')
    expect(CTXMUX_VERSION.length).toBeGreaterThan(0)
    expect(typeof CTXMUX_COMMIT).toBe('string')
    expect(CTXMUX_COMMIT).toMatch(/^[0-9a-f]{40}$/)
  })

  it('自检：若把某个消费点改回字面量，判据必红（证明它不是恒真）', () => {
    // 取 client.ts 真实源码，把 `version: CTXMUX_VERSION` 注入成 `version: '0.1.0'`，重跑同一判据。
    const original = readFileSync(clientPath, 'utf8')
    const mutated = original.replace('version: CTXMUX_VERSION', "version: '0.1.0'")
    expect(mutated, '注入替换没生效——被测锚点文本变了').not.toBe(original)
    const value = propertyValues(parse(clientPath, mutated), 'version')[0]!
    // 变异体里 version 的值是字符串字面量，isIdentifierReference 必须判 false（即判据会红）。
    expect(isIdentifierReference(value, 'CTXMUX_VERSION')).toBe(false)
    expect(ts.isStringLiteral(value)).toBe(true)
  })
})
