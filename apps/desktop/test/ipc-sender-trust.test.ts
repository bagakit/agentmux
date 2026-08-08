import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import {
  assertSenderTrusted,
  senderTrust,
  PRIVILEGED_SENDER_LABELS,
  type PrivilegedChannel
} from '../src/main/ipc-sender-trust.js'
import { CONTROL_RESPONSE_CHANNEL } from '../src/shared/contracts.js'

/**
 * 特权 IPC 频道的发送者校验：判据被抽成纯函数 senderTrust/assertSenderTrusted（ipc-sender-trust.ts），
 * 且 ipc.ts 的每个特权 handler 真的先过这道判据。
 *
 * 为什么抽：这条判据此前以 `if (event.sender !== args.window.webContents) throw new Error('Untrusted …
 * sender')` 的形态散落在十余个 handler 里，全都关在 registerIpc 闭包内、经 ipcMain.handle 注册，任何测试
 * 都够不着它们的函数体。实测（见本轮 Lane I 的三次变异，也记在 ipc-sender-trust.ts 头部）：把某处的 `!==`
 * 翻成 `===`、或整行删掉、或把 acceptControl 里那半个比较拿掉，desktop 的 8 个相关测试文件 80/80 全绿、
 * tsc 也退 0。唯一被守住的那处（openExternalFromRenderer）恰恰因为它是模块级导出函数——这正是本文件要给
 * 其余频道补的可达性。
 *
 * 本文件分两层（与 window-security.test.ts 同构）：
 * - 行为层：直接 import 纯函数，逐分支质询——accept（发送者==受信任窗口→trusted）与 reject（!=→带 reason）
 *   都钉，尤其 accept 那侧（本族习惯性无人守的一侧：判据取反后只有正向用例认得出）。拒绝措辞用**写死的
 *   历史字面量**逐字比对，而不是从 PRIVILEGED_SENDER_LABELS 派生——否则期望值会跟着被测的映射一起漂移
 *   （记忆 expected-value-must-not-derive-from-mutation-target）。
 * - 接线层：走 TS 编译器 API（带 binder 的 checker，从 apps/desktop 解析 typescript），断言 ipc.ts 真的
 *   import 了纯函数、requireTrustedSender 适配器是**单表达式**（体里没有语句位可插早退）、每个特权 handler
 *   的**第一句**就是把自己的 event 转发给那个适配器、acceptControl 的第一句就是 senderTrust 门。判据全部
 *   按**绑定**判（getSymbolAtLocation → 声明），所以同名本地影子或解构改名都满足不了它。
 *
 * 申报的盲点：接线层只认「原样转发同一个绑定」，不追值本身流经纯函数后的取值——取值由行为层直接质询纯
 * 函数守。`ui:openExternal` 也是特权频道，但它走另一条**已被测**的路（openExternalFromRenderer +
 * external-url.test.ts，比对的是传入的 renderer 而非 args.window.webContents），故不在本文件的接线判据里。
 */

// ---------------------------------------------------------------------------------------------------
// 行为层：直接质询纯函数
// ---------------------------------------------------------------------------------------------------

/**
 * 每个会抛的特权频道 → 它被拒时那条**逐字**的历史抛错。这是本文件的外部锚点：故意不从
 * PRIVILEGED_SENDER_LABELS 拼出来，这样有人改了模块里的标签，这张表与它一比就红。
 * CONTROL_RESPONSE_CHANNEL 不在此表——它走静默返回，处置不同（下面单独钉）。
 */
const THROWING_CHANNEL_MESSAGES: ReadonlyArray<readonly [PrivilegedChannel, string]> = [
  ['ui:writeClipboardImage', 'Untrusted clipboard image sender'],
  ['ui:savePastedImage', 'Untrusted pasted image sender'],
  ['ui:notifyAgentAttention', 'Untrusted notification sender'],
  ['browser:switchProfile', 'Untrusted Browser Profile sender'],
  ['browser:listProfiles', 'Untrusted Browser Profile sender'],
  ['browser:createProfile', 'Untrusted Browser Profile sender'],
  ['browser:deleteProfile', 'Untrusted Browser Profile sender'],
  ['browser:detectProfileImportSources', 'Untrusted Browser Profile sender'],
  ['browser:importProfile', 'Untrusted Browser Profile sender'],
  ['browser:selectElement', 'Untrusted Browser selection sender'],
  ['browser:cancelElementSelection', 'Untrusted Browser selection sender'],
  ['browser:setAnnotationMarkers', 'Untrusted Browser annotation sender']
]

/** 会抛的特权频道集合（接线层的正向覆盖也从这里派生）。 */
const THROWING_CHANNELS = (Object.keys(PRIVILEGED_SENDER_LABELS) as PrivilegedChannel[]).filter((channel) => channel !== CONTROL_RESPONSE_CHANNEL)

describe('senderTrust: the pure sender-identity decision, both branches', () => {
  it('trusts when the sender frame IS the trusted frame (accept branch — the habitually unguarded side)', () => {
    // 取反变异（Object.is → !Object.is）让这条红：可信的发送者反被判成不可信。
    const frame = { id: 'window' }
    expect(senderTrust('ui:notifyAgentAttention', frame, frame)).toEqual({ trusted: true })
  })

  it('rejects when the sender frame is NOT the trusted frame (reject branch)', () => {
    const sender = { id: 'imposter' }
    const trustedFrame = { id: 'window' }
    expect(senderTrust('ui:notifyAgentAttention', sender, trustedFrame)).toEqual({
      trusted: false,
      reason: 'Untrusted notification sender'
    })
  })

  it('compares by identity, not by structural equality — two look-alike frames are still untrusted', () => {
    // Object.is 的承重点：一个仿冒 sender 即便字段和受信任窗口长得一模一样，也不是同一个引用。
    // 若把 Object.is 换成结构等价（或恒 true），这条红。
    expect(senderTrust('browser:switchProfile', { id: 'x' }, { id: 'x' })).toEqual({
      trusted: false,
      reason: 'Untrusted Browser Profile sender'
    })
  })

  it('carries the exact historical reject message for every privileged throwing channel', () => {
    // 逐频道对着写死的历史字面量比。标签映射改了、或哪个频道从表里掉了，这条都红。
    const trustedFrame = { id: 'window' }
    const imposter = { id: 'imposter' }
    for (const [channel, message] of THROWING_CHANNEL_MESSAGES) {
      expect(senderTrust(channel, imposter, trustedFrame)).toEqual({ trusted: false, reason: message })
    }
  })

  it('the control-response channel yields its own reject reason (its disposition differs, not its decision)', () => {
    expect(senderTrust(CONTROL_RESPONSE_CHANNEL, { id: 'imposter' }, { id: 'window' })).toEqual({
      trusted: false,
      reason: 'Untrusted control response sender'
    })
  })

  it('every key in PRIVILEGED_SENDER_LABELS produces a non-empty reject reason (no unlabeled privileged channel)', () => {
    const imposter = {}
    const trustedFrame = {}
    for (const channel of Object.keys(PRIVILEGED_SENDER_LABELS) as PrivilegedChannel[]) {
      const decision = senderTrust(channel, imposter, trustedFrame)
      expect(decision.trusted).toBe(false)
      if (decision.trusted) throw new Error('unreachable')
      expect(decision.reason).toMatch(/^Untrusted .+ sender$/)
    }
  })
})

describe('assertSenderTrusted: the throw-half of the disposition', () => {
  it('does not throw on a trusted decision', () => {
    expect(() => assertSenderTrusted({ trusted: true })).not.toThrow()
  })

  it('throws the decision reason on an untrusted decision', () => {
    expect(() => assertSenderTrusted({ trusted: false, reason: 'Untrusted clipboard image sender' })).toThrow(
      'Untrusted clipboard image sender'
    )
  })
})

// ---------------------------------------------------------------------------------------------------
// 接线层：AST 质询 ipc.ts 真的用了它，且每个特权 handler 第一句就是那次转发
// ---------------------------------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const ipcPath = join(here, '../src/main/ipc.ts')
const SENDER_TRUST_MODULE = './ipc-sender-trust.js'
const CONTRACTS_MODULE = '../shared/contracts.js'

/**
 * 一份解析过的源码：语法树 + 类型检查器。判据必须按**绑定**判（这个名字声明在哪、是不是从某模块 import
 * 进来的），不能按文本判——同名本地影子拼写一模一样，只有绑定不同。noResolve/noLib 让 Program 不碰磁盘，
 * binder 在单文件下就给得出本文件需要的全部绑定信息。真文件与自检合成片段走同一个 parse()，不存在
 * 「真文件走强判据、自检走弱判据」的分岔。
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

function importedModuleOf(declaration: ts.Declaration | null): string | null {
  if (declaration === null || !ts.isImportSpecifier(declaration)) return null
  const specifier = declaration.parent.parent.parent.moduleSpecifier
  return ts.isStringLiteral(specifier) ? specifier.text : null
}

function namedImportsFrom(module: ParsedModule, moduleSpecifier: string): string[] {
  const names: string[] = []
  module.sourceFile.forEachChild((node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === moduleSpecifier
    ) {
      const bindings = node.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) names.push(element.name.text)
      }
    }
  })
  return names
}

/**
 * 一个实参**从哪来**（与 window-security.test.ts 同一套词汇，按绑定判）：
 * - `own-parameter`：解析到的声明落在这个函数自己的形参表里（我们要的：原样转发收到的那个值）
 * - `declared-elsewhere` / `not-an-identifier` / `absent` / `unresolved`：其余
 */
type ArgumentOrigin = 'own-parameter' | 'declared-elsewhere' | 'not-an-identifier' | 'absent' | 'unresolved'

function argumentOrigin(
  module: ParsedModule,
  argument: ts.Expression | undefined,
  fn: ts.FunctionLikeDeclarationBase
): ArgumentOrigin {
  if (argument === undefined) return 'absent'
  if (!ts.isIdentifier(argument)) return 'not-an-identifier'
  const declaration = declarationOf(module, argument)
  if (declaration === null) return 'unresolved'
  let node: ts.Node | undefined = declaration
  while (node !== undefined) {
    if (ts.isParameter(node)) return node.parent === fn ? 'own-parameter' : 'declared-elsewhere'
    node = node.parent
  }
  return 'declared-elsewhere'
}

/** 找 registerIpc 里那个 `const requireTrustedSender = …` 的 VariableDeclaration（适配器）。 */
function adapterDeclaration(module: ParsedModule): ts.VariableDeclaration | null {
  let found: ts.VariableDeclaration | null = null
  let count = 0
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'requireTrustedSender') {
      found = node
      count += 1
    }
    ts.forEachChild(node, visit)
  }
  visit(module.sourceFile)
  // 只该有一个声明；多于一个意味着有影子，让调用方能据此报红。
  return count === 1 ? found : null
}

/**
 * requireTrustedSender 适配器的形状。它必须是**单表达式**箭头（体里没有语句位可插早退），且那个表达式
 * 就是 `assertSenderTrusted(senderTrust(channel, event.sender, <trusted>.webContents))`，两个 callee 都
 * 绑定到 ipc-sender-trust.js 的 import。
 */
type AdapterShape =
  | { kind: 'absent' }
  | { kind: 'not-an-arrow' }
  | { kind: 'not-sole-expression' }
  | { kind: 'body-not-assert-call' }
  | { kind: 'assert-arg-not-sender-trust' }
  | {
      kind: 'forwards'
      assertImportedFrom: string | null
      senderTrustImportedFrom: string | null
      channelArg: ArgumentOrigin
      senderArgIsOwnEventSender: boolean
      trustedFrameIsWindowWebContents: boolean
    }

function adapterShape(module: ParsedModule): AdapterShape {
  const decl = adapterDeclaration(module)
  if (decl === null || decl.initializer === undefined) return { kind: 'absent' }
  const arrow = decl.initializer
  if (!ts.isArrowFunction(arrow)) return { kind: 'not-an-arrow' }
  // 单表达式体：一旦是块体，就有语句位可插早退——正是本族缺陷的落脚点。
  if (ts.isBlock(arrow.body)) return { kind: 'not-sole-expression' }
  const outer = arrow.body
  if (!ts.isCallExpression(outer) || !ts.isIdentifier(outer.expression)) return { kind: 'body-not-assert-call' }
  const inner = outer.arguments[0]
  if (inner === undefined || !ts.isCallExpression(inner) || !ts.isIdentifier(inner.expression)) {
    return { kind: 'assert-arg-not-sender-trust' }
  }
  const senderArg = inner.arguments[1]
  const senderArgIsOwnEventSender =
    senderArg !== undefined &&
    ts.isPropertyAccessExpression(senderArg) &&
    senderArg.name.text === 'sender' &&
    argumentOrigin(module, senderArg.expression, arrow) === 'own-parameter'
  return {
    kind: 'forwards',
    assertImportedFrom: importedModuleOf(declarationOf(module, outer.expression)),
    senderTrustImportedFrom: importedModuleOf(declarationOf(module, inner.expression)),
    channelArg: argumentOrigin(module, inner.arguments[0], arrow),
    senderArgIsOwnEventSender,
    trustedFrameIsWindowWebContents: trustedFrameIsWindowWebContents(inner.arguments[2])
  }
}

/**
 * arg[2] 是「被信任的那一帧」。判据要问的是**它是不是那个窗口的 webContents**，不是「它叫不叫
 * webContents」。
 *
 * 曾经只判属性名（`trustedFrame.name.text === 'webContents'`）。那样 `event.sender.webContents` 也算过
 * ——一个由**发送者自己**提供的帧，等于把「谁可信」交给被审查方回答。今天 tsc 恰好用 TS2339 挡住了那个
 * 具体拼法（`WebContents` 上没有 `webContents`），但那是偶然：任何一个类型合法、同名属性的来源都能重新
 * 打开这个洞，而判据本身对「对象是谁」全程沉默。所以这里改成连对象一起判：必须是 `<x>.window.webContents`。
 *
 * 两个站点（adapter 与 acceptControl）共用这一个函数，不各写一份——同一把尺子，避免两处漂移。
 */
function trustedFrameIsWindowWebContents(trustedFrame: ts.Expression | undefined): boolean {
  if (trustedFrame === undefined || !ts.isPropertyAccessExpression(trustedFrame)) return false
  if (trustedFrame.name.text !== 'webContents') return false
  const owner = trustedFrame.expression
  return ts.isPropertyAccessExpression(owner) && owner.name.text === 'window'
}

/** handleWithEvent('<channel>', <listener>) 的 listener 箭头。 */
function handlerListener(module: ParsedModule, channel: string): ts.ArrowFunction | null {
  let found: ts.ArrowFunction | null = null
  const visit = (node: ts.Node): void => {
    if (found) return
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'handleWithEvent' &&
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
 * 一个特权 handler 的**第一句**是不是把自己的 event 转发给适配器。判据落在第一句上：在它之前插任何语句
 * （早退、覆盖、条件）都会让这里读出 first-not-forward。callee 按**绑定**判必须解析到那个适配器声明——
 * handler 作用域里另写一个同名 `const requireTrustedSender` 影子会被认出（bindsToAdapter=false）。
 */
type HandlerGuard =
  | { kind: 'no-handler' }
  | { kind: 'no-first-statement' }
  | { kind: 'first-not-forward' }
  | { kind: 'forwards'; bindsToAdapter: boolean; channel: string | null; event: ArgumentOrigin }

function handlerGuard(module: ParsedModule, channel: string, adapter: ts.VariableDeclaration | null): HandlerGuard {
  const listener = handlerListener(module, channel)
  if (listener === null) return { kind: 'no-handler' }
  if (!ts.isBlock(listener.body) || listener.body.statements.length === 0) return { kind: 'no-first-statement' }
  const first = listener.body.statements[0]!
  if (!ts.isExpressionStatement(first) || !ts.isCallExpression(first.expression)) return { kind: 'first-not-forward' }
  const call = first.expression
  if (!ts.isIdentifier(call.expression) || call.expression.text !== 'requireTrustedSender') {
    return { kind: 'first-not-forward' }
  }
  const channelArg = call.arguments[0]
  return {
    kind: 'forwards',
    bindsToAdapter: adapter !== null && declarationOf(module, call.expression) === adapter,
    channel: channelArg !== undefined && ts.isStringLiteralLike(channelArg) ? channelArg.text : null,
    event: argumentOrigin(module, call.arguments[1], listener)
  }
}

/** 每一处 requireTrustedSender(<channel>, …) 的调用（反向 allow-list 扫描用）。 */
function requireTrustedSenderCallChannels(module: ParsedModule): Array<string | null> {
  const out: Array<string | null> = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'requireTrustedSender') {
      const arg = node.arguments[0]
      out.push(arg !== undefined && ts.isStringLiteralLike(arg) ? arg.text : null)
    }
    ts.forEachChild(node, visit)
  }
  visit(module.sourceFile)
  return out
}

/**
 * acceptControl 的**第一句**是不是 senderTrust 门：`if (!senderTrust(CONTROL_RESPONSE_CHANNEL, event.sender,
 * <trusted>).trusted) return`。这个频道的处置是静默返回而非抛，所以判据落在「第一句是这道门」上——删掉
 * 发送者比较（让它认任何 sender）会把第一句变成 requestId 形状检查，这里据此报红。
 *
 * **判据要问三件事，不是一件**：门在不在（第一句形状）、比的是**哪两个东西**（arg[1] 与 arg[2]）、
 * 不可信时**做什么**（then 分支）。曾经只问了第一件半，于是三个把这条频道的安全性彻底废掉的变异全
 * 26 条绿：`senderTrust(CH, event.sender, event.sender)`（自比恒真，认任何 sender）、
 * `senderTrust(CH, event.sender, {})`（恒假，合法控制响应被静默丢弃）、以及保住「第一句是门」「then
 * 里有 return」但在 return 之前先 `accept(response)`。前两个是 arg[2] 无人看，第三个是
 * `statements.some(isReturnStatement)` 太松。tsc 也兜不住：`senderTrust` 的 `trustedFrame` 是
 * `unknown`。对照实验：同一个 arg[2] 缺陷种在 adapter 上会被 `adapterShape` 抓住——同缺陷两个站点，
 * 一个守着一个没守，正是「守卫按出口数不按条件数」那一族。
 */
type AcceptControlGuard =
  | { kind: 'not-found' }
  | { kind: 'no-first-statement' }
  | { kind: 'first-not-sender-gate' }
  | {
      kind: 'sender-gate'
      senderTrustImportedFrom: string | null
      channelImportedFrom: string | null
      senderArgIsOwnEventSender: boolean
      /** arg[2] 是不是某个东西的 `.webContents`（与 adapterShape 同法）。自比 event.sender 时为 false。 */
      trustedFrameIsWindowWebContents: boolean
      /** 不可信时**只**返回：then 分支是裸 return，或块里恰好只有一条 return。 */
      returnsWhenUntrusted: boolean
    }

function acceptControlDeclaration(module: ParsedModule): ts.ArrowFunction | null {
  let found: ts.ArrowFunction | null = null
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'acceptControl' &&
      node.initializer !== undefined &&
      ts.isArrowFunction(node.initializer)
    ) {
      found = node.initializer
    }
    ts.forEachChild(node, visit)
  }
  visit(module.sourceFile)
  return found
}

function acceptControlGuard(module: ParsedModule): AcceptControlGuard {
  const arrow = acceptControlDeclaration(module)
  if (arrow === null || !ts.isBlock(arrow.body)) return { kind: 'not-found' }
  const first = arrow.body.statements[0]
  if (first === undefined) return { kind: 'no-first-statement' }
  if (!ts.isIfStatement(first)) return { kind: 'first-not-sender-gate' }
  // 条件必须是 `!<call>.trusted`。剥掉最外层的 `!`，拿到 `<call>.trusted`，再拿 <call>。
  let condition: ts.Expression = first.expression
  if (ts.isPrefixUnaryExpression(condition) && condition.operator === ts.SyntaxKind.ExclamationToken) {
    condition = condition.operand
  } else {
    return { kind: 'first-not-sender-gate' }
  }
  if (!ts.isPropertyAccessExpression(condition) || condition.name.text !== 'trusted') {
    return { kind: 'first-not-sender-gate' }
  }
  const call = condition.expression
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== 'senderTrust') {
    return { kind: 'first-not-sender-gate' }
  }
  const channelArg = call.arguments[0]
  const senderArg = call.arguments[1]
  const trustedFrame = call.arguments[2]
  // then 分支必须**只**返回，且那条 return **不带实参**。写成 `statements.some(...)` 时，「先 accept(response)
  // 再 return」照旧通过（实测 26 条全绿）；而只判 `isReturnStatement` 时，`return void accept(response)` 也
  // 照旧通过——它是一条合法的 ReturnStatement，`void` 又把 boolean 洗成 void 骗过 tsc，于是不可信发送者的
  // 响应被全盘接受（实测 29 条全绿 + tsc 干净，会发货）。所以「无实参」这一问是承重的，不是洁癖。
  const then = first.thenStatement
  const isBareReturn = (node: ts.Statement): boolean =>
    ts.isReturnStatement(node) && node.expression === undefined
  const onlyThenStatement = ts.isBlock(then) && then.statements.length === 1 ? then.statements[0] : undefined
  const returnsWhenUntrusted =
    isBareReturn(then) || (onlyThenStatement !== undefined && isBareReturn(onlyThenStatement))
  return {
    kind: 'sender-gate',
    senderTrustImportedFrom: importedModuleOf(declarationOf(module, call.expression)),
    channelImportedFrom:
      channelArg !== undefined && ts.isIdentifier(channelArg) ? importedModuleOf(declarationOf(module, channelArg)) : null,
    senderArgIsOwnEventSender:
      senderArg !== undefined &&
      ts.isPropertyAccessExpression(senderArg) &&
      senderArg.name.text === 'sender' &&
      argumentOrigin(module, senderArg.expression, arrow) === 'own-parameter',
    // arg[2] 是被信任的那一帧。不看它，`event.sender` 与 `{}` 都能塞进来——一个认所有 sender，一个拒
    // 所有 sender。判法与 adapterShape 共用 `trustedFrameIsWindowWebContents`，两个站点同一把尺子。
    trustedFrameIsWindowWebContents: trustedFrameIsWindowWebContents(trustedFrame),
    returnsWhenUntrusted
  }
}

/**
 * 一处**在控制响应频道上装监听器**的注册点：用的哪个方法、handler 实参是不是绑定到被审计的那个
 * `acceptControl` 声明。
 *
 * 为什么必须有这一层：`acceptControlGuard` 验的是**声明**，不是**跑着的那个 handler**。审计实测出的最坏
 * 变异正是利用这个缺口——`acceptControl` 原样留着（连 `removeListener` 的引用都还在，看起来完全正常），另
 * 起一句 `ipcMain.on(CONTROL_RESPONSE_CHANNEL, (_e, response) => controlBridge.accept(response))`。于是被
 * 验的那道门一句不改、29 条全绿、tsc 干净，而真正处理消息的是那个**无门**的内联 handler：每个不可信发送者
 * 的控制响应都被接受。「验了一个诚实的声明」与「那个声明就是运行的东西」是两件事。
 *
 * 极性刻意反过来：**不是**列出「哪些方法算注册」，而是列出哪两三个是**摘除**，其余一概算注册。禁止清单
 * 那种极性必漏（记忆 forbidden-list-guard-always-leaks）——`prependListener`、`once` 或任何我没想到的加装
 * 拼法都会从「算注册」的清单里漏掉，而那正是要防的。反过来写，漏的方向变成「多算一个」，那是响亮的假红，
 * 不是静默的洞。
 *
 * 方法名与频道名都不按单一拼法认，各自都被绕过过（recognize-list 必漏，记忆 forbidden-list-guard-always-leaks）：
 * - **方法名**（resolveCalledMethodName）：property-access（`ipcMain.on`）与 element-access（`ipcMain['on']`）
 *   都认。原判据要求 `ts.isPropertyAccessExpression(node.expression)`，对 `ipcMain['on'](CH, evil)` 完全失明
 *   ——连方法名都没读到就跳过，那句无门注册静默上线。
 * - **频道名**（namesControlResponseChannel）：先把实参**折成常量字符串值**再比（constantStringValue，覆盖
 *   字面量 / 无替换模板 / `'a'+'b'` 常量拼接 / 本地 const 别名链），折不出再按**导入绑定**认
 *   （bindsToImportedControlChannel）。原判据只认「字面量或 import 标识符」，被 `const CH = 'control:response'`、
 *   `const CH = CONTROL_RESPONSE_CHANNEL`、`'control:' + 'response'` 三种可发货写法整个绕过。
 *
 * 申报的盲点：
 * 1. 判据按 `<任意对象>.<方法>(频道, handler)` 的形状扫，不校验那个对象就是 `ipcMain`。这是刻意的——
 *    `const im = ipcMain` 这类别名下的注册照旧被算上；代价是别的 emitter 若也用这个频道名会打出一次假红，
 *    那种红是要人来看的，比漏掉一次旁路注册便宜。
 * 2. 频道名与方法名都只认**静态可折**的形状。运行期算出来的名字（`[..].join(':')`、`.concat`、带替换的模板、
 *    `ipcMain[dyn]`、命名空间导入的成员访问）折不出来 → 被**漏算**。这是漏（静默）不是假红，是本层残留的洞。
 */
type ControlChannelRegistration = {
  readonly method: string
  readonly handlerBindsToAcceptControl: boolean
}

/** 摘除监听器的方法。这三个之外的一切都算「装了一个监听器」——极性见上方注释。 */
const LISTENER_REMOVAL_METHODS: ReadonlySet<string> = new Set(['removeListener', 'off', 'removeAllListeners'])

/**
 * 把一个表达式**折叠成常量字符串值**，折不出来给 null。覆盖四种在生产里类型合法、可发货的频道写法：
 * 字符串字面量、无替换的模板串、`'a' + 'b'` 这类常量拼接、以及初始化器最终落到上述任一形状的本地 `const`
 * 别名（逐层解 initializer）。这是频道侧的主判据，取代原来「只认字面量或 import 标识符」那条 recognize-list
 * ——它会被 `const CH = '...'`、`'a' + 'b'` 整个绕过（记忆 forbidden-list-guard-always-leaks）。
 *
 * 为什么不直接走 checker：任务建议用 `checker.getTypeAtLocation(arg).isStringLiteral()` 一把梭把 import 常量、
 * 本地 const、模板、拼接一次搞定。**实测在本文件这套 noLib/noResolve 的单文件 Program 下它折不动生产那条路**：
 * import 进来的 `CONTROL_RESPONSE_CHANNEL` 类型是 `any`（模块没被解析），`'a' + 'b'` 被 broaden 成 `string`
 * （两者都不是 string-literal 类型）；只有 `const x = '字面量'` 和模板串才被 checker 折成字面量类型。所以
 * 这里显式按 AST 折常量值，import 那条改由 bindsToImportedControlChannel 按**绑定**认。
 *
 * 申报的盲点：只认上面四种静态形状。`['control','response'].join(':')`、`.concat(...)`、带替换的模板、
 * 任何运行期算出来的名字都折不出来 → 会被**漏算**（是漏不是假红）。
 */
function constantStringValue(
  module: ParsedModule,
  expression: ts.Expression | undefined,
  seen: Set<ts.Node> = new Set()
): string | null {
  if (expression === undefined || seen.has(expression)) return null
  seen.add(expression)
  if (ts.isParenthesizedExpression(expression)) return constantStringValue(module, expression.expression, seen)
  if (ts.isStringLiteralLike(expression)) return expression.text
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = constantStringValue(module, expression.left, seen)
    const right = constantStringValue(module, expression.right, seen)
    return left !== null && right !== null ? left + right : null
  }
  if (ts.isIdentifier(expression)) {
    const declaration = declarationOf(module, expression)
    if (declaration !== null && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
      return constantStringValue(module, declaration.initializer, seen)
    }
  }
  return null
}

/**
 * 一个标识符**按绑定**是不是 contracts 里那个 `CONTROL_RESPONSE_CHANNEL` 导入（也认最终落到该导入的本地
 * const 别名链，如 `const CH = CONTROL_RESPONSE_CHANNEL`）。这条与 constantStringValue 互补：在本 harness 里
 * import 的值折不出来（类型是 any），得靠绑定身份认；那条又不认字面量拼接。两条并起来才把「常量拼接 / 本地
 * const / import / import 的 const 别名」四种一网打尽。
 *
 * 申报的盲点：只追 import specifier 身份与 const 别名链；命名空间导入的成员访问（`contracts.CONTROL_...`）
 * 不认。
 */
function bindsToImportedControlChannel(
  module: ParsedModule,
  expression: ts.Expression | undefined,
  seen: Set<ts.Node> = new Set()
): boolean {
  if (expression === undefined || !ts.isIdentifier(expression) || seen.has(expression)) return false
  seen.add(expression)
  const declaration = declarationOf(module, expression)
  if (declaration === null) return false
  if (ts.isImportSpecifier(declaration)) {
    return (
      importedModuleOf(declaration) === CONTRACTS_MODULE &&
      (declaration.propertyName ?? declaration.name).text === 'CONTROL_RESPONSE_CHANNEL'
    )
  }
  if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
    return bindsToImportedControlChannel(module, declaration.initializer, seen)
  }
  return false
}

/** arg[0] 指的是不是控制响应频道：先按常量折叠比值，折不出再按导入绑定认。 */
function namesControlResponseChannel(module: ParsedModule, argument: ts.Expression | undefined): boolean {
  if (argument === undefined) return false
  const folded = constantStringValue(module, argument)
  if (folded !== null) return folded === CONTROL_RESPONSE_CHANNEL
  return bindsToImportedControlChannel(module, argument)
}

/**
 * 一次调用的**方法名**：property-access（`ipcMain.on`）与 element-access（`ipcMain['on']`）都认，后者把
 * 方括号里的下标当常量字符串折出来。原判据用 `ts.isPropertyAccessExpression(node.expression)` 把关，对
 * element-access **完全失明**——`ipcMain['on'](CH, evil)` 连方法名都没读到就被跳过（recognize-list 的
 * 另一面）。
 *
 * 申报的盲点：element-access 的下标必须能折成常量字符串；`ipcMain[dyn]` 这种运行期名字折不出 → 返回 null →
 * 不算注册（是**漏**不是假红）。
 */
function resolveCalledMethodName(module: ParsedModule, callee: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text
  if (ts.isElementAccessExpression(callee)) return constantStringValue(module, callee.argumentExpression)
  return null
}

function controlResponseRegistrations(module: ParsedModule): ControlChannelRegistration[] {
  const auditedArrow = acceptControlDeclaration(module)
  const auditedDeclaration = auditedArrow === null ? null : auditedArrow.parent
  const out: ControlChannelRegistration[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && namesControlResponseChannel(module, node.arguments[0])) {
      const method = resolveCalledMethodName(module, node.expression)
      if (method !== null && !LISTENER_REMOVAL_METHODS.has(method)) {
        const handler = node.arguments[1]
        out.push({
          method,
          handlerBindsToAcceptControl:
            handler !== undefined &&
            ts.isIdentifier(handler) &&
            auditedDeclaration !== null &&
            declarationOf(module, handler) === auditedDeclaration
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(module.sourceFile)
  return out
}

const HONEST_ADAPTER: AdapterShape = {
  kind: 'forwards',
  assertImportedFrom: SENDER_TRUST_MODULE,
  senderTrustImportedFrom: SENDER_TRUST_MODULE,
  channelArg: 'own-parameter',
  senderArgIsOwnEventSender: true,
  trustedFrameIsWindowWebContents: true
}

describe('ipc.ts wiring: the shell forwards each privileged sender check to the pure decision (AST, not text)', () => {
  const module = parse(readFileSync(ipcPath, 'utf8'), ipcPath)
  const adapter = adapterDeclaration(module)

  it('imports the pure decision and its throw-half from ipc-sender-trust', () => {
    const names = namedImportsFrom(module, SENDER_TRUST_MODULE)
    expect(names).toContain('senderTrust')
    expect(names).toContain('assertSenderTrusted')
  })

  it('requireTrustedSender is a SOLE-EXPRESSION forward to the imported senderTrust/assertSenderTrusted', () => {
    // 单表达式体 = 体里没有语句位可插早退（把它改成块体、或在里面加一句，都会让 kind 变。这是本轮
    // 变异 (b)「把恒真早退插成 shell 第一句」对适配器这一侧的落点）。callee 的绑定抓变异 (c)「同名影子」。
    expect(adapterShape(module)).toEqual(HONEST_ADAPTER)
  })

  it('every privileged throwing channel forwards its own event to the adapter as its FIRST statement', () => {
    // 正向覆盖：频道清单从行为层的 THROWING_CHANNELS 派生（其锚点又是写死的历史消息表）。任一频道的
    // handler 丢了第一句转发、或转发了错的 event、或 callee 绑定到影子，这里逐条报红。
    expect(THROWING_CHANNELS.length).toBeGreaterThan(0)
    for (const channel of THROWING_CHANNELS) {
      expect(handlerGuard(module, channel, adapter), channel).toEqual({
        kind: 'forwards',
        bindsToAdapter: true,
        channel,
        event: 'own-parameter'
      })
    }
  })

  it('every requireTrustedSender call site names a known privileged throwing channel (reverse allow-list)', () => {
    // 反向：扫出每一处 requireTrustedSender(<channel>) 调用，断言它的频道都在 allow-list 里。自检前提：
    // 扫描面没脱节，否则这条恒真（scan-surface 打错字会让守卫空转变绿）。地板取**全集大小**而不是 > 1：
    // 12 个站点而地板写 > 1 时，提取器截断到 2 个照旧通过，那道地板从来没独立抓住过任何东西（真正抓住
    // 截断的是下面那条逐频道覆盖断言）。地板与覆盖断言各自都该能独立报红，所以这里钉全等。
    const sites = requireTrustedSenderCallChannels(module)
    expect(sites.length, '扫到的 requireTrustedSender 调用数与 allow-list 不等——提取器与 ipc.ts 脱节了').toBe(
      THROWING_CHANNELS.length
    )
    const allowed = new Set<string>(THROWING_CHANNELS)
    expect(sites.filter((channel) => channel === null || !allowed.has(channel))).toEqual([])
    // 且每个会抛的特权频道都至少有一处调用（正向覆盖的第二把锁）。
    expect([...allowed].filter((channel) => !sites.includes(channel))).toEqual([])
  })

  it('acceptControl gates on the imported senderTrust as its FIRST statement, comparing against the window frame, returning only', () => {
    expect(acceptControlGuard(module)).toEqual({
      kind: 'sender-gate',
      senderTrustImportedFrom: SENDER_TRUST_MODULE,
      channelImportedFrom: CONTRACTS_MODULE,
      senderArgIsOwnEventSender: true,
      trustedFrameIsWindowWebContents: true,
      returnsWhenUntrusted: true
    })
  })

  it('every privileged channel in the SOURCE table is accounted for by exactly one of the two gating routes', () => {
    // 完备性那一侧。上面几条都是**从本文件的清单出发**去 ipc.ts 查证；缺的是反过来问：
    // `PRIVILEGED_SENDER_LABELS`（判据模块里那张真表）新增一个键、而 ipc.ts 一处都没给它上门，会不会红？
    // 审计实测：不会——源头加一个键，29 条照旧全绿，一个新的特权频道就那样裸着上线了。
    //
    // 判据把那张表的键**分成恰好两族**，每族各由上面一条断言真的去 ipc.ts 查证过：
    //   - 会抛的那些：由 THROWING_CHANNELS 驱动「第一句转发给适配器」+ 反向 allow-list；
    //   - 控制响应频道：由 acceptControl 的 sender-gate 与「注册点恰好一处」两条。
    // 于是「表里的键 = 两族之并」这条等式一旦被新键打破，就是一处响亮的红，且它指的正是「你加了个特权
    // 频道但没人给它上门」。两族必须**互斥**（一个键同时进两族时，另一族的旁证会掩盖本族的缺失——
    // 记忆 cover-key-cannot-be-in-two-families），所以并集用逐元素比对而不是只比大小。
    //
    // 刻意不给这条写自检：它的左边是被测模块 import 进来的真表，右边是本文件写死的清单，等式恒真是
    // 不可能的——源头多/少一个键就红。再写一条自检会是被它自己完全覆盖的死代码（#805 那条审计指出的
    // 形状）。同理，THROWING_CHANNEL_MESSAGES 保持**手抄**：它是这条等式的外部锚点，一旦改成从
    // PRIVILEGED_SENDER_LABELS 派生，两边就一起漂移，等式当场变成永不失败的装饰。
    const sourceKeys = new Set<string>(Object.keys(PRIVILEGED_SENDER_LABELS))
    const throwing = new Set<string>(THROWING_CHANNELS)
    expect(
      [...throwing].filter((channel) => channel === CONTROL_RESPONSE_CHANNEL),
      '两族必须互斥：控制响应频道走静默返回那条路，不该同时算在会抛的那族里'
    ).toEqual([])
    const gated = new Set<string>([...throwing, CONTROL_RESPONSE_CHANNEL])
    expect(
      [...sourceKeys].filter((channel) => !gated.has(channel)),
      '这些特权频道登记在 PRIVILEGED_SENDER_LABELS 里，却没有任何一条接线断言查证它真的上了门'
    ).toEqual([])
    expect(
      [...gated].filter((channel) => !sourceKeys.has(channel)),
      '这些频道被接线断言当成特权频道查证，却已不在 PRIVILEGED_SENDER_LABELS 里'
    ).toEqual([])
  })

  it('the ONLY listener installed on the control-response channel is that audited acceptControl (no bypassing registration)', () => {
    // 上一条验的是**声明**；这一条验**跑着的东西就是它**。少了这一条，`acceptControl` 原样不动、另起一句
    // `ipcMain.on(CONTROL_RESPONSE_CHANNEL, (_e, r) => controlBridge.accept(r))` 就能让被验的门完全旁路
    // ——审计实测 29 条全绿 + tsc 干净，会发货。
    //
    // 恰好一处：多一处就是旁路（哪一处是诚实的都不重要，另一处照样在收消息）；零处就是这道门根本没上线。
    const registrations = controlResponseRegistrations(module)
    expect(registrations, '控制响应频道上的监听器注册点').toEqual([
      { method: 'on', handlerBindsToAcceptControl: true }
    ])
  })
})

// ---------------------------------------------------------------------------------------------------
// 接线层自检：对每条判据种下它该抓的违规，证明判据不是恒真
// ---------------------------------------------------------------------------------------------------

describe('ipc.ts wiring guard: self-check (the guard reds on planted violations)', () => {
  const IMPORTS =
    "import { senderTrust, assertSenderTrusted, type PrivilegedChannel } from './ipc-sender-trust.js'\n" +
    "import { CONTROL_RESPONSE_CHANNEL } from '../shared/contracts.js'\n" +
    'declare const args: any\n'

  const ADAPTER_DECL =
    'const requireTrustedSender = (channel: PrivilegedChannel, event: any): void =>\n' +
    '  assertSenderTrusted(senderTrust(channel, event.sender, args.window.webContents))\n'

  // --- adapter self-checks ---

  it('adapterShape reports the honest forward for the real shape', () => {
    expect(adapterShape(parse(`${IMPORTS}${ADAPTER_DECL}`))).toEqual(HONEST_ADAPTER)
  })

  it('adapterShape catches a BLOCK body (a statement position where an early return can be inserted)', () => {
    // 变异 (b) 对适配器这一侧：把单表达式改成块体，就有地方插 `if (true) return` 而绕过判据。
    const blockBody = parse(
      `${IMPORTS}const requireTrustedSender = (channel: PrivilegedChannel, event: any): void => {\n` +
        '  if (true) return\n' +
        '  assertSenderTrusted(senderTrust(channel, event.sender, args.window.webContents))\n' +
        '}\n'
    )
    expect(adapterShape(blockBody)).toEqual({ kind: 'not-sole-expression' })
  })

  it('adapterShape catches a same-named local shadow of senderTrust even though the callee text is identical', () => {
    // 变异 (c)：真的 import 仍在顶部，但作用域里另写一个恒 trusted 的同名 senderTrust。拼写一样，绑定不同。
    const shadowed = parse(
      "import { senderTrust as realSenderTrust, assertSenderTrusted, type PrivilegedChannel } from './ipc-sender-trust.js'\n" +
        "import { CONTROL_RESPONSE_CHANNEL } from '../shared/contracts.js'\n" +
        'declare const args: any\n' +
        'const senderTrust = (_c: PrivilegedChannel, _s: unknown, _t: unknown) => ({ trusted: true as const })\n' +
        ADAPTER_DECL
    )
    expect(adapterShape(shadowed)).toMatchObject({ kind: 'forwards', senderTrustImportedFrom: null })
    expect(adapterShape(shadowed)).not.toEqual(HONEST_ADAPTER)
  })

  it('adapterShape catches a same-named local shadow of assertSenderTrusted', () => {
    const shadowed = parse(
      "import { assertSenderTrusted as realAssert, senderTrust, type PrivilegedChannel } from './ipc-sender-trust.js'\n" +
        "import { CONTROL_RESPONSE_CHANNEL } from '../shared/contracts.js'\n" +
        'declare const args: any\n' +
        'const assertSenderTrusted = (_t: unknown): void => {}\n' +
        ADAPTER_DECL
    )
    expect(adapterShape(shadowed)).toMatchObject({ kind: 'forwards', assertImportedFrom: null })
  })

  // --- handler self-checks ---

  /** 把一段 handler 体放进与生产同构的上下文（同样的 imports + 同一个适配器声明 + handleWithEvent 调用）。 */
  const withHandler = (channel: string, body: string): ParsedModule =>
    parse(`${IMPORTS}${ADAPTER_DECL}handleWithEvent('${channel}', (event: any, x: any) => {\n${body}\n})\n`)

  it('handlerGuard reports the honest forward for a first-statement guard call', () => {
    const module = withHandler('ui:writeClipboardImage', "  requireTrustedSender('ui:writeClipboardImage', event)\n  doWork()")
    expect(handlerGuard(module, 'ui:writeClipboardImage', adapterDeclaration(module))).toEqual({
      kind: 'forwards',
      bindsToAdapter: true,
      channel: 'ui:writeClipboardImage',
      event: 'own-parameter'
    })
  })

  it('handlerGuard catches an always-true early return inserted as the first statement', () => {
    // 变异 (b) 对 handler 这一侧：第一句不再是那次转发。
    const module = withHandler(
      'ui:writeClipboardImage',
      "  if (true) return\n  requireTrustedSender('ui:writeClipboardImage', event)\n  doWork()"
    )
    expect(handlerGuard(module, 'ui:writeClipboardImage', adapterDeclaration(module))).toEqual({ kind: 'first-not-forward' })
  })

  it('handlerGuard catches a same-named shadow that the call binds to instead of the adapter (identical callee text)', () => {
    // 变异 (c) 对 handler 这一侧：一个同名 `requireTrustedSender` 形参遮住了那个适配器。第一句仍是
    // `requireTrustedSender('…', event)`（拼写一模一样、仍是第一句），但它绑定到形参而非适配器——按文本
    // 判会放过，按绑定判（bindsToAdapter）抓得住。
    const module = parse(
      `${IMPORTS}${ADAPTER_DECL}handleWithEvent('ui:writeClipboardImage', (event: any, requireTrustedSender: any) => {\n` +
        "  requireTrustedSender('ui:writeClipboardImage', event)\n" +
        '  doWork()\n' +
        '})\n'
    )
    expect(handlerGuard(module, 'ui:writeClipboardImage', adapterDeclaration(module))).toMatchObject({
      kind: 'forwards',
      bindsToAdapter: false
    })
  })

  it('handlerGuard catches an outright removed guard when a SECOND adapter declaration hides the real one', () => {
    // 相关形状：有人再加一个宽松的 `const requireTrustedSender`。adapterDeclaration 见到两个声明就返回
    // null（不再唯一），于是 bindsToAdapter 对所有 handler 都落到 false——这条与 adapterShape 的
    // {kind:'absent'} 自检互为印证。
    const module = parse(
      `${IMPORTS}${ADAPTER_DECL}const requireTrustedSender2Alias = 0\n` +
        'const requireTrustedSender = (_c: any, _e: any): void => {}\n' +
        "handleWithEvent('ui:writeClipboardImage', (event: any, x: any) => {\n" +
        "  requireTrustedSender('ui:writeClipboardImage', event)\n" +
        '  doWork()\n' +
        '})\n'
    )
    expect(adapterDeclaration(module)).toBeNull()
    expect(handlerGuard(module, 'ui:writeClipboardImage', adapterDeclaration(module))).toMatchObject({
      bindsToAdapter: false
    })
  })

  it('handlerGuard catches forwarding a foreign frame instead of the handler own event', () => {
    const module = parse(
      `${IMPORTS}${ADAPTER_DECL}const otherEvent: any = {}\n` +
        "handleWithEvent('ui:writeClipboardImage', (event: any, x: any) => {\n" +
        "  requireTrustedSender('ui:writeClipboardImage', otherEvent)\n" +
        '  doWork()\n' +
        '})\n'
    )
    expect(handlerGuard(module, 'ui:writeClipboardImage', adapterDeclaration(module))).toMatchObject({
      event: 'declared-elsewhere'
    })
  })

  it('handlerGuard reports no-handler when the extractor finds nothing (guards against a vacuous green)', () => {
    expect(handlerGuard(parse(`${IMPORTS}${ADAPTER_DECL}`), 'ui:writeClipboardImage', null)).toEqual({ kind: 'no-handler' })
  })

  // --- acceptControl self-checks ---

  const acceptControlModule = (guardBody: string): ParsedModule =>
    parse(`${IMPORTS}const acceptControl = (event: any, response: any): void => {\n${guardBody}\n}\n`)

  it('acceptControlGuard reports the honest sender gate', () => {
    const module = acceptControlModule(
      '  if (!senderTrust(CONTROL_RESPONSE_CHANNEL, event.sender, args.window.webContents).trusted) return\n' +
        "  if (!response || typeof response.requestId !== 'string') return\n" +
        '  accept(response)'
    )
    expect(acceptControlGuard(module)).toEqual({
      kind: 'sender-gate',
      senderTrustImportedFrom: SENDER_TRUST_MODULE,
      channelImportedFrom: CONTRACTS_MODULE,
      senderArgIsOwnEventSender: true,
      trustedFrameIsWindowWebContents: true,
      returnsWhenUntrusted: true
    })
  })

  it('acceptControlGuard catches the trusted frame being the sender itself (self-comparison accepts every sender)', () => {
    // 变异：arg[2] 换成 event.sender。门还在、第一句还是它、then 还是 return——但比的是自己跟自己，
    // 于是**任何**发送者都可信。这是审计实测存活的那个探针（26 条全绿）。
    const module = acceptControlModule(
      '  if (!senderTrust(CONTROL_RESPONSE_CHANNEL, event.sender, event.sender).trusted) return\n  accept(response)'
    )
    expect(acceptControlGuard(module)).toMatchObject({ kind: 'sender-gate', trustedFrameIsWindowWebContents: false })
  })

  it('acceptControlGuard catches a non-frame trusted argument (rejects every sender: control responses silently dropped)', () => {
    // 反方向的同一个洞：arg[2] 换成不是任何 .webContents 的东西，门恒假，合法控制响应被静默丢弃。
    const module = acceptControlModule(
      '  if (!senderTrust(CONTROL_RESPONSE_CHANNEL, event.sender, {}).trusted) return\n  accept(response)'
    )
    expect(acceptControlGuard(module)).toMatchObject({ kind: 'sender-gate', trustedFrameIsWindowWebContents: false })
  })

  it('acceptControlGuard catches accepting before the return inside the untrusted branch', () => {
    // 变异：保住「第一句是门」与「then 里有 return」，但 return 之前先把响应收了。`some(isReturnStatement)`
    // 会放过它——不可信发送者的响应照旧被接受。
    const module = acceptControlModule(
      '  if (!senderTrust(CONTROL_RESPONSE_CHANNEL, event.sender, args.window.webContents).trusted) {\n' +
        '    accept(response)\n' +
        '    return\n' +
        '  }\n' +
        '  accept(response)'
    )
    expect(acceptControlGuard(module)).toMatchObject({ kind: 'sender-gate', returnsWhenUntrusted: false })
  })

  it('acceptControlGuard catches a RETURN THAT CARRIES A VALUE in the untrusted branch (`return void accept(...)`)', () => {
    // 审计实测存活的那个变异，也是本文件最坏的一个：`return void accept(response)` 是一条合法的
    // ReturnStatement，于是只判 `isReturnStatement` 的旧判据放它过去；`void` 又把 `boolean` 洗成 `void`
    // 骗过 tsc。两者合起来 = 每个不可信发送者的控制响应都被接受，且 29 条全绿 + tsc 干净地发货。
    // 判据因此必须问「这条 return 带不带实参」，不能只问「是不是 return」。
    const module = acceptControlModule(
      '  if (!senderTrust(CONTROL_RESPONSE_CHANNEL, event.sender, args.window.webContents).trusted)\n' +
        '    return void accept(response)\n' +
        '  accept(response)'
    )
    expect(acceptControlGuard(module)).toMatchObject({ kind: 'sender-gate', returnsWhenUntrusted: false })
  })

  it('acceptControlGuard catches a value-carrying return inside a BLOCK too (both shapes, one rule)', () => {
    // 同一件事的块体写法。裸 return 与「块里恰好一条 return」是两条分支，各自都要问「无实参」，
    // 否则收紧了一条、另一条照旧敞着。
    const module = acceptControlModule(
      '  if (!senderTrust(CONTROL_RESPONSE_CHANNEL, event.sender, args.window.webContents).trusted) {\n' +
        '    return void accept(response)\n' +
        '  }\n' +
        '  accept(response)'
    )
    expect(acceptControlGuard(module)).toMatchObject({ kind: 'sender-gate', returnsWhenUntrusted: false })
  })

  it('acceptControlGuard catches a sender-supplied frame that merely SPELLS webContents (`event.sender.webContents`)', () => {
    // 判据曾只看属性名。那样这个形状也算过——而它把「谁可信」交给**被审查方**回答。今天 tsc 恰好用
    // TS2339 挡住这个具体拼法，但那是偶然：换一个类型合法的同名属性来源就重新打开。所以判据连对象
    // 一起判（必须是 `<x>.window.webContents`），不靠 tsc 兜。
    const module = acceptControlModule(
      '  if (!senderTrust(CONTROL_RESPONSE_CHANNEL, event.sender, event.sender.webContents).trusted) return\n' +
        '  accept(response)'
    )
    expect(acceptControlGuard(module)).toMatchObject({
      kind: 'sender-gate',
      trustedFrameIsWindowWebContents: false
    })
  })

  it('acceptControlGuard catches the sender comparison being dropped (first statement no longer the gate)', () => {
    // 变异：删掉发送者门，让它认任何 sender。第一句变成 requestId 形状检查。
    const module = acceptControlModule(
      "  if (!response || typeof response.requestId !== 'string') return\n  accept(response)"
    )
    expect(acceptControlGuard(module)).toEqual({ kind: 'first-not-sender-gate' })
  })

  it('acceptControlGuard catches a same-named local shadow of senderTrust', () => {
    const module = parse(
      "import { senderTrust as realSenderTrust, assertSenderTrusted } from './ipc-sender-trust.js'\n" +
        "import { CONTROL_RESPONSE_CHANNEL } from '../shared/contracts.js'\n" +
        'declare const args: any\n' +
        'declare function accept(r: any): void\n' +
        'const senderTrust = (_c: any, _s: any, _t: any) => ({ trusted: true as const })\n' +
        'const acceptControl = (event: any, response: any): void => {\n' +
        '  if (!senderTrust(CONTROL_RESPONSE_CHANNEL, event.sender, args.window.webContents).trusted) return\n' +
        '  accept(response)\n' +
        '}\n'
    )
    expect(acceptControlGuard(module)).toMatchObject({ kind: 'sender-gate', senderTrustImportedFrom: null })
  })

  // --- control-channel registration self-checks (#809 的判据不是恒真) ---

  /** 与生产同构的注册上下文：诚实的 acceptControl 声明 + 一句 `ipcMain.on(频道, acceptControl)`。 */
  const REGISTRATION_PRELUDE =
    'declare const ipcMain: any\n' +
    'declare function accept(r: any): void\n' +
    'const acceptControl = (event: any, response: any): void => {\n' +
    '  if (!senderTrust(CONTROL_RESPONSE_CHANNEL, event.sender, args.window.webContents).trusted) return\n' +
    '  accept(response)\n' +
    '}\n'

  const registrationModule = (tail: string): ParsedModule => parse(`${IMPORTS}${REGISTRATION_PRELUDE}${tail}`)

  it('controlResponseRegistrations reports the honest single registration bound to acceptControl', () => {
    const module = registrationModule(
      'ipcMain.on(CONTROL_RESPONSE_CHANNEL, acceptControl)\n' +
        'ipcMain.removeListener(CONTROL_RESPONSE_CHANNEL, acceptControl)\n'
    )
    // 摘除那句不算注册（否则诚实的生产代码自己就红）。
    expect(controlResponseRegistrations(module)).toEqual([{ method: 'on', handlerBindsToAcceptControl: true }])
  })

  it('controlResponseRegistrations catches a BYPASSING inline handler alongside the honest declaration (the audited CRITICAL)', () => {
    // 审计实测存活的形状：`acceptControl` 一字未改、`removeListener` 仍引用着它（看起来毫无异常），
    // 但另有一句把一个**无门**的内联 handler 装到同一个频道上。于是每个不可信发送者的控制响应都被接受。
    // 判据落在「注册点恰好一处」上：这里读出两处，其中一处不绑定到被审计的声明。
    const module = registrationModule(
      'ipcMain.on(CONTROL_RESPONSE_CHANNEL, acceptControl)\n' +
        'ipcMain.on(CONTROL_RESPONSE_CHANNEL, (_e: any, response: any) => accept(response))\n' +
        'ipcMain.removeListener(CONTROL_RESPONSE_CHANNEL, acceptControl)\n'
    )
    expect(controlResponseRegistrations(module)).toEqual([
      { method: 'on', handlerBindsToAcceptControl: true },
      { method: 'on', handlerBindsToAcceptControl: false }
    ])
  })

  it('controlResponseRegistrations catches the honest handler being SWAPPED for a same-named local shadow', () => {
    // 注册那句拼写一模一样（`ipcMain.on(CH, acceptControl)`），但装上去的是后声明的那个无门同名者。
    // 按文本判会放过；按绑定判读出 handlerBindsToAcceptControl=false。
    // 注：`acceptControlDeclaration` 取扫到的**最后**一个同名声明，所以这里刻意让影子在前、被审计的在后，
    // 从而「被审计的声明」与「注册用的那个绑定」确实是两个不同的声明。
    const module = parse(
      `${IMPORTS}declare const ipcMain: any\ndeclare function accept(r: any): void\n` +
        'const acceptControl0 = 0\n' +
        'function scope(): void {\n' +
        '  const acceptControl = (_e: any, response: any): void => { accept(response) }\n' +
        '  ipcMain.on(CONTROL_RESPONSE_CHANNEL, acceptControl)\n' +
        '}\n' +
        'const acceptControl = (event: any, response: any): void => {\n' +
        '  if (!senderTrust(CONTROL_RESPONSE_CHANNEL, event.sender, args.window.webContents).trusted) return\n' +
        '  accept(response)\n' +
        '}\n'
    )
    expect(controlResponseRegistrations(module)).toEqual([{ method: 'on', handlerBindsToAcceptControl: false }])
  })

  it('controlResponseRegistrations counts an unusual ADDING spelling too (once/prependListener), because the polarity is removal-listed', () => {
    // 极性验证：清单里只有摘除方法，所以任何别的加装拼法都算注册。若反过来写成「注册方法白名单」，
    // `once`/`prependListener` 这类就会从清单里漏掉——而那正是要防的旁路。这条钉住极性没被写反。
    const module = registrationModule(
      'ipcMain.on(CONTROL_RESPONSE_CHANNEL, acceptControl)\n' +
        'ipcMain.prependListener(CONTROL_RESPONSE_CHANNEL, (_e: any, r: any) => accept(r))\n' +
        'ipcMain.once(CONTROL_RESPONSE_CHANNEL, (_e: any, r: any) => accept(r))\n'
    )
    expect(controlResponseRegistrations(module).map((r) => r.method)).toEqual(['on', 'prependListener', 'once'])
  })

  it('controlResponseRegistrations matches the channel by a VERBATIM string literal too, not only the imported constant', () => {
    // 只认导入常量会被「另抄一份字面量」整个绕过。字面量的期望值取自本文件真的 import 进来的那个常量，
    // 不手抄第二份。
    const module = registrationModule(
      'ipcMain.on(CONTROL_RESPONSE_CHANNEL, acceptControl)\n' +
        `ipcMain.on('${CONTROL_RESPONSE_CHANNEL}', (_e: any, r: any) => accept(r))\n`
    )
    expect(controlResponseRegistrations(module)).toEqual([
      { method: 'on', handlerBindsToAcceptControl: true },
      { method: 'on', handlerBindsToAcceptControl: false }
    ])
  })

  it('controlResponseRegistrations ignores registrations on OTHER channels (no false red from unrelated listeners)', () => {
    const module = registrationModule(
      'ipcMain.on(CONTROL_RESPONSE_CHANNEL, acceptControl)\n' +
        "ipcMain.on('some:other-channel', (_e: any, r: any) => accept(r))\n"
    )
    expect(controlResponseRegistrations(module)).toEqual([{ method: 'on', handlerBindsToAcceptControl: true }])
  })

  it('controlResponseRegistrations reports EMPTY when nothing is registered (the gate never goes live)', () => {
    // 反向的同一个洞：诚实的门写好了但一处都没装。断言钉「恰好一处」而不是「至少一处不是旁路」，
    // 正是为了让这一侧也红。
    expect(controlResponseRegistrations(registrationModule(''))).toEqual([])
  })

  // --- 方法名侧：element-access 拼法（原判据对它完全失明，是四个可发货绕过之一） ---

  it('controlResponseRegistrations catches an ELEMENT-ACCESS install `ipcMain[\'on\'](CH, evil)` (property-access-only was blind)', () => {
    // 原判据要求 `ts.isPropertyAccessExpression(node.expression)`，于是 `ipcMain['on'](CH, evil)` 连方法名
    // 都没读到就被跳过——那句无门注册静默上线。现在 resolveCalledMethodName 把方括号下标折成常量方法名。
    const module = registrationModule(
      'ipcMain.on(CONTROL_RESPONSE_CHANNEL, acceptControl)\n' +
        "ipcMain['on'](CONTROL_RESPONSE_CHANNEL, (_e: any, response: any) => accept(response))\n" +
        'ipcMain.removeListener(CONTROL_RESPONSE_CHANNEL, acceptControl)\n'
    )
    expect(controlResponseRegistrations(module)).toEqual([
      { method: 'on', handlerBindsToAcceptControl: true },
      { method: 'on', handlerBindsToAcceptControl: false }
    ])
  })

  it('resolveCalledMethodName reads the bracket contents, not a constant `on`: element-access REMOVAL still excluded', () => {
    // 正向探针 + 防退化：诚实注册与摘除都写成 element-access。若 resolveCalledMethodName 退化成恒返回 'on'，
    // 这里的 `['removeListener']` 会被误算成一次注册（读出两处）——本条会红。它证明方法名是真从方括号里
    // 折出来的，不是常量。
    const module = registrationModule(
      "ipcMain['on'](CONTROL_RESPONSE_CHANNEL, acceptControl)\n" +
        "ipcMain['removeListener'](CONTROL_RESPONSE_CHANNEL, acceptControl)\n"
    )
    expect(controlResponseRegistrations(module)).toEqual([{ method: 'on', handlerBindsToAcceptControl: true }])
  })

  // --- 频道名侧：三种可发货的非字面量拼法（原判据只认字面量或 import 标识符，被整个绕过） ---

  it('namesControlResponseChannel folds constant concatenation `\'a\' + \'b\'` (was neither literal nor identifier)', () => {
    // `'control:' + 'response'` 既不是字面量也不是标识符，原判据放它过去。两个操作数从真常量派生（拆两半），
    // 不手抄第二份频道名；若 constantStringValue 折错值，这个绕过就不会被算上（读出一处）——本条会红。
    const mid = Math.floor(CONTROL_RESPONSE_CHANNEL.length / 2)
    const left = CONTROL_RESPONSE_CHANNEL.slice(0, mid)
    const right = CONTROL_RESPONSE_CHANNEL.slice(mid)
    const module = registrationModule(
      'ipcMain.on(CONTROL_RESPONSE_CHANNEL, acceptControl)\n' +
        `ipcMain.on('${left}' + '${right}', (_e: any, response: any) => accept(response))\n` +
        'ipcMain.removeListener(CONTROL_RESPONSE_CHANNEL, acceptControl)\n'
    )
    expect(controlResponseRegistrations(module)).toEqual([
      { method: 'on', handlerBindsToAcceptControl: true },
      { method: 'on', handlerBindsToAcceptControl: false }
    ])
  })

  it('namesControlResponseChannel follows a local const alias to the imported constant `const CH = CONTROL_RESPONSE_CHANNEL`', () => {
    // 本地 const 别名到 import：constantStringValue 在本 harness 折不出（import 值是 any），改由
    // bindsToImportedControlChannel 追别名链到 import specifier 认出来。
    const module = registrationModule(
      'const CH2 = CONTROL_RESPONSE_CHANNEL\n' +
        'ipcMain.on(CONTROL_RESPONSE_CHANNEL, acceptControl)\n' +
        'ipcMain.on(CH2, (_e: any, response: any) => accept(response))\n' +
        'ipcMain.removeListener(CONTROL_RESPONSE_CHANNEL, acceptControl)\n'
    )
    expect(controlResponseRegistrations(module)).toEqual([
      { method: 'on', handlerBindsToAcceptControl: true },
      { method: 'on', handlerBindsToAcceptControl: false }
    ])
  })

  it('namesControlResponseChannel follows a local const alias to a string literal `const CH = \'control:response\'`', () => {
    // 本地 const 别名到字面量：constantStringValue 追别名链解到字面量。字面量的值取自真常量插值，不手抄。
    const module = registrationModule(
      `const CH2 = '${CONTROL_RESPONSE_CHANNEL}'\n` +
        'ipcMain.on(CONTROL_RESPONSE_CHANNEL, acceptControl)\n' +
        'ipcMain.on(CH2, (_e: any, response: any) => accept(response))\n' +
        'ipcMain.removeListener(CONTROL_RESPONSE_CHANNEL, acceptControl)\n'
    )
    expect(controlResponseRegistrations(module)).toEqual([
      { method: 'on', handlerBindsToAcceptControl: true },
      { method: 'on', handlerBindsToAcceptControl: false }
    ])
  })

  it('a const alias to a DIFFERENT value is NOT counted (channel matchers compare the folded value, not constant-true)', () => {
    // 防退化的另一极：若 constantStringValue/namesControlResponseChannel 退化成恒真，这个指向别的频道的
    // const 别名会被误算——本条会红。它证明频道名判据真的在比值，不是恒真。
    const module = registrationModule(
      "const OTHER = 'some:other-channel'\n" +
        'ipcMain.on(CONTROL_RESPONSE_CHANNEL, acceptControl)\n' +
        'ipcMain.on(OTHER, (_e: any, response: any) => accept(response))\n'
    )
    expect(controlResponseRegistrations(module)).toEqual([{ method: 'on', handlerBindsToAcceptControl: true }])
  })
})
