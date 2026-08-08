import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  HOOK_COMMAND_TIMEOUT_SECONDS,
  HOOK_COMMAND_TIMEOUT_FIELD,
  hookCommandTimeout
} from '../src/providers/shared.js'
import { BUILT_IN_AGENT_PROVIDER_IDS } from '../src/agent-provider-id.js'
import { resolveManagedHookPlan } from '../src/agent-provider.js'

// ---------------------------------------------------------------------------
// 「受管 Hook 命令超时只有一个 SSOT——值与键都是」的守卫（F6）。
//
// 由来：`timeout: 10` 曾在九个 provider 文件（antigravity 两处，共十处）里各手抄一份，copilot 还用
// **另一个字段名** `timeoutSec: 10`（那个 CLI 的键带单位后缀，写 `timeout` 会被静默剥掉、退回它自己的默认
// 超时——见 copilot.ts 文件头的实测记录）。字段名的分歧是**每个 CLI 的正当差异**，保留；漂移的是那个值、
// 以及「谁该用哪个键」这件事本身。现在两者都收进 `providers/shared.ts`：值是 `HOOK_COMMAND_TIMEOUT_SECONDS`，
// 键是 `HOOK_COMMAND_TIMEOUT_FIELD`（`satisfies Record<BuiltInAgentProviderId, …>`），二者由
// `hookCommandTimeout(providerId)` 用**计算属性**一起派生——各 provider `spread` 它，属性位上不再有任何
// 可供手抄的字面量。
//
// 为什么这道守卫必须走**类型检查器**、不能只做文本/行为判据（本仓这一族守卫反复踩的三个坑，逐一对应）：
//   坑① 行为等价挡不住「新手抄一份 `10`」：一个新写的 `timeout: 10` 产生的配置与派生自常量的完全一样，
//        任何 `expect(plan….timeout).toBe(10)` 对它透明。→ 判据 B 用 `getTypeChecker` 证明 helper 返回对象的
//        **值就是那个导出符号本身**，不是恰好等于 `10` 的另一处字面量。已实测：把值换成字面量 `10`，
//        `getSymbolAtLocation` 解析不到目标符号，判据 B 立即红（自检 B2）。
//   坑② 数符号出现次数会被另一种拼法绕过：数 `HOOK_COMMAND_TIMEOUT_SECONDS` 出现几次，挡不住有人内联
//        `10`。→ 判据 A 不数符号，而是用 TypeScript 自己的 parser 枚举 `providers/` 下 `timeout`/`timeoutSec`
//        这两个属性位上的**每一个** PropertyAssignment，断言它们的初始化器都不是数字字面量。注释/字符串里的
//        `timeout: 10` 天然不算（走 parser 不走正则）。`timeoutSec` 显式在禁区键集合里（少了它 copilot 漏网，
//        这正是本 task 的关键点）。重构后这两个属性位已归零——键改成计算属性了——所以判据 A 今天扫到 0 个
//        offender 是**正确**的绿；真正防「有人把 helper 拆开、又在某个 provider 里手写回 `timeout: 10`」。
//   坑③ 加一家 provider 却忘了给它定超时键，运行时无迹可寻：union 会拓宽成 string。→ 判据 C 让
//        `HOOK_COMMAND_TIMEOUT_FIELD` 以 `satisfies Record<BuiltInAgentProviderId, …>` 钉在**值层**的
//        id 元组上（判据 C 双向比对键集合），而 `hookCommandTimeout` 的入参类型把映射为 `null` 的 provider
//        排除在编译期——加一家新 provider 不在表里就**编译失败**。编译期实验（加第 14 家跑 `tsc --noEmit`
//        看真报错）记录在本 task 的交付说明里，比任何运行时断言都硬。
//
// 本守卫看不见什么（未消除的盲点，照实写在这里）：
//   1. 判据 A/A2/B 不执行代码——它们证明「属性位没有裸数字、且 helper 的值是那个常量符号」，不证明这个值
//      在运行时真的被写进配置。**这条缝由本文件末尾的判据 D 补上**（走 `resolveManagedHookPlan` 的真实
//      产物、两个方向都断言）。
//      〔已撤回的旧说法，留在这里以免有人再信它〕本段原先写的是「那由各 provider 的行为测试（test/providers/*.test.ts
//      逐家 parse 出 JSON 断言 timeout 等于常量）负责。两层配对交付，缺一层都留洞」——**这句话在本仓是假的**：
//      实测 `grep -ln timeout test/providers/*.ts` 只有 copilot / droid / cursor / hermes **四家**，
//      九家非 null 里 codex / claude / grok / gemini / antigravity 这五家在行为侧根本没有这条断言。
//      于是「漏写整段超时」曾经无人守：删掉 grok.ts 的 `...hookCommandTimeout('grok')` 实测
//      `Tests 254 passed (254)`，完全存活。判据 D 就是为这个存活变异写的。
//   2. 判据 A（AST）认 `timeout`/`timeoutSec` 这两个**键名**的三种等价拼法——标识符键、字符串字面量键
//      `'timeout':`、常量字符串计算键 `['timeout']:`，由 `propertyKeyName` 归一（自检 A4）。它对**非字面量计算键**
//      （`[localVar]:` 或 `[map[id]]:`，键名不是编译期常量字符串）失明——但那条缝由**判据 A2**（类型检查器）补上：
//      凡计算键的**类型**解析到 `'timeout'`/`'timeoutSec'` 的属性位，其值必须是 SSOT 符号，否则红（自检 A2a/A2b
//      分别复现审查者报的 D2「键索引 SSOT 映射、值手抄 10」与 D1「字面量类型本地 const 作键」两种绕过）。
//      **仍失明的一处**：某天冒出第三种键名（如 `timeout_ms`）不在 `FORBIDDEN_KEYS` 里，判据 A/A2 都不认——但判据 C
//      的 `satisfies` 仍会因「新 provider 没进 `HOOK_COMMAND_TIMEOUT_FIELD` 表」而编译失败，逼人回到有意识的选择
//      （自检 A3 钉住这条）。运行时才知道的动态键（`[cond ? 'timeout' : 'x']` 之类类型拓宽成 `string` 的）也在判据
//      A2 射程外，但那种写法在 provider 配置里没有正当理由，且判据 B 仍守着 helper 这条正路。
//   3. 判据 A/A2/B 只扫 `providers/` 目录（判据 B 聚焦 `shared.ts` 的 helper）。别处若也写 hook 命令超时不在雷达上
//      （今天只有 providers 写 hook 配置，且都过 `hookCommandTimeout`）。
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const providersDir = join(here, '..', 'src', 'providers')
const sharedPath = join(providersDir, 'shared.js') // 类型检查器用的是 tsconfig 里的 .ts；.js 仅用于运行时 import 对照
const sharedTsPath = join(providersDir, 'shared.ts')

/** 禁区键名。`timeoutSec` 必须在内——少了它，copilot 的 `timeoutSec` 这个拼法直接漏出守卫（本 task 的关键点）。 */
const FORBIDDEN_KEYS = ['timeout', 'timeoutSec'] as const
const CONST_NAME = 'HOOK_COMMAND_TIMEOUT_SECONDS'
const HELPER_NAME = 'hookCommandTimeout'
const FIELD_MAP_NAME = 'HOOK_COMMAND_TIMEOUT_FIELD'

function providerFiles(): string[] {
  return readdirSync(providersDir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(providersDir, name))
}

function parse(path: string, source: string): ts.SourceFile {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

// --- 判据 A：文本/AST 层——providers/ 下 timeout/timeoutSec 属性位不许出现裸数字 ----------------------

type Finding = { path: string; key: string; kind: string; text: string }

/**
 * 一个 PropertyAssignment 的**键名文本**，把三种等价拼法归一：标识符键 `timeout:`、字符串字面量键
 * `'timeout':`、以及常量字符串的计算键 `['timeout']:`。三者产生的属性名在运行时完全一样，所以守卫必须一视同仁——
 * 只认 `ts.isIdentifier(name)` 会被 `{ 'timeout': 10 }` / `{ ['timeout']: 10 }` 绕过（本仓「禁止清单守卫必漏」
 * 一族的经典口子：换个拼法就溜过去）。返回 `null` 表示键名不是编译期常量字符串（如 `[someVar]:`），那种情形
 * 键名无法静态判定，不在本守卫射程内（见文件头盲点声明）。
 */
function propertyKeyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text
  if (ts.isComputedPropertyName(name)) {
    const expr = name.expression
    if (ts.isStringLiteralLike(expr)) return expr.text
  }
  return null
}

/**
 * 一份源码里，键为 timeout/timeoutSec 的每个 PropertyAssignment 的初始化器。收集**全部**（不按「是不是
 * 字面量」过滤）：被改回字面量的那处照样在结果里、照样被判，不会因过滤而消失。键名经 {@link propertyKeyName}
 * 归一，所以标识符 / 字符串字面量 / 常量计算键三种拼法都算——换拼法绕不过去。运行时计算键 `[expr]: …`
 * （非常量字符串）静态判不出键名，不在此列，本守卫对它失明（见文件头盲点 2）。
 */
function forbiddenKeyValues(sourceFile: ts.SourceFile, path: string): Finding[] {
  const found: Finding[] = []
  const walk = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const key = propertyKeyName(node.name)
      if (key !== null && (FORBIDDEN_KEYS as readonly string[]).includes(key)) {
        found.push({
          path,
          key,
          kind: ts.SyntaxKind[node.initializer.kind],
          text: node.initializer.getText(sourceFile)
        })
      }
    }
    node.forEachChild(walk)
  }
  sourceFile.forEachChild(walk)
  return found
}

function isNumericLiteral(finding: Finding): boolean {
  return (
    finding.kind === ts.SyntaxKind[ts.SyntaxKind.NumericLiteral] ||
    finding.kind === ts.SyntaxKind[ts.SyntaxKind.FirstLiteralToken] // 数字字面量在部分 TS 版本报作 FirstLiteralToken
  )
}

// --- 判据 B/C 用的类型检查器程序（真 Program，over shared.ts，用仓库 tsconfig）---------------------

type CheckerCtx = { checker: ts.TypeChecker; sourceFile: ts.SourceFile; targetSymbol: ts.Symbol | undefined }

/** 建一个覆盖 shared.ts 的真 Program。可选地在内存里替换它的源码，用来跑「注入变异」自检。 */
function programForShared(sourceOverride?: string): CheckerCtx {
  const configPath = ts.findConfigFile(join(here, '..'), ts.sys.fileExists, 'tsconfig.json')
  if (!configPath) throw new Error('找不到 packages/core/tsconfig.json——类型检查器守卫无法建立 Program')
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(`tsconfig 解析失败：${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`)
    }
  })
  if (!parsed) throw new Error('tsconfig 解析返回空——类型检查器守卫无法建立 Program')

  const host = ts.createCompilerHost(parsed.options)
  if (sourceOverride != null) {
    const origGetSF = host.getSourceFile.bind(host)
    host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreate) => {
      if (fileName === sharedTsPath) {
        return ts.createSourceFile(fileName, sourceOverride, languageVersionOrOptions, true, ts.ScriptKind.TS)
      }
      return origGetSF(fileName, languageVersionOrOptions, onError, shouldCreate)
    }
    const origReadFile = host.readFile.bind(host)
    host.readFile = (fileName) => (fileName === sharedTsPath ? sourceOverride : origReadFile(fileName))
  }

  const program = ts.createProgram({ rootNames: [sharedTsPath], options: parsed.options, host })
  const checker = program.getTypeChecker()
  const sourceFile = program.getSourceFile(sharedTsPath)
  if (!sourceFile) throw new Error('类型检查器拿不到 shared.ts 的 SourceFile')
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile)
  const targetSymbol = moduleSymbol
    ? checker.getExportsOfModule(moduleSymbol).find((s) => s.getName() === CONST_NAME)
    : undefined
  return { checker, sourceFile, targetSymbol }
}

/**
 * 在 `hookCommandTimeout` 的返回对象里，找到那个计算属性赋值，报告它的**值**是否解析到目标符号、
 * 以及**键**是不是对 `HOOK_COMMAND_TIMEOUT_FIELD` 的下标。返回全部信息让调用方分别质询（自检也复用它）。
 */
function analyzeHelper(ctx: CheckerCtx): {
  helperFound: boolean
  valueIsTargetSymbol: boolean
  valueKind: string | null
  keyIndexesFieldMap: boolean
} {
  const { checker, sourceFile, targetSymbol } = ctx
  let result = { helperFound: false, valueIsTargetSymbol: false, valueKind: null as string | null, keyIndexesFieldMap: false }
  const walk = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === HELPER_NAME) {
      result.helperFound = true
      const ret = node.body?.statements.find(ts.isReturnStatement)
      const obj = ret?.expression
      if (obj && ts.isObjectLiteralExpression(obj)) {
        for (const prop of obj.properties) {
          if (ts.isPropertyAssignment(prop)) {
            result.valueKind = ts.SyntaxKind[prop.initializer.kind]
            const valueSymbol = checker.getSymbolAtLocation(prop.initializer)
            result.valueIsTargetSymbol = !!valueSymbol && !!targetSymbol && valueSymbol === targetSymbol
            if (ts.isComputedPropertyName(prop.name) && ts.isElementAccessExpression(prop.name.expression)) {
              const base = prop.name.expression.expression
              result.keyIndexesFieldMap = ts.isIdentifier(base) && base.text === FIELD_MAP_NAME
            }
          }
        }
      }
    }
    node.forEachChild(walk)
  }
  walk(sourceFile)
  return result
}

// --- 判据 A2：类型检查器层——providers/ 下**计算键**若其类型是 timeout/timeoutSec，值必须是 SSOT 符号 ----
//
// 为什么单靠判据 A（AST 键名归一）不够、必须再加这一层：`propertyKeyName` 只能归一「编译期常量字符串」的
// 键（标识符 / 字符串字面量 / `['timeout']` 这种常量计算键）。但计算键的表达式若**不是**字面量——`[localVar]`
// 或 `[HOOK_COMMAND_TIMEOUT_FIELD['gemini']]`——AST 层判不出键名，判据 A 对它完全失明。而这两种写法的
// **类型**恰恰是可判的：`localVar: 'timeout'` 的类型是字面量类型 `'timeout'`，`HOOK_COMMAND_TIMEOUT_FIELD['gemini']`
// 的类型是 `'timeout'`。于是这一层用类型检查器：凡计算键的类型解析到 `'timeout'`/`'timeoutSec'`（含 union
// 分支）的属性位，其**值**就必须是对 `HOOK_COMMAND_TIMEOUT_SECONDS` 这个导出符号的引用——挡住「键从 SSOT
// 取对了、值却手抄一个 10」（这是最危险的一种：键看着合法，值会在 bump 常量那天静默漂移）。

type BadComputedSite = { file: string; keyText: string; valueText: string; valueIsSSOT: boolean }

/** 建一个覆盖**全部 provider 文件**的真 Program，可选在内存里替换某些文件的源码（跑注入变异自检用）。 */
function programForProviders(overrides?: ReadonlyMap<string, string>): {
  checker: ts.TypeChecker
  program: ts.Program
  targetSymbol: ts.Symbol | undefined
} {
  const configPath = ts.findConfigFile(join(here, '..'), ts.sys.fileExists, 'tsconfig.json')
  if (!configPath) throw new Error('找不到 packages/core/tsconfig.json——类型检查器守卫无法建立 Program')
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(`tsconfig 解析失败：${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`)
    }
  })
  if (!parsed) throw new Error('tsconfig 解析返回空——类型检查器守卫无法建立 Program')
  const host = ts.createCompilerHost(parsed.options)
  if (overrides && overrides.size > 0) {
    const origGetSF = host.getSourceFile.bind(host)
    host.getSourceFile = (fileName, lv, onError, shouldCreate) =>
      overrides.has(fileName)
        ? ts.createSourceFile(fileName, overrides.get(fileName)!, lv, true, ts.ScriptKind.TS)
        : origGetSF(fileName, lv, onError, shouldCreate)
    const origReadFile = host.readFile.bind(host)
    host.readFile = (fileName) => (overrides.has(fileName) ? overrides.get(fileName)! : origReadFile(fileName))
  }
  const program = ts.createProgram({ rootNames: providerFiles(), options: parsed.options, host })
  const checker = program.getTypeChecker()
  const sharedSf = program.getSourceFile(sharedTsPath)
  const moduleSymbol = sharedSf ? checker.getSymbolAtLocation(sharedSf) : undefined
  const targetSymbol = moduleSymbol
    ? checker.getExportsOfModule(moduleSymbol).find((s) => s.getName() === CONST_NAME)
    : undefined
  return { checker, program, targetSymbol }
}

/** 该计算键的**类型**是否是（或其 union 分支含）某个禁区键的字面量类型。 */
function keyTypeIsForbidden(checker: ts.TypeChecker, keyExpr: ts.Expression): boolean {
  const t = checker.getTypeAtLocation(keyExpr)
  const parts = t.isUnion() ? t.types : [t]
  return parts.some((p) => p.isStringLiteral() && (FORBIDDEN_KEYS as readonly string[]).includes(p.value))
}

/**
 * providers/ 全体里，键**类型**为 timeout/timeoutSec 的计算键属性位，其值**不是** SSOT 符号的那些。
 * 空集 = 合规。helper 自己那处（值就是 `HOOK_COMMAND_TIMEOUT_SECONDS`）值是 SSOT 符号，天然不入此集。
 */
function badComputedKeyTimeoutSites(overrides?: ReadonlyMap<string, string>): {
  offenders: BadComputedSite[]
  totalComputedTimeoutSites: number
} {
  const { checker, program, targetSymbol } = programForProviders(overrides)
  const offenders: BadComputedSite[] = []
  let total = 0
  for (const path of providerFiles()) {
    const sf = program.getSourceFile(path)
    if (!sf) continue
    const walk = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) && ts.isComputedPropertyName(node.name)) {
        if (keyTypeIsForbidden(checker, node.name.expression)) {
          total += 1
          const valueSymbol = checker.getSymbolAtLocation(node.initializer)
          const valueIsSSOT = !!valueSymbol && !!targetSymbol && valueSymbol === targetSymbol
          if (!valueIsSSOT) {
            offenders.push({
              file: path.split('/').slice(-1)[0]!,
              keyText: node.name.expression.getText(sf),
              valueText: node.initializer.getText(sf),
              valueIsSSOT
            })
          }
        }
      }
      node.forEachChild(walk)
    }
    sf.forEachChild(walk)
  }
  return { offenders, totalComputedTimeoutSites: total }
}

describe('受管 Hook 超时只有一个 SSOT——值与键都是（F6）', () => {
  const files = providerFiles()
  const findings = files.flatMap((path) => forbiddenKeyValues(parse(path, readFileSync(path, 'utf8')), path))

  // 判据 A：providers/ 下 timeout/timeoutSec 这两个属性位**一个都不许有**——不论值怎么写。
  it('判据 A：providers/ 下没有任何手写的 timeout/timeoutSec 属性位（值怎么写都不行）', () => {
    // 重构后所有超时都走 `...hookCommandTimeout(<id>)` 的计算键 spread，`timeout:`/`timeoutSec:` 这两个
    // **字面属性位**在 providers/ 里应当归零。所以判据不是「值不能是数字字面量」而是更严的「这个属性位不该出现」：
    // 后者顺带堵死一族「换个值的写法」的绕过——`timeout: 5+5`（BinaryExpression）、`timeout: Number(10)`（Call）、
    // `timeout: 0x0a`、`timeout: T`（指向本地 const 的标识符）都产生一个 timeout 属性位，但都不是 NumericLiteral，
    // 只查「值是不是裸数字」会全部放行。键侧三种拼法（标识符/字符串/常量计算键）已由 `propertyKeyName` 归一。
    const offenders = findings
    expect(
      offenders,
      `这些 timeout/timeoutSec 属性位是手写的（会静默漂移；copilot 一旦被抄成 timeout 会静默换超时）。` +
        `providers/ 下不该再出现这个属性位，应改为 spread \`${HELPER_NAME}(<providerId>)\`：\n` +
        offenders.map((o) => `  ${o.path} → ${o.key}: ${o.text} [${o.kind}]`).join('\n')
    ).toEqual([])
  })

  it('自检 A0：至少有一处非数字字面量的写法也会被判据 A 抓——不是只挡裸数字', () => {
    // 防判据 A 悄悄退化回「只查 NumericLiteral」：喂一份值是表达式/调用/本地标识符的 timeout 属性位，
    // 它们都不是 NumericLiteral，但都必须被 findings 收进来（判据 A 判的是「属性位在不在」）。
    for (const src of [
      `const a = { hooks: [{ command: 'c', timeout: 5 + 5 }] }`,
      `const b = { hooks: [{ command: 'c', timeout: Number(10) }] }`,
      `const c = { hooks: [{ command: 'c', timeoutSec: (10) }] }`,
      `const d = { hooks: [{ command: 'c', timeout: T }] }`
    ]) {
      const hits = forbiddenKeyValues(parse('probe.ts', src), 'probe.ts')
      expect(hits.length, `这种值写法没被判据 A 收进 findings：${src}`).toBeGreaterThanOrEqual(1)
      expect(hits.some(isNumericLiteral), `这份样本不该是 NumericLiteral（否则测不到「非裸数字也挡」）：${src}`).toBe(false)
    }
  })

  it('自检 A1：判据 A 的扫描面非空——确实读到了若干 provider 源文件', () => {
    // 若目录读空或路径写错，判据 A 会在空集上恒绿。这里钉住扫描面本身。
    expect(files.length, 'providers/ 目录一个 .ts 都没扫到——扫描面退化了').toBeGreaterThanOrEqual(9)
  })

  it('自检 A2：注入一份手抄的 timeout 字面量，判据 A 必红（证明它不是恒真）', () => {
    // 取 claude.ts 真实源码，把 `...hookCommandTimeout('claude')` 注入回手写的 `timeout: 10`，重扫。
    const claudePath = join(providersDir, 'claude.ts')
    const original = readFileSync(claudePath, 'utf8')
    const mutated = original.replace(`...${HELPER_NAME}('claude')`, 'timeout: 10')
    expect(mutated, '注入替换没生效——被测锚点文本变了').not.toBe(original)
    const offenders = forbiddenKeyValues(parse(claudePath, mutated), claudePath).filter(isNumericLiteral)
    expect(offenders.length, '注入的 timeout: 10 没被判成 offender——判据 A 恒真').toBeGreaterThanOrEqual(1)
    expect(isNumericLiteral(offenders[0]!)).toBe(true)
  })

  it('自检 A3：注入一份 copilot 拼法的 timeoutSec 字面量同样必红（timeoutSec 真的在禁区内）', () => {
    const copilotPath = join(providersDir, 'copilot.ts')
    const original = readFileSync(copilotPath, 'utf8')
    const mutated = original.replace(`...${HELPER_NAME}('copilot')`, 'timeoutSec: 10')
    expect(mutated, '注入替换没生效——被测锚点文本变了').not.toBe(original)
    const offenders = forbiddenKeyValues(parse(copilotPath, mutated), copilotPath).filter(isNumericLiteral)
    expect(offenders.some((f) => f.key === 'timeoutSec'), 'timeoutSec: 10 没被判成 offender').toBe(true)
  })

  it('自检 A4：三种等价键拼法（标识符 / 字符串字面量 / 常量计算键）都被抓——换拼法绕不过 propertyKeyName', () => {
    // 「禁止清单守卫必漏」一族的经典口子：只认标识符键时，`{ 'timeout': 10 }` 与 `{ ['timeout']: 10 }`
    // 产生的属性名在运行时与 `{ timeout: 10 }` 完全一样，却从 AST 键匹配里溜走。这条把三种拼法一次钉死。
    const forms = [
      `const a = { hooks: [{ command: 'c', timeout: 10 }] }`, // 标识符键
      `const b = { hooks: [{ command: 'c', 'timeout': 10 }] }`, // 字符串字面量键
      `const c = { hooks: [{ command: 'c', ['timeoutSec']: 10 }] }` // 常量字符串计算键
    ]
    for (const src of forms) {
      const offenders = forbiddenKeyValues(parse('probe.ts', src), 'probe.ts').filter(isNumericLiteral)
      expect(offenders.length, `这种键拼法没被抓：${src}`).toBeGreaterThanOrEqual(1)
    }
    // 反向自检：无关键名不许误伤（防谓词退化成恒真）。
    const benign = `const d = { hooks: [{ command: 'c', retries: 10 }] }`
    expect(forbiddenKeyValues(parse('probe.ts', benign), 'probe.ts')).toEqual([])
  })

  // 判据 A2：类型检查器层——补上判据 A 对「非字面量计算键」的盲区。
  it('判据 A2：providers/ 下键类型为 timeout/timeoutSec 的计算键属性位，其值必须是 SSOT 符号', () => {
    const { offenders, totalComputedTimeoutSites } = badComputedKeyTimeoutSites()
    expect(
      offenders,
      `这些计算键属性位的键类型是 timeout/timeoutSec，值却不是对 ${CONST_NAME} 的引用（键从 SSOT 取对了、值` +
        `却手抄——bump 常量那天会静默漂移）：\n` +
        offenders.map((o) => `  ${o.file} → [${o.keyText}]: ${o.valueText}`).join('\n')
    ).toEqual([])
    // 扫描面自检：helper 自己那处计算键（值是 SSOT 符号、不入 offender）必被数到，否则说明整层没跑到任何站点。
    expect(
      totalComputedTimeoutSites,
      '一个「键类型为 timeout/timeoutSec 的计算键」都没扫到——判据 A2 的类型解析或扫描面退化了（helper 自己那处应当在）'
    ).toBeGreaterThanOrEqual(1)
  })

  it('自检 A2a：注入 D2（计算键索引 SSOT 映射、值手抄 10），判据 A2 必红——判据 A 对它失明', () => {
    // 复现审查者的盲点 D2：键 `[HOOK_COMMAND_TIMEOUT_FIELD['gemini']]` 从 SSOT 取对了，值却是手抄的 10。
    // 先证判据 A（AST 键名归一）确实看不见它，再证判据 A2（类型检查器）抓得住。
    const geminiPath = join(providersDir, 'gemini.ts')
    const original = readFileSync(geminiPath, 'utf8')
    const mutated = original
      .replace(
        `import { catalog, managedHookCommand, hookCommandTimeout } from './shared.js'`,
        `import { catalog, managedHookCommand, hookCommandTimeout, ${FIELD_MAP_NAME} } from './shared.js'`
      )
      .replace(`...${HELPER_NAME}('gemini')`, `[${FIELD_MAP_NAME}['gemini']]: 10`)
    expect(mutated, '注入替换没生效——被测锚点文本变了').not.toBe(original)
    // 判据 A 的 AST 扫描对这种非字面量计算键失明（这正是需要判据 A2 的原因）：
    expect(forbiddenKeyValues(parse(geminiPath, mutated), geminiPath), '判据 A 本不该看见非字面量计算键').toEqual([])
    // 判据 A2 抓得住：
    const { offenders } = badComputedKeyTimeoutSites(new Map([[geminiPath, mutated]]))
    expect(offenders.some((o) => o.file === 'gemini.ts' && o.valueText === '10'), 'D2 没被判据 A2 抓到').toBe(true)
  })

  it('自检 A2b：注入 D1（字面量类型的本地 const 作计算键、值手抄 10），判据 A2 必红', () => {
    // 复现盲点 D1：`const GEMINI_TIMEOUT_KEY: 'timeout' = 'timeout'`，键 `[GEMINI_TIMEOUT_KEY]`。
    const geminiPath = join(providersDir, 'gemini.ts')
    const original = readFileSync(geminiPath, 'utf8')
    const mutated = original
      .replace(
        `  const command = managedHookCommand('gemini')`,
        `  const command = managedHookCommand('gemini')\n  const GEMINI_TIMEOUT_KEY: 'timeout' = 'timeout'`
      )
      .replace(`...${HELPER_NAME}('gemini')`, `[GEMINI_TIMEOUT_KEY]: 10`)
    expect(mutated, '注入替换没生效——被测锚点文本变了').not.toBe(original)
    expect(forbiddenKeyValues(parse(geminiPath, mutated), geminiPath), '判据 A 本不该看见非字面量计算键').toEqual([])
    const { offenders } = badComputedKeyTimeoutSites(new Map([[geminiPath, mutated]]))
    expect(offenders.some((o) => o.file === 'gemini.ts' && o.keyText === 'GEMINI_TIMEOUT_KEY'), 'D1 没被判据 A2 抓到').toBe(true)
  })

  // 判据 B：类型检查器层——helper 返回的值就是那个导出常量符号本身。
  it('判据 B：hookCommandTimeout 返回对象的值解析到 HOOK_COMMAND_TIMEOUT_SECONDS 这个符号（不是恰好等于 10 的字面量）', () => {
    const ctx = programForShared()
    const analysis = analyzeHelper(ctx)
    expect(ctx.targetSymbol, `类型检查器找不到导出的 ${CONST_NAME} 符号`).toBeTruthy()
    expect(analysis.helperFound, `shared.ts 里找不到 ${HELPER_NAME} 函数`).toBe(true)
    expect(
      analysis.valueIsTargetSymbol,
      `${HELPER_NAME} 返回对象的值不是对 ${CONST_NAME} 符号的引用（实际 kind=${analysis.valueKind}）——` +
        `多半有人把它内联成了字面量 10（行为等价，但会静默漂移）`
    ).toBe(true)
    expect(
      analysis.keyIndexesFieldMap,
      `${HELPER_NAME} 的键不是对 ${FIELD_MAP_NAME} 的下标——键拼法脱离了 SSOT`
    ).toBe(true)
  })

  it('自检 B2：把 helper 的值内联成字面量 10，判据 B 必红（行为等价挡不住、类型检查器挡得住）', () => {
    const original = readFileSync(sharedTsPath, 'utf8')
    const anchor = `{ [${FIELD_MAP_NAME}[providerId]]: ${CONST_NAME} }`
    const mutated = original.replace(anchor, `{ [${FIELD_MAP_NAME}[providerId]]: 10 }`)
    expect(mutated, `注入替换没生效——helper 返回式的锚点文本变了（找的是 \`${anchor}\`）`).not.toBe(original)
    const ctx = programForShared(mutated)
    const analysis = analyzeHelper(ctx)
    expect(analysis.helperFound, '变异后 helper 还应在').toBe(true)
    expect(
      analysis.valueIsTargetSymbol,
      '内联成字面量 10 后，判据 B 仍判其为 SSOT 符号——判据 B 恒真、没有防住 fresh-copy'
    ).toBe(false)
    expect(analysis.valueKind, '内联后值应是数字字面量').toMatch(/NumericLiteral|FirstLiteralToken/)
  })

  // 判据 C：键映射是完整的 Record<BuiltInAgentProviderId, …>——运行时双向比对，编译期由 satisfies 保完整。
  it('判据 C：HOOK_COMMAND_TIMEOUT_FIELD 逐一覆盖 BUILT_IN_AGENT_PROVIDER_IDS，不多不少', () => {
    const mapKeys = Object.keys(HOOK_COMMAND_TIMEOUT_FIELD).sort()
    const idSet = [...BUILT_IN_AGENT_PROVIDER_IDS].sort()
    // 双向：映射缺一家 → 那家的超时键无处可查；映射多一家 → 幽灵 id。satisfies 在编译期已保证「缺」会红，
    // 这条运行时判据额外把「多」也钉住，并在 id 元组漂移时给出可读的 diff。
    expect(mapKeys).toEqual(idSet)
  })

  it('自检 C1：映射里每个非 null 值都是 FORBIDDEN_KEYS 之一（键拼法不会漂到禁区外而不被判据 A 覆盖）', () => {
    for (const [providerId, field] of Object.entries(HOOK_COMMAND_TIMEOUT_FIELD)) {
      if (field !== null) {
        expect(
          (FORBIDDEN_KEYS as readonly string[]).includes(field),
          `${providerId} 的超时键 '${field}' 不在 FORBIDDEN_KEYS 内——判据 A 会漏掉这种拼法的手抄`
        ).toBe(true)
      }
    }
  })

  it('运行时对照：SSOT 常量是 10，且 hookCommandTimeout 逐家派生出正确的 {键: 值}', () => {
    expect(typeof HOOK_COMMAND_TIMEOUT_SECONDS).toBe('number')
    expect(HOOK_COMMAND_TIMEOUT_SECONDS).toBe(10)
    // 值仍是那个数字字面量 SSOT——正面证明它存在。
    const shared = readFileSync(sharedTsPath, 'utf8')
    const decl = parse(sharedTsPath, shared).statements.find(
      (s): s is ts.VariableStatement =>
        ts.isVariableStatement(s) &&
        s.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === CONST_NAME)
    )
    expect(decl, `${CONST_NAME} 的 const 定义在 shared.ts 里找不到了`).toBeTruthy()
    // 逐家：copilot 必须派生出 timeoutSec、其余非 null 家派生出 timeout，值都等于常量。
    expect(hookCommandTimeout('copilot')).toEqual({ timeoutSec: HOOK_COMMAND_TIMEOUT_SECONDS })
    expect(hookCommandTimeout('claude')).toEqual({ timeout: HOOK_COMMAND_TIMEOUT_SECONDS })
    expect(hookCommandTimeout('cursor')).toEqual({ timeout: HOOK_COMMAND_TIMEOUT_SECONDS })
    // copilot 的键确实与其余家不同——这道分歧是被保留的正当差异，不是漂移。
    expect(Object.keys(hookCommandTimeout('copilot'))).not.toEqual(Object.keys(hookCommandTimeout('claude')))
  })

  it('自检 shared.js 运行时导出可达（import 求值成功）', () => {
    // 上面的运行时对照依赖 import 成功。这里显式钉住 sharedPath 指向真实模块（防路径常量写错）。
    expect(sharedPath.endsWith('shared.js')).toBe(true)
    expect(readdirSync(providersDir)).toContain('shared.ts')
  })
})

// ---------------------------------------------------------------------------
// 判据 D：**生成出来的配置里，该带超时的真带、该不带的真不带**（两个方向）。
//
// 为什么必须有这一层（实测，不是推理）：上面 A/A2/B/C 全部是「不许出现手抄」的**否定式**判据。
// 一个 provider **整段不写超时**，属性位上自然也没有裸数字——于是每一条都绿。实测两个变异：
//   · 删掉 gemini.ts 的 `...hookCommandTimeout('gemini')` → 2 条红，但红的是**自检 A2a/A2b**：
//     它们用 `original.replace("...hookCommandTimeout('gemini')", …)` 造探针，锚点没了探针就塌，
//     这是「自检的脚手架断了」，**不是判据认出了漏写**。
//   · 换成删掉 grok.ts 的那一句（没有任何自检拿它当锚点）→ `Tests 254 passed (254)`，**完全存活**。
// 本守卫文件头原先声明这条缝「由各 provider 的行为测试逐家断言 timeout 负责，两层配对交付」——
// 实测 `grep -ln timeout test/providers/*.ts` 只有 **copilot / droid / cursor / hermes 四家**，
// 九家非 null 里有五家（codex / claude / grok / gemini / antigravity）在行为侧根本没有这条断言。
// 所以那句话在**今天的仓库里是假的**，已在文件头改写；判据 D 就是把那半层补齐的东西。
//
// 判据形状（走真实生成路径，不读源码文本）：`resolveManagedHookPlan` 是九家共同的出口，
// 逐家解析它产出的每份 mutation JSON，枚举**每一个带 command 的对象**，然后：
//   · 映射值非 null ⇒ 每个 hook 定义都必须带**那一家自己的键**、值等于 SSOT 常量；
//   · 映射值为 null ⇒ 产物里不许出现任何 FORBIDDEN_KEYS 属性位（否则表在撒谎）。
// 两个方向都断言，因为本仓反复吃过「只守一侧」的账（漏写那侧恰好就是没人守的那侧）。
//
// 唯一的豁免形状及其正当性（实测得来，不是照抄声明）：hermes 除 hook 定义外还写一份
// **审批清单**，其条目形如 `{ event, command }`——它声明「批准这条命令在这个事件上跑」，
// 不是 hook 定义本身，因此正当地没有超时。豁免写成谓词 `isApprovalRecord` 而不是「hermes 除外」，
// 并在自检 D2 里把它质询一遍：豁免必须**真的命中过**（否则它是死条件，我在自欺），
// 且必须**只**命中审批那一族（`type` 在场的 hook 定义永远不许被豁免走）。
//
// 本判据看不见什么（照实写）：只覆盖能 `JSON.parse` 的 mutation。`pi` 写的是一份 `.js` 插件、
// `kimi` 走 TOML `[[hooks]]`、`traex`/`opencode` 无受管 hook——这四家在映射里都是 `null`，
// 反向断言对它们仍然成立（不许出现 timeout 属性位），但「它们本该带超时却漏了」这种情形
// 不在射程内，因为按 SSOT 表它们本来就不该带。
// ---------------------------------------------------------------------------

/** 一个「带 command 的对象」及其来源，便于失败时指出是哪一份文件的哪一段。 */
interface CommandBearingObject {
  readonly providerId: string
  readonly file: string
  readonly value: Record<string, unknown>
}

function collectCommandBearing(
  node: unknown,
  providerId: string,
  file: string,
  out: CommandBearingObject[]
): CommandBearingObject[] {
  if (Array.isArray(node)) {
    for (const child of node) collectCommandBearing(child, providerId, file, out)
    return out
  }
  if (node !== null && typeof node === 'object') {
    const record = node as Record<string, unknown>
    if (typeof record.command === 'string') out.push({ providerId, file, value: record })
    for (const child of Object.values(record)) collectCommandBearing(child, providerId, file, out)
  }
  return out
}

/**
 * 审批记录：声明「某条命令在某个事件上被批准执行」，本身不是 hook 定义，故正当地不带超时。
 * 判据是**形状**（自称所属事件、且没有 hook 定义才有的 `type` 判别字段），不是 provider 名字——
 * 按名字豁免会让下一家写同样结构的清单时静默失去覆盖。自检 D2 质询这个谓词。
 */
function isApprovalRecord(value: Record<string, unknown>): boolean {
  return typeof value.event === 'string' && value.type === undefined
}

/** 任意固定路径即可：判据只看产物里的键，不看路径本身。 */
const PROBE_WORKSPACE = '/repo/app'

function planCommandObjects(providerId: string): {
  parsed: CommandBearingObject[]
  unparsedFiles: string[]
} {
  const plan = resolveManagedHookPlan(providerId as Parameters<typeof resolveManagedHookPlan>[0], PROBE_WORKSPACE)
  const parsed: CommandBearingObject[] = []
  const unparsedFiles: string[] = []
  for (const mutation of plan?.mutations ?? []) {
    let document: unknown
    try {
      document = JSON.parse(mutation.content)
    } catch {
      unparsedFiles.push(mutation.path)
      continue
    }
    collectCommandBearing(document, providerId, mutation.path, parsed)
  }
  return { parsed, unparsedFiles }
}

describe('判据 D：生成出的 hook 配置里，超时该在的在、该不在的不在（F6 的运行时半边）', () => {
  it('每个映射值非 null 的 provider，其生成的每个 hook 定义都带自己那个键、值等于 SSOT 常量', () => {
    const offenders: string[] = []
    let checkedDefinitions = 0
    let checkedProviders = 0

    for (const [providerId, field] of Object.entries(HOOK_COMMAND_TIMEOUT_FIELD)) {
      if (field === null) continue
      checkedProviders += 1
      const { parsed } = planCommandObjects(providerId)
      const definitions = parsed.filter((entry) => !isApprovalRecord(entry.value))
      if (definitions.length === 0) {
        offenders.push(`${providerId}：映射声明它写 ${field} 超时，但生成的配置里一个 hook 定义都没有`)
        continue
      }
      for (const definition of definitions) {
        checkedDefinitions += 1
        if (definition.value[field] !== HOOK_COMMAND_TIMEOUT_SECONDS) {
          offenders.push(
            `${providerId}（${definition.file}）：hook 定义缺少 ${field}=${HOOK_COMMAND_TIMEOUT_SECONDS}，` +
              `实际键集合 ${JSON.stringify(Object.keys(definition.value))}`
          )
        }
      }
    }

    // 在场自检：漏掉整个循环（或 resolve 不出计划）会让 offenders 恒空而假绿。
    expect(checkedProviders, '非 null 的 provider 一家都没检查到——判据 D 空转了').toBeGreaterThanOrEqual(9)
    expect(checkedDefinitions, 'hook 定义一个都没枚举到——判据 D 空转了').toBeGreaterThanOrEqual(
      checkedProviders
    )
    expect(offenders).toEqual([])
  })

  it('每个映射值为 null 的 provider，其生成的产物里不出现任何 timeout 属性位（表不许撒谎）', () => {
    const offenders: string[] = []
    let checkedProviders = 0

    for (const [providerId, field] of Object.entries(HOOK_COMMAND_TIMEOUT_FIELD)) {
      if (field !== null) continue
      checkedProviders += 1
      const { parsed } = planCommandObjects(providerId)
      for (const entry of parsed) {
        for (const forbidden of FORBIDDEN_KEYS) {
          if (Object.prototype.hasOwnProperty.call(entry.value, forbidden)) {
            offenders.push(
              `${providerId}（${entry.file}）：映射说它不写命令级超时，产物里却有 ${forbidden}`
            )
          }
        }
      }
    }

    expect(checkedProviders, 'null 侧一家都没检查到——反向判据空转了').toBeGreaterThanOrEqual(4)
    expect(offenders).toEqual([])
  })

  it('自检 D1：任一家漏写 hookCommandTimeout 展开，判据 D 必红——包括没有自检拿它当锚点的那几家', () => {
    // 这是判据 D 存在的理由本身：把「漏写」模拟成产物里少了那个键，逐家验证判据会认出来。
    // 用产物层模拟（而不是改源码），因为判据 D 读的就是产物；源码层的漏写实测已在提交说明里。
    for (const [providerId, field] of Object.entries(HOOK_COMMAND_TIMEOUT_FIELD)) {
      if (field === null) continue
      const { parsed } = planCommandObjects(providerId)
      const definitions = parsed.filter((entry) => !isApprovalRecord(entry.value))
      expect(definitions.length, `${providerId} 没有 hook 定义可供检查`).toBeGreaterThan(0)
      // 摘掉那个键之后，判据 D 用的同一个断言表达式必须判为 offender。
      const stripped = { ...definitions[0]!.value }
      delete stripped[field]
      expect(
        stripped[field] !== HOOK_COMMAND_TIMEOUT_SECONDS,
        `${providerId}：摘掉 ${field} 之后判据 D 的判断仍认为它合格——判据对漏写失明`
      ).toBe(true)
    }
  })

  it('自检 D2：审批豁免真的命中过，且只命中审批那一族（带 type 的 hook 定义永不被豁免）', () => {
    let approvalsSeen = 0
    let definitionsSeen = 0

    for (const providerId of Object.keys(HOOK_COMMAND_TIMEOUT_FIELD)) {
      for (const entry of planCommandObjects(providerId).parsed) {
        if (isApprovalRecord(entry.value)) {
          approvalsSeen += 1
          // 被豁免的必须自称所属事件、且不是 hook 定义（无 type 判别字段）。
          expect(typeof entry.value.event).toBe('string')
          expect(entry.value.type).toBeUndefined()
        } else {
          definitionsSeen += 1
        }
      }
    }

    // 豁免若从未命中，它就是死条件——那说明我在为一个不存在的形状开后门，应当删掉它。
    expect(approvalsSeen, '审批豁免一次都没命中：它是死条件，应当删掉而不是留着').toBeGreaterThan(0)
    // 反向：豁免不能吃掉全部条目，否则判据 D 的正向断言就没有任何被检查对象。
    expect(definitionsSeen, '全部条目都被豁免走了——判据 D 会变成恒真').toBeGreaterThan(approvalsSeen)
  })

  it('自检 D3：豁免谓词对「带 type 的 hook 定义」判否——换个 provider 写同形清单也不会误伤', () => {
    // 正向探针：审批形状被认下来。
    expect(isApprovalRecord({ event: 'on_session_start', command: 'x' })).toBe(true)
    // 反向探针三种：hook 定义（有 type）、无 event 的裸命令、event 不是字符串。
    expect(isApprovalRecord({ type: 'command', command: 'x', timeout: 10 })).toBe(false)
    expect(isApprovalRecord({ command: 'x', timeout: 10 })).toBe(false)
    expect(isApprovalRecord({ event: 3, command: 'x' })).toBe(false)
    // 最险的一种：既有 event 又有 type（某天审批清单也带上 type），必须回到被检查的一侧。
    expect(isApprovalRecord({ event: 'on_session_start', type: 'command', command: 'x' })).toBe(false)
  })
})
