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
const THROWING_CHANNELS: readonly PrivilegedChannel[] = THROWING_CHANNEL_MESSAGES.map(([channel]) => channel)

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
      trustedFrameIsWebContents: boolean
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
  const trustedFrame = inner.arguments[2]
  const trustedFrameIsWebContents =
    trustedFrame !== undefined &&
    ts.isPropertyAccessExpression(trustedFrame) &&
    trustedFrame.name.text === 'webContents'
  return {
    kind: 'forwards',
    assertImportedFrom: importedModuleOf(declarationOf(module, outer.expression)),
    senderTrustImportedFrom: importedModuleOf(declarationOf(module, inner.expression)),
    channelArg: argumentOrigin(module, inner.arguments[0], arrow),
    senderArgIsOwnEventSender,
    trustedFrameIsWebContents
  }
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
      trustedFrameIsWebContents: boolean
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
  // then 分支必须**只**返回。写成 `statements.some(...)` 时，「先 accept(response) 再 return」照旧通过——
  // 那正是不可信发送者被接受的形状（实测 26 条全绿）。裸 return 或「块里恰好一条 return」才算。
  const then = first.thenStatement
  const returnsWhenUntrusted =
    ts.isReturnStatement(then) ||
    (ts.isBlock(then) && then.statements.length === 1 && ts.isReturnStatement(then.statements[0]))
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
    // 所有 sender。判法与 adapterShape 的 trustedFrameIsWebContents 一致，两个站点同一把尺子。
    trustedFrameIsWebContents:
      trustedFrame !== undefined &&
      ts.isPropertyAccessExpression(trustedFrame) &&
      trustedFrame.name.text === 'webContents',
    returnsWhenUntrusted
  }
}

const HONEST_ADAPTER: AdapterShape = {
  kind: 'forwards',
  assertImportedFrom: SENDER_TRUST_MODULE,
  senderTrustImportedFrom: SENDER_TRUST_MODULE,
  channelArg: 'own-parameter',
  senderArgIsOwnEventSender: true,
  trustedFrameIsWebContents: true
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
      trustedFrameIsWebContents: true,
      returnsWhenUntrusted: true
    })
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
      trustedFrameIsWebContents: true,
      returnsWhenUntrusted: true
    })
  })

  it('acceptControlGuard catches the trusted frame being the sender itself (self-comparison accepts every sender)', () => {
    // 变异：arg[2] 换成 event.sender。门还在、第一句还是它、then 还是 return——但比的是自己跟自己，
    // 于是**任何**发送者都可信。这是审计实测存活的那个探针（26 条全绿）。
    const module = acceptControlModule(
      '  if (!senderTrust(CONTROL_RESPONSE_CHANNEL, event.sender, event.sender).trusted) return\n  accept(response)'
    )
    expect(acceptControlGuard(module)).toMatchObject({ kind: 'sender-gate', trustedFrameIsWebContents: false })
  })

  it('acceptControlGuard catches a non-frame trusted argument (rejects every sender: control responses silently dropped)', () => {
    // 反方向的同一个洞：arg[2] 换成不是任何 .webContents 的东西，门恒假，合法控制响应被静默丢弃。
    const module = acceptControlModule(
      '  if (!senderTrust(CONTROL_RESPONSE_CHANNEL, event.sender, {}).trusted) return\n  accept(response)'
    )
    expect(acceptControlGuard(module)).toMatchObject({ kind: 'sender-gate', trustedFrameIsWebContents: false })
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
})
