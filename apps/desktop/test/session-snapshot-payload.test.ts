import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import { sessionSnapshotPayload } from '../src/main/session-snapshot-payload.js'
import type { RuntimeSnapshot } from '../src/shared/contracts.js'

/**
 * `sessions:snapshot` 应答里那次「环境告示合进快照」的合并：判据被抽成纯函数 sessionSnapshotPayload
 * （session-snapshot-payload.ts），且 ipc.ts 的那个 handler 真的把 `args.environmentWarning` 交给它。
 *
 * 为什么抽：合并此前是 handler 里的一处内联展开，而那个 handler 长在 `registerIpc` 的闭包里、经
 * `ipcMain.handle` 注册，本仓没有任何测试 import 得到它。实测（#877 审计独立复现，我在动手前也自己复现过
 * 一次）：把那次合并整段删掉——也就是让应答永远不带 `environmentWarning`——五个相关 suite
 * （shell-environment-notice / ipc-parity / ipc-sender-trust / main-window-setup / app-service-window-mount）
 * 共 76 条全绿。用户侧的后果不是显示错，而是**什么都不显示**：登录 shell 没加载全时，终端和 Agent 都拿不
 * 到用户的 PATH，界面上却一句话都不说。同族的 `runtimeOwnershipWarnings` 由 `RuntimeController.snapshot`
 * 自己算出来，那半因此有真覆盖；`environmentWarning` 的来源在 controller 之外（`buildWindow` 里 await 出
 * 来的那个值），只能在 ipc 这一层合进去，于是它是这条应答里唯一没人守的字段。
 *
 * 本文件分两层（与 ipc-sender-trust.test.ts 同构）：
 * - 行为层：直接 import 纯函数，两个方向都钉——有告示时键**合进去**，没有告示时键**不在场**（而不是
 *   「在场且为 undefined」）。缺席那侧是本族习惯性无人守的一侧，且它不是风格问题：
 *   `exactOptionalPropertyTypes` 下两者类型就不同，经 IPC 结构化克隆后一个没有这个字段、一个字段在值是
 *   undefined。渲染层今天用 `?? null` 兜底，两者恰好同果，但合同上只承诺了前者。
 * - 接线层：走 TS 编译器 API（带 binder 的 checker），断言 ipc.ts 真的 import 了这个纯函数、
 *   `sessions:snapshot` 的 listener 体**就是**那次调用（不是「体里某处有」），且第二个实参是
 *   `registerIpc` 自己那个 `args` 上的 `environmentWarning`。判据全部按**绑定**判
 *   （getSymbolAtLocation → 声明），所以同名本地影子、或另写一个 `const args = {…}` 都满足不了它。
 *
 * 申报的盲点：接线层只认「原样把那个属性交出去」，不追值经过纯函数后的取值——取值由行为层直接质询纯函数
 * 守。它也不管 `buildWindow` 那侧算出来的 warning 对不对（那是 login-shell-environment.test.ts 的地盘）。
 */

// ---------------------------------------------------------------------------------------------------
// 行为层：直接质询纯函数
// ---------------------------------------------------------------------------------------------------

/** 一份不带 `environmentWarning` 的最小快照。其余字段在场，用来钉「合并不吃掉别的字段」。 */
function snapshotWithout(): RuntimeSnapshot {
  return {
    runtimeOwnershipWarnings: ['host-a could not be verified'],
    sessions: [],
    timelines: {},
    recoveryCandidates: []
  }
}

describe('sessionSnapshotPayload: the environment-notice merge, both directions', () => {
  it('merges the notice into the response when there is one', () => {
    // 把合并整段删掉（`return snapshot`）让这条红。
    const result = sessionSnapshotPayload(snapshotWithout(), 'Shell environment loading did not complete.')
    expect(result.environmentWarning).toBe('Shell environment loading did not complete.')
  })

  it('omits the key entirely when there is no notice — absent, not present-and-undefined', () => {
    // 判据是 `in`，不是 `=== undefined`：写成 `{ ...snapshot, environmentWarning }` 无条件展开时，
    // 值是 undefined 但键在场，只有 `in` 认得出这个差别（结构化克隆后两者是不同的载荷）。
    const result = sessionSnapshotPayload(snapshotWithout(), undefined)
    expect('environmentWarning' in result).toBe(false)
  })

  it('carries every other snapshot field through in both directions', () => {
    // 合并只该加一个键。把 spread 去掉（`return { environmentWarning }`）让这条红。
    for (const warning of ['a notice', undefined]) {
      const result = sessionSnapshotPayload(snapshotWithout(), warning)
      expect(result.runtimeOwnershipWarnings).toEqual(['host-a could not be verified'])
      expect(result.sessions).toEqual([])
      expect(result.timelines).toEqual({})
      expect(result.recoveryCandidates).toEqual([])
    }
  })

  it('lets the notice win over a value already on the snapshot (override, not fill-if-absent)', () => {
    // 承重点是**方向**。改成「只在快照没有时才填」（`snapshot.environmentWarning ?? warning`）让这条红。
    // 今天 RuntimeController 根本不产出这个字段，所以两种写法同果；写成覆盖是因为覆盖在两种世界里都给同
    // 一个答案，而 fill-if-absent 一旦 controller 将来开始产出，就会静默保留旧的那份。
    const result = sessionSnapshotPayload(
      { ...snapshotWithout(), environmentWarning: 'stale value from the snapshot' },
      'the live notice'
    )
    expect(result.environmentWarning).toBe('the live notice')
  })

  it('leaves an existing snapshot value alone when there is no notice to merge', () => {
    // 缺席那侧不是「清空」：没有告示时应当原样交回快照，包含它自己带的那份。
    const result = sessionSnapshotPayload(
      { ...snapshotWithout(), environmentWarning: 'the snapshot said so' },
      undefined
    )
    expect(result.environmentWarning).toBe('the snapshot said so')
  })

  it('does not mutate the snapshot it was handed', () => {
    // 快照来自 `RuntimeController.snapshot`，就地改它会把 ipc 层的合并漏进 controller 的对象。
    const snapshot = snapshotWithout()
    sessionSnapshotPayload(snapshot, 'a notice')
    expect('environmentWarning' in snapshot).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------------
// 接线层：ipc.ts 真的把 args.environmentWarning 交给这个纯函数
// ---------------------------------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const ipcPath = join(here, '../src/main/ipc.ts')
const PAYLOAD_MODULE = './session-snapshot-payload.js'
const CHANNEL = 'sessions:snapshot'

/**
 * 语法树 + 类型检查器。判据必须按**绑定**判（这个名字声明在哪、是不是从某模块 import 进来的），不能按文本
 * 判——同名本地影子拼写一模一样，只有绑定不同。noResolve/noLib 让 Program 不碰磁盘；真文件与自检合成片段
 * 走同一个 parse()，不存在「真文件走强判据、自检走弱判据」的分岔。
 */
interface ParsedModule {
  readonly sourceFile: ts.SourceFile
  readonly checker: ts.TypeChecker
}

function parse(source: string, label = '/synthetic/ipc.ts'): ParsedModule {
  const sourceFile = ts.createSourceFile(label, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === label ? sourceFile : undefined),
    writeFile: () => {},
    getDefaultLibFileName: () => 'lib.d.ts',
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => '/',
    getNewLine: () => '\n',
    fileExists: (name) => name === label,
    readFile: (name) => (name === label ? source : undefined)
  }
  const program = ts.createProgram([label], { noResolve: true, noLib: true, target: ts.ScriptTarget.ESNext }, host)
  return { sourceFile, checker: program.getTypeChecker() }
}

function declarationOf(module: ParsedModule, node: ts.Node): ts.Declaration | null {
  return module.checker.getSymbolAtLocation(node)?.declarations?.[0] ?? null
}

/** 一个声明是从哪个模块 import 进来的（不是 import 就给 null）。 */
function importedModuleOf(declaration: ts.Declaration | null): string | null {
  if (declaration === null || !ts.isImportSpecifier(declaration)) return null
  const specifier = declaration.parent.parent.parent.moduleSpecifier
  return ts.isStringLiteral(specifier) ? specifier.text : null
}

/** `handle('<channel>', <listener>)` 的 listener 箭头。 */
function handlerListener(module: ParsedModule, channel: string): ts.ArrowFunction | null {
  let found: ts.ArrowFunction | null = null
  const visit = (node: ts.Node): void => {
    if (found) return
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'handle' &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text === channel &&
      node.arguments[1] !== undefined &&
      ts.isArrowFunction(node.arguments[1])
    ) {
      found = node.arguments[1]
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(module.sourceFile)
  return found
}

/**
 * listener 体归一成「它算出来的那一个表达式」。
 *
 * 表达式体直接取（顺带剥括号）。块体只在**恰好一句 `return <表达式>`** 时才接受：这样诚实的重排版
 * （有人把 `=> (expr)` 写成 `=> { return expr }`）不会被误判成缺陷，而在它前面插任何一句（早退、覆盖、
 * 条件）都会让语句数变 2，落到 body-has-extra-statements。承重点在这里：本族的缺陷形态就是「在算出来的
 * 值前面插一句让它变成死代码」，只判「体里某处调了那个函数」的判据对这种插入完全失明。
 */
type ListenerResult =
  | { kind: 'no-handler' }
  | { kind: 'body-has-extra-statements'; statements: number }
  | { kind: 'body-not-a-single-return' }
  | { kind: 'expression'; expression: ts.Expression }

function listenerResult(module: ParsedModule, channel: string): ListenerResult {
  const listener = handlerListener(module, channel)
  if (listener === null) return { kind: 'no-handler' }
  let body: ts.Node = listener.body
  if (ts.isBlock(body)) {
    if (body.statements.length !== 1) {
      return { kind: 'body-has-extra-statements', statements: body.statements.length }
    }
    const only = body.statements[0]!
    if (!ts.isReturnStatement(only) || only.expression === undefined) {
      return { kind: 'body-not-a-single-return' }
    }
    body = only.expression
  }
  let expression = body as ts.Expression
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression
  return { kind: 'expression', expression }
}

/** 第二个实参是不是 `registerIpc` 自己那个 `args` 上的 `environmentWarning`（按绑定判）。 */
type WarningArgument =
  | 'registerIpc-args-property'
  | 'property-of-something-else'
  | 'wrong-property-name'
  | 'not-a-property-access'
  | 'absent'

function warningArgument(module: ParsedModule, argument: ts.Expression | undefined): WarningArgument {
  if (argument === undefined) return 'absent'
  if (!ts.isPropertyAccessExpression(argument)) return 'not-a-property-access'
  if (argument.name.text !== 'environmentWarning') return 'wrong-property-name'
  const owner = argument.expression
  if (!ts.isIdentifier(owner)) return 'property-of-something-else'
  const declaration = declarationOf(module, owner)
  if (declaration === null || !ts.isParameter(declaration)) return 'property-of-something-else'
  const fn = declaration.parent
  const isRegisterIpc = ts.isFunctionDeclaration(fn) && fn.name?.text === 'registerIpc'
  return isRegisterIpc ? 'registerIpc-args-property' : 'property-of-something-else'
}

/** 第一个实参是不是 await 出来的 `…snapshot(…)` 调用（快照那一半的来源）。 */
function snapshotArgument(argument: ts.Expression | undefined): 'awaited-snapshot-call' | 'something-else' {
  if (argument === undefined || !ts.isAwaitExpression(argument)) return 'something-else'
  const awaited = argument.expression
  if (!ts.isCallExpression(awaited) || !ts.isPropertyAccessExpression(awaited.expression)) return 'something-else'
  return awaited.expression.name.text === 'snapshot' ? 'awaited-snapshot-call' : 'something-else'
}

/** 整条接线的裁决。每个变异都该落在一个**不同**的取值上。 */
type MergeWiring =
  | { kind: 'no-handler' }
  | { kind: 'body-has-extra-statements'; statements: number }
  | { kind: 'body-not-a-single-return' }
  | { kind: 'result-not-a-call' }
  | { kind: 'callee-not-the-extracted-merge'; resolvedModule: string | null }
  | {
      kind: 'calls-extracted-merge'
      snapshot: 'awaited-snapshot-call' | 'something-else'
      warning: WarningArgument
    }

function mergeWiring(module: ParsedModule): MergeWiring {
  const result = listenerResult(module, CHANNEL)
  if (result.kind !== 'expression') return result
  const expression = result.expression
  if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) {
    return { kind: 'result-not-a-call' }
  }
  const resolvedModule = importedModuleOf(declarationOf(module, expression.expression))
  if (expression.expression.text !== 'sessionSnapshotPayload' || resolvedModule !== PAYLOAD_MODULE) {
    return { kind: 'callee-not-the-extracted-merge', resolvedModule }
  }
  return {
    kind: 'calls-extracted-merge',
    snapshot: snapshotArgument(expression.arguments[0]),
    warning: warningArgument(module, expression.arguments[1])
  }
}

describe('ipc.ts wiring: the sessions:snapshot handler delegates the merge and forwards the notice', () => {
  const module = parse(readFileSync(ipcPath, 'utf8'), ipcPath)

  it('the handler body IS the extracted merge call, with both operands forwarded', () => {
    // 一条断言覆盖整条接线，因为四个变异各落在不同取值上（下面四个自检逐个钉住）：
    // 删掉调用 → result-not-a-call；同名影子 → callee-not-the-extracted-merge；
    // 前面插早退 → body-has-extra-statements；换成字面量 → warning 不是 registerIpc-args-property。
    expect(mergeWiring(module)).toEqual({
      kind: 'calls-extracted-merge',
      snapshot: 'awaited-snapshot-call',
      warning: 'registerIpc-args-property'
    })
  })

  it('the merge does not move back inline: ipc.ts never spreads environmentWarning itself', () => {
    // 判据是**这个文件里不再有那次展开**。ipc.ts 里 `environmentWarning` 只该出现在两处：registerIpc 的
    // 参数类型声明，和交给纯函数的那个实参。第三处出现意味着合并又被抄回来了一份。
    const occurrences = readFileSync(ipcPath, 'utf8').match(/environmentWarning/g) ?? []
    expect(occurrences).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------------------------------
// 自检：把每个变异喂给同一个判据，确认它们各自落在不同的、非通过的取值上
// ---------------------------------------------------------------------------------------------------

const PREAMBLE =
  `import { sessionSnapshotPayload } from '${PAYLOAD_MODULE}'\n` +
  'declare const handle: (channel: string, listener: (...values: any[]) => any) => void\n'

/**
 * `moduleExtra` 落在模块作用域，`innerExtra` 落在 registerIpc 体内 handle 调用之前。分成两处不是排版偏好：
 * 模块作用域再写一个 `const sessionSnapshotPayload` 与那条 import 是**重复声明**而不是遮蔽，binder 交回来
 * 的仍是 import 那份（实测：判据会把它当诚实实现放过去）。真的遮蔽必须落在内层作用域。
 */
function synthetic(handlerBody: string, options: { moduleExtra?: string; innerExtra?: string } = {}): ParsedModule {
  return parse(
    `${PREAMBLE}${options.moduleExtra ?? ''}export async function registerIpc(args: {\n` +
      '  runtime: { snapshot: (config: any) => Promise<any> }\n' +
      '  environmentWarning?: string\n' +
      '}): Promise<void> {\n' +
      '  const config: any = {}\n' +
      `  ${options.innerExtra ?? ''}` +
      `  handle('${CHANNEL}', ${handlerBody})\n` +
      '}\n'
  )
}

describe('self-check: each mutation lands on its own non-passing verdict', () => {
  const HONEST = 'async () => (\n    sessionSnapshotPayload(await args.runtime.snapshot(config), args.environmentWarning)\n  )'

  it('accepts the shipped shape (the criterion is satisfiable, not vacuously red)', () => {
    expect(mergeWiring(synthetic(HONEST))).toEqual({
      kind: 'calls-extracted-merge',
      snapshot: 'awaited-snapshot-call',
      warning: 'registerIpc-args-property'
    })
  })

  it('also accepts an honest reformat into a single-return block (no false red)', () => {
    const reformatted =
      'async () => {\n' +
      '    return sessionSnapshotPayload(await args.runtime.snapshot(config), args.environmentWarning)\n' +
      '  }'
    expect(mergeWiring(synthetic(reformatted))).toEqual({
      kind: 'calls-extracted-merge',
      snapshot: 'awaited-snapshot-call',
      warning: 'registerIpc-args-property'
    })
  })

  it('rejects dropping the merge and returning the bare snapshot', () => {
    expect(mergeWiring(synthetic('async () => await args.runtime.snapshot(config)'))).toEqual({
      kind: 'result-not-a-call'
    })
  })

  it('rejects an inline re-spread that reproduces the original defect shape', () => {
    // 这正是抽出前的写法。它「行为上今天等价」，但它把判据搬回不可测的闭包里，于是删掉那半又变成静默。
    const inline =
      'async () => ({\n' +
      '    ...await args.runtime.snapshot(config),\n' +
      '    ...(args.environmentWarning ? { environmentWarning: args.environmentWarning } : {})\n' +
      '  })'
    expect(mergeWiring(synthetic(inline))).toEqual({ kind: 'result-not-a-call' })
  })

  it('rejects a same-named local shadow standing in for the imported merge', () => {
    // 文本判据在这里恒真：`sessionSnapshotPayload(...)` 拼写一模一样，只有绑定不同。影子必须落在内层作用域
    // ——模块作用域再声明一次是重复声明而不是遮蔽，binder 交回来的仍是 import 那份（实测：判据会放过去）。
    const shadow = 'const sessionSnapshotPayload = (s: any, _w: any): any => s\n  '
    expect(mergeWiring(synthetic(HONEST, { innerExtra: shadow }))).toEqual({
      kind: 'callee-not-the-extracted-merge',
      resolvedModule: null
    })
  })

  it('rejects an early return inserted before the merge (the merge becomes dead code)', () => {
    const earlyReturn =
      'async () => {\n' +
      '    if (true) return await args.runtime.snapshot(config)\n' +
      '    return sessionSnapshotPayload(await args.runtime.snapshot(config), args.environmentWarning)\n' +
      '  }'
    expect(mergeWiring(synthetic(earlyReturn))).toEqual({
      kind: 'body-has-extra-statements',
      statements: 2
    })
  })

  it('rejects a literal passed in place of the notice the window computed', () => {
    const literal = "async () => (\n    sessionSnapshotPayload(await args.runtime.snapshot(config), 'hardcoded')\n  )"
    expect(mergeWiring(synthetic(literal))).toEqual({
      kind: 'calls-extracted-merge',
      snapshot: 'awaited-snapshot-call',
      warning: 'not-a-property-access'
    })
  })

  it('rejects the notice read off a look-alike object instead of registerIpc own args', () => {
    // 承重点是「`args` 绑定到 registerIpc 自己的形参」。这个探针把 handle 调用挪进一个自带 `args` 形参的
    // 内层函数：属性名对、形状对、拼写逐字相同，只有绑定的宿主不是 registerIpc。落在 warning 取值上（而不
    // 是语句数），所以它与「前面插早退」是两个不同的裁决。
    //
    // 注意不能用 `const args = {…}` 写在 registerIpc 体内：那与形参是重复声明而不是遮蔽，binder 交回来的
    // 仍是形参那份，判据会照常放过去（实测确认过两次，模块作用域的同名 const 同理）。
    const module = parse(
      `${PREAMBLE}export async function registerIpc(outer: any): Promise<void> {\n` +
        '  const config: any = {}\n' +
        '  const register = (args: { runtime: any; environmentWarning?: string }): void => {\n' +
        `    handle('${CHANNEL}', ${HONEST})\n` +
        '  }\n' +
        '  register(outer)\n' +
        '}\n'
    )
    expect(mergeWiring(module)).toEqual({
      kind: 'calls-extracted-merge',
      snapshot: 'awaited-snapshot-call',
      warning: 'property-of-something-else'
    })
  })

  it('rejects a sibling property forwarded in place of the notice', () => {
    const sibling =
      'async () => (\n' +
      '    sessionSnapshotPayload(await args.runtime.snapshot(config), args.runtime)\n' +
      '  )'
    expect(mergeWiring(synthetic(sibling))).toEqual({
      kind: 'calls-extracted-merge',
      snapshot: 'awaited-snapshot-call',
      warning: 'wrong-property-name'
    })
  })

  it('rejects a snapshot operand that is not the awaited runtime snapshot', () => {
    const fabricated =
      'async () => (\n' +
      '    sessionSnapshotPayload({ sessions: [] } as any, args.environmentWarning)\n' +
      '  )'
    expect(mergeWiring(synthetic(fabricated))).toEqual({
      kind: 'calls-extracted-merge',
      snapshot: 'something-else',
      warning: 'registerIpc-args-property'
    })
  })

  it('reports a missing handler rather than passing when the channel is gone', () => {
    const module = parse(`${PREAMBLE}export async function registerIpc(args: any): Promise<void> {}\n`)
    expect(mergeWiring(module)).toEqual({ kind: 'no-handler' })
  })
})
