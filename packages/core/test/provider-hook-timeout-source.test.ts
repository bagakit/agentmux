import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { HOOK_COMMAND_TIMEOUT_SECONDS } from '../src/providers/shared.js'

// ---------------------------------------------------------------------------
// 「受管 Hook 命令超时只有一个 SSOT」的结构守护（F6）。
//
// 由来：`timeout: 10` 曾在八九个 provider 文件里各手抄一份，copilot 还用**另一个字段名** `timeoutSec: 10`
// （这个 CLI 的键带单位后缀，见 copilot.ts 文件头）。字段名的分歧是每个 CLI 的正当差异，保留；漂移的
// 只是那个值。现在集中到 `providers/shared.ts` 的 `HOOK_COMMAND_TIMEOUT_SECONDS`，各 provider 引用它。
//
// 为什么判据必须是结构性的（AST 文本），不能是行为断言：行为等价挡不住**新手抄一份 `10`**——一个新
// 写的 `timeout: 10` 产生的配置与引用常量的完全一样，任何 `expect(plan….timeout).toBe(10)` 对它透明。
// 承重的是「providers/ 下、timeout/timeoutSec 这两个属性位上，除了那一处 const 定义，不许出现裸数字」。
//
// 判据：递归扫描 `providers/*.ts`（含 shared.ts 那处 const 定义所在文件），用 TypeScript 自己的 parser
// 找出**所有**键为 `timeout` 或 `timeoutSec` 的 PropertyAssignment，其初始化器**不得**是数字字面量——
// 必须是对 `HOOK_COMMAND_TIMEOUT_SECONDS` 的标识符引用。用真 parser 而非正则：注释/字符串里的
// `timeout: 10` 天然不算；`timeoutSec` 这个拼法**显式**在扫描键集合里（少了它 copilot 就漏网，这正是
// 反复踩到的失败模式）。const 定义本身是 VariableDeclaration、不是 timeout 属性位，天然不在禁区内；
// 自检 3 额外证明它仍是那个数字字面量 SSOT。
//
// 本守卫看不见什么：
//   1. 不执行代码。它证明「这两个属性位上没有裸数字、且引用了那个常量」，不证明常量取值在运行时真的
//      被写进配置——那由各 provider 的行为测试（test/providers/*.test.ts、hook-config-merge）负责。
//   2. 只认 `timeout`/`timeoutSec` 这两个键名。某天冒出第三种拼法（如 `timeout_ms`）不在集合里，会漏；
//      自检 4 用一个注入的第三方拼法确保「新键名要显式加进来」这条被记住——但那需要人更新 FORBIDDEN_KEYS。
//   3. 只扫 providers/ 目录。别处的 hook 超时不在雷达上（今天只有 providers 写 hook 配置）。
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const providersDir = join(here, '..', 'src', 'providers')

/** 禁区键名。`timeoutSec` 必须在内——少了它，copilot 的 `timeoutSec: 10` 直接漏网（本 task 的关键点）。 */
const FORBIDDEN_KEYS = ['timeout', 'timeoutSec'] as const
const CONST_NAME = 'HOOK_COMMAND_TIMEOUT_SECONDS'

function providerFiles(): string[] {
  return readdirSync(providersDir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(providersDir, name))
}

function parse(path: string, source: string): ts.SourceFile {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

type Finding = { path: string; key: string; kind: string; text: string }

/**
 * 一份源码里，键为 timeout/timeoutSec 的每个 PropertyAssignment 的初始化器。返回节点信息让调用方质询。
 * 收集**全部**（不按「是不是字面量」过滤）：被改回字面量的那处照样在结果里、照样被判，不会因过滤而消失。
 */
function forbiddenKeyValues(sourceFile: ts.SourceFile, path: string): Finding[] {
  const found: Finding[] = []
  const walk = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      (FORBIDDEN_KEYS as readonly string[]).includes(node.name.text)
    ) {
      found.push({
        path,
        key: node.name.text,
        kind: ts.SyntaxKind[node.initializer.kind],
        text: node.initializer.getText(sourceFile)
      })
    }
    node.forEachChild(walk)
  }
  sourceFile.forEachChild(walk)
  return found
}

function isConstReference(finding: Finding): boolean {
  return finding.kind === ts.SyntaxKind[ts.SyntaxKind.Identifier] && finding.text === CONST_NAME
}

describe('受管 Hook 超时只有一个 SSOT（F6）', () => {
  const files = providerFiles()
  const findings = files.flatMap((path) => forbiddenKeyValues(parse(path, readFileSync(path, 'utf8')), path))

  it('providers/ 下 timeout/timeoutSec 属性位没有裸数字，全部引用 HOOK_COMMAND_TIMEOUT_SECONDS', () => {
    const offenders = findings.filter((finding) => !isConstReference(finding))
    expect(
      offenders,
      `这些 timeout/timeoutSec 属性位不是对 ${CONST_NAME} 的引用（多半是手抄的数字，会静默漂移）：\n` +
        offenders.map((o) => `  ${o.path} → ${o.key}: ${o.text} [${o.kind}]`).join('\n')
    ).toEqual([])
  })

  it('自检 1：判据非空——确实数到了若干个 timeout/timeoutSec 属性位', () => {
    // 若扫描面为空或键名匹配退化，上面那条会在空集上恒绿。HEAD 上有 10 处调用点（antigravity 两处）。
    expect(findings.length, '一个 timeout/timeoutSec 属性位都没扫到——扫描面或键匹配退化了').toBeGreaterThanOrEqual(9)
  })

  it('自检 2：copilot 的 timeoutSec 拼法确实在扫描结果里（少了它这个拼法就漏网）', () => {
    // 这是本 task 的关键点：只守 `timeout: <number>` 会漏掉 copilot 的 `timeoutSec`。
    const copilot = findings.filter((f) => f.path.endsWith('/copilot.ts') && f.key === 'timeoutSec')
    expect(copilot.length, 'copilot.ts 的 timeoutSec 没被扫到——timeoutSec 拼法漏出了守卫范围').toBeGreaterThanOrEqual(1)
    for (const finding of copilot) expect(isConstReference(finding)).toBe(true)
  })

  it('自检 3：SSOT 常量仍是那个数字字面量，且导出可达', () => {
    // 那一处 const 定义是允许的唯一裸数字。它是 VariableDeclaration，不在 timeout 属性位，故不被上面
    // 那条判为 offender；这里正面证明它存在、是数字、且 import 求值成功。
    expect(typeof HOOK_COMMAND_TIMEOUT_SECONDS).toBe('number')
    expect(HOOK_COMMAND_TIMEOUT_SECONDS).toBe(10)
    const shared = readFileSync(join(providersDir, 'shared.ts'), 'utf8')
    const decl = parse(join(providersDir, 'shared.ts'), shared).statements.find(
      (s): s is ts.VariableStatement =>
        ts.isVariableStatement(s) &&
        s.declarationList.declarations.some(
          (d) => ts.isIdentifier(d.name) && d.name.text === CONST_NAME
        )
    )
    expect(decl, `${CONST_NAME} 的 const 定义在 shared.ts 里找不到了`).toBeTruthy()
    const initializer = decl!.declarationList.declarations.find(
      (d) => ts.isIdentifier(d.name) && d.name.text === CONST_NAME
    )!.initializer
    expect(initializer && ts.isNumericLiteral(initializer), `${CONST_NAME} 不再是数字字面量 SSOT`).toBe(true)
  })

  it('自检 4：注入一份手抄的 timeout 字面量，判据必红（证明它不是恒真）', () => {
    // 取 claude.ts 真实源码，把 `timeout: HOOK_COMMAND_TIMEOUT_SECONDS` 注入回 `timeout: 10`，重跑判据。
    const claudePath = join(providersDir, 'claude.ts')
    const original = readFileSync(claudePath, 'utf8')
    const mutated = original.replace(`timeout: ${CONST_NAME}`, 'timeout: 10')
    expect(mutated, '注入替换没生效——被测锚点文本变了').not.toBe(original)
    const mutatedFindings = forbiddenKeyValues(parse(claudePath, mutated), claudePath)
    const offenders = mutatedFindings.filter((f) => !isConstReference(f))
    expect(offenders.length, '注入的 timeout: 10 没被判成 offender——守卫恒真').toBeGreaterThanOrEqual(1)
    expect(offenders[0]!.kind).toBe(ts.SyntaxKind[ts.SyntaxKind.NumericLiteral])
  })

  it('自检 5：注入一份 timeoutSec 字面量同样必红（timeoutSec 拼法真的在禁区内）', () => {
    const copilotPath = join(providersDir, 'copilot.ts')
    const original = readFileSync(copilotPath, 'utf8')
    const mutated = original.replace(`timeoutSec: ${CONST_NAME}`, 'timeoutSec: 10')
    expect(mutated, '注入替换没生效——被测锚点文本变了').not.toBe(original)
    const offenders = forbiddenKeyValues(parse(copilotPath, mutated), copilotPath).filter((f) => !isConstReference(f))
    expect(offenders.some((f) => f.key === 'timeoutSec'), 'timeoutSec: 10 没被判成 offender').toBe(true)
  })
})
