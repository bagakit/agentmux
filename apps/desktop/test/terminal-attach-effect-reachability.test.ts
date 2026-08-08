import { describe, expect, it } from 'vitest'
import {
  assertEarlyExitGuards,
  earlyExitConditionsBefore,
  findCallsToIdentifier,
  findCallsToMember,
  parseTsx,
  readAndParse
} from './helpers/effect-reachability.js'

/**
 * TerminalView 的 attach effect（deps `[session.control.run.runId, session.id, themeId]`，体内
 * `new Terminal(...)` → `terminal.open(root)` → 装 addon / 接 provider / 订阅输入输出 / 挂
 * ResizeObserver 的那一大条）里，有**六处接线调用**此前没有任何测试覆盖。reviewer 把这六处逐一
 * 变异，六次全部在套件全绿下存活——这里就是补上的可达性守卫。
 *
 * 为什么这些接线守不住（本仓反复记录的同族洞，见 MEMORY「renderToStaticMarkup 对 effect 完全失明」
 * 「grep 守卫看不见早退」「结构守卫对整体 no-op 免疫」）：desktop 包没有 DOM 测试环境
 *（vitest 里 environment 零命中，无 jsdom / happy-dom），组件渲染只有 `renderToStaticMarkup`，
 * 它来自 react-dom/server，**不跑 useEffect**。于是 attach effect 体内那些调用**从不执行**，任何
 * 行为测试都摸不到它们。此前唯一能守它们的只有源码文本断言（`readFileSync` + `toContain`），而
 * 文本断言**不执行代码**：在调用上方插一句 `if (someNonEmptyString) return`，整段接线塌成 no-op，
 * 被 `toContain` 的那行字面量却原封不动地留在下面，套件照旧全绿。「字面量在场」与「那句调用可达」
 * 是两件事。
 *
 * 判据因此是**可达性**而不是**在场**：解析 AST，找到那句接线调用，要求它之前、同一个 effect 体内
 * 的早退守护**恰好**等于 attach effect 里唯一合法的那句顶层守护 `if (!root) return`。这条判据同时红于：
 *   - 调用被删除 / 被换成不调它的等价壳（`findCallsTo*` 命中数不再是 1）——reviewer 那六次变异的形状；
 *   - 在它上方**另插**一句早退（守护集合多一项 `['<新条件>', '!root']`，与 `['!root']` 不等）——
 *     「数出口 + 判极性」那种守卫的盲点（它认不出 `if (nonEmpty) return` 这种语义恒真的早退）；
 *   - 顶层那句 `if (!root) return` 被删掉（守护集合变空，与 `['!root']` 不等）——它是承重的：没有它，
 *     effect 会拿着 null root 往下跑。
 *
 * 为什么用 `assertEarlyExitGuards(['!root'])` 而不是 `assertReachable`（要求零早退）：attach effect
 * **本来就该有** `if (!root) return` 这句合法 guard clause。用「零早退」判据会对这句正当代码打假红，
 * 而假红的守卫迟早被人删掉，比没有守卫更糟（本仓原则）。ALLOW 侧的对称探针见文件末尾「守卫的守卫」：
 * 干净形状（`if (!root) return` 在上、调用在下）必须通过，注入/删除必须红——证明这条判据既不恒真、
 * 也不会误伤合法的那句守护。
 *
 * 这些断言**只**证明「若 effect 体被执行，这六句接线可达」。它们证明不了 effect 会被挂载、会以正确
 * 依赖重跑（那要真正的 DOM 测试环境，本仓没有）。别当行为测试用——底层各 lib 的行为另有测试。
 */

const sourcePath = new URL('../src/renderer/src/components/TerminalView.tsx', import.meta.url).pathname

// attach effect 里唯一合法的顶层早退。六处接线都排在它之后，故各自的早退守护集合都应恰好是这一项。
const ATTACH_EARLY_EXITS = ['!root']

/** 每条 it 都重新解析一份，互不污染。 */
const load = () => readAndParse(sourcePath).sourceFile

describe('attach effect 的六处接线都可达（在 effect 体内 if (!root) return 之后、之前无别的早退）', () => {
  it('registerLinkProvider：文件路径 link provider 被注册（丢了则终端里的路径不再可点、点击不开编辑器）', () => {
    // 变异实测存活（本任务 MUTATION B）：把 `terminal.registerLinkProvider({...})` 换成一个忽略实参、
    // 返回 `{ dispose(){} }` 的壳，cleanup 里的 `pathLinks.dispose()` 照旧编译，scoped 套件全绿。
    const calls = findCallsToMember(load(), 'registerLinkProvider')
    expect(calls, 'terminal.registerLinkProvider(...) 应恰有一处').toHaveLength(1)
    assertEarlyExitGuards(calls[0]!, ATTACH_EARLY_EXITS, 'TerminalView attach: 文件路径 link provider')
  })

  it('onContextLoss：WebGL 上下文丢失回调被接（丢了则 GPU 上下文丢失后不回退 DOM renderer、画布变黑）', () => {
    // `webgl.onContextLoss(() => { webgl?.dispose(); webgl = null })` 是「GPU 上下文丢了就 dispose
    // WebGL addon、让 xterm 退回 DOM renderer」的唯一触发器。删掉它，上下文丢失后终端停止渲染而无人
    // 收拾。它长在 try 块里（try 不是函数边界），故它之前的 effect 级早退仍只有那句 if (!root) return。
    const calls = findCallsToMember(load(), 'onContextLoss')
    expect(calls, 'webgl.onContextLoss(...) 应恰有一处').toHaveLength(1)
    assertEarlyExitGuards(calls[0]!, ATTACH_EARLY_EXITS, 'TerminalView attach: WebGL 上下文丢失回退')
  })

  it('acquireTerminalResourceOwners：addon / listener 泄漏账本被登记（丢了则泄漏检测启动期失明）', () => {
    // 变异实测存活（本任务 MUTATION C）：换成返回 no-op release 的壳，cleanup 里 releaseResourceOwners()
    // 照旧编译。这条守的是**可观测性接线本身**——泄漏账没登记，addon/listener 少释放一条也没人报。
    const calls = findCallsToIdentifier(load(), 'acquireTerminalResourceOwners')
    expect(calls, 'acquireTerminalResourceOwners(...) 应恰有一处调用').toHaveLength(1)
    assertEarlyExitGuards(calls[0]!, ATTACH_EARLY_EXITS, 'TerminalView attach: 资源泄漏账本')
  })

  it('onRender：首帧渲染后的 observeViewport 被挂（丢了则 xterm 首次布局后不与容器同步、初始 fit 丢失）', () => {
    // `renderReady = terminal.onRender(() => { renderReady?.dispose(); ...; viewport.observeViewport() })`
    // 是「等 xterm 真画出第一帧再做首次视口观测」的一次性钩子。删掉它，初始那次 fit 不发生，网格可能
    // 停在创建时的默认尺寸。回调体里的 `renderReady?.dispose()` 是 .dispose，不与本判据的 onRender 撞名。
    const calls = findCallsToMember(load(), 'onRender')
    expect(calls, 'terminal.onRender(...) 应恰有一处').toHaveLength(1)
    assertEarlyExitGuards(calls[0]!, ATTACH_EARLY_EXITS, 'TerminalView attach: 首帧后视口观测')
  })

  it('onSelectionChange：选区变化订阅被接（丢了则 hasSelection 永不更新、右键菜单 Copy 永远灰）', () => {
    // `terminal.onSelectionChange(() => { ...; setHasSelection(text.length > 0) })` 是「用户用鼠标选了字
    // → Copy 可用」的唯一驱动。删掉它，选了字菜单里的复制也点不动。
    const calls = findCallsToMember(load(), 'onSelectionChange')
    expect(calls, 'terminal.onSelectionChange(...) 应恰有一处').toHaveLength(1)
    assertEarlyExitGuards(calls[0]!, ATTACH_EARLY_EXITS, 'TerminalView attach: 选区变化订阅')
  })

  it('resize.observe(root)：ResizeObserver 真的开始观测（丢了则拖分栏/改窗口后终端不 refit、网格错位）', () => {
    // 变异实测存活（本任务 MUTATION A）：删掉 `resize.observe(root)` 这一句，`new ResizeObserver(...)` 还在
    // 但从不观测任何元素，容器尺寸变化时 viewport.observeViewport 永不触发，全套件全绿。member 名 'observe'
    // 与回调里的 'observeViewport' 是不同的属性名，不会互相命中。
    const calls = findCallsToMember(load(), 'observe')
    expect(calls, 'resize.observe(root) 应恰有一处').toHaveLength(1)
    assertEarlyExitGuards(calls[0]!, ATTACH_EARLY_EXITS, 'TerminalView attach: ResizeObserver 观测')
  })

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // 守卫的守卫：不碰真文件，用硬编码 fixture 证明「早退守护恰好 ['!root']」这条判据对每种变异各自独立
  // 变红，且干净形状（ALLOW 侧）必过——即它既不恒真、也不误伤 attach effect 本来就有的那句 if (!root)。
  // ─────────────────────────────────────────────────────────────────────────────────────────────

  const parse = (src: string) => parseTsx('fixture.tsx', src)

  // 与 attach effect 同形的最小 fixture：顶层一句合法守护 if (!root) return，其后是那句接线调用。
  const CLEAN = [
    'const C = () => {',
    '  useEffect(() => {',
    '    if (!root) return',
    '    const pathLinks = terminal.registerLinkProvider(spec)',
    '    return () => pathLinks.dispose()',
    '  }, [deps])',
    '}'
  ].join('\n')

  const firstMemberCall = (src: string, prop: string) => findCallsToMember(parse(src), prop)[0]!

  it('ALLOW 侧：干净形状（if (!root) return 在上、调用在下）通过——判据不误伤那句合法守护', () => {
    // 若这条不过，说明把合法的 if (!root) 也判成了危害，六条主判据会对正确源码打假红。
    expect(earlyExitConditionsBefore(firstMemberCall(CLEAN, 'registerLinkProvider'))).toEqual(['!root'])
    expect(() =>
      assertEarlyExitGuards(firstMemberCall(CLEAN, 'registerLinkProvider'), ['!root'], 'fixture')
    ).not.toThrow()
  })

  it('DENY 侧：在合法守护之上另插一句早退（保留收窄）→ 守护集合多一项 → 红', () => {
    // 这正是「数出口 + 判极性」守卫的盲点：`if (id) return` 语义恒真但语法有条件，删调用之外还能这样
    // 让它不可达。`id` 是非空串时这是一次无条件早退，registerLinkProvider 永不执行，而它那行字面量还在。
    const injected = CLEAN.replace(
      '    if (!root) return',
      '    if (id) return\n    if (!root) return'
    )
    expect(injected).not.toBe(CLEAN)
    expect(earlyExitConditionsBefore(firstMemberCall(injected, 'registerLinkProvider')))
      .toEqual(['id', '!root'])
    expect(() =>
      assertEarlyExitGuards(firstMemberCall(injected, 'registerLinkProvider'), ['!root'], 'fixture')
    ).toThrow()
  })

  it('DENY 侧：删掉承重的 if (!root) return → 守护集合变空 → 红', () => {
    // 白名单是 ['!root']；删掉它守护集合变 []，与白名单不等即红。这样这句守护不能被静默删。
    const removed = CLEAN.replace('    if (!root) return\n', '')
    expect(removed).not.toBe(CLEAN)
    expect(() =>
      assertEarlyExitGuards(firstMemberCall(removed, 'registerLinkProvider'), ['!root'], 'fixture')
    ).toThrow()
  })

  it('DENY 侧：调用被删 / 换成不调它的等价壳 → 命中数不为 1 → 主判据的 toHaveLength(1) 红', () => {
    // reviewer 那六次变异的形状：调用消失（或被换成一个自造壳），member 名不再命中。
    const gutted = CLEAN.replace(
      '    const pathLinks = terminal.registerLinkProvider(spec)',
      '    const pathLinks = ((_ignored) => ({ dispose() {} }))(spec)'
    )
    expect(gutted).not.toBe(CLEAN)
    expect(findCallsToMember(parse(gutted), 'registerLinkProvider')).toHaveLength(0)
  })
})
