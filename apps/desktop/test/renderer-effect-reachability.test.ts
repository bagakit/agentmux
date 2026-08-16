import { describe, expect, it } from 'vitest'
import {
  assertEarlyExitGuards,
  assertReachable,
  earlyExitConditionsBefore,
  findCallsToIdentifier,
  findCallsToMember,
  parseTsx,
  pickCallByArgument,
  readAndParse
} from './helpers/effect-reachability.js'

/**
 * 五条 renderer effect 的**可达性**守卫，全部走 test/helpers/effect-reachability.ts。
 *
 * 为什么要有这一整个文件（本仓反复记录的同族洞，见 MEMORY「grep 守卫看不见早退」「renderToStaticMarkup
 * 对 effect 完全失明」）：当初 desktop 包没有 DOM 测试环境，SSR 不执行 effect；这些 effect 此前**只**被文本断言
 * （`readFileSync` + `toContain`）守着。文本断言不执行代码——在 effect 第一行插一句 `return`（或
 * `if (someNonEmptyString) return`，保留 tsc 收窄使其沉默），整条 effect 塌成 no-op，而被 `toContain` 的
 * 那行字面量原封不动地留着，套件照旧全绿。下面每条都实测过：以「保留收窄的无条件早退」变异后，其原有
 * 的文本/接线断言**全绿存活**，只有这里的可达性断言变红。
 *
 * 判据分两形：
 *   - `assertReachable`：正确形状里那句关键调用之前**一个出口都不该有**。
 *   - `assertEarlyExitGuards(白名单)`：正确形状里本来就有一两句**合法** guard clause；断言早退守护恰好
 *     等于白名单——另插一句早退（多一项）红，删掉一句合法守护（少一项）也红。
 *
 * 这些断言**只**证明「若 effect 体被执行，那句调用可达 / 早退守护与声明一致」。它们证明不了 effect 会被
 * 挂载、会以正确依赖重跑（另由 DOM 测试验证）。别当行为测试用。
 */

const componentUrl = (name: string): string =>
  new URL(`../src/renderer/src/components/${name}`, import.meta.url).pathname

describe('renderer effect 可达性（插一句早退让 effect 变 no-op → 这里红）', () => {
  it('InlineComposer：可见时聚焦输入框那条 effect 里，focus() 之前没有早退', () => {
    // The rich editor owns focus. Its actual visibility behavior is exercised by
    // composer-input-ownership.test.tsx; this guard still rejects an early-return no-op.
    const { sourceFile } = readAndParse(componentUrl('InlineComposer.tsx'))
    const calls = findCallsToMember(sourceFile, 'focus').filter((call) => call.expression.getText() === 'editor.commands.focus')
    expect(calls, 'editor.commands.focus() 应恰有一处').toHaveLength(1)
    assertReachable(calls[0]!, 'InlineComposer autoFocus effect')
  })

  it('TerminalView：可见性 layout effect 里，rememberTerminalViewport 之前没有早退', () => {
    // 变异（实测存活于 hidden-tab-terminal-retention.test.ts:87 与 terminal-viewport-memory.test.ts:37）：
    //   useLayoutEffect(() => { if (themeId) return; const terminal = terminalRef.current; ... }, [visible])
    // 用 `if (themeId) return`（themeId 是必填非空串 prop，等价于无条件早退）而非裸 return——裸 return 会
    // 让下游 `terminal` 丢掉收窄、tsc 偶然报错，给人「tsc 会拦」的错觉；保留收窄的坏形状 tsc 全程沉默。
    const { sourceFile } = readAndParse(componentUrl('TerminalView.tsx'))
    const calls = findCallsToIdentifier(sourceFile, 'rememberTerminalViewport')
    expect(calls, 'rememberTerminalViewport(...) 应恰有一处').toHaveLength(1)
    assertReachable(calls[0]!, 'TerminalView visibility layout effect')
  })

  it('EditorPane：恢复触发器 effect 的早退守护恰好是那句 document||issue||released', () => {
    // 变异（实测存活于 editor-pane-reveal.test.tsx 的 toContain/toMatch，其注释自承「删掉整条 effect
    // 50 条全绿」）：在合法守护之上插一句 `if (key) return`（key 是非空串），attachPersistedDocument
    // 永不触发，而 `if (document || issue || released) return\n void attachPersistedDocument(...)` 的
    // toMatch 仍命中（它只查守护与调用相邻，不查守护之上还有没有别的出口）。
    const { sourceFile } = readAndParse(componentUrl('EditorPane.tsx'))
    const calls = findCallsToIdentifier(sourceFile, 'attachPersistedDocument')
    expect(calls, 'attachPersistedDocument(...) 应恰有一处调用').toHaveLength(1)
    assertEarlyExitGuards(
      calls[0]!,
      ['document || issue || released'],
      'EditorPane 恢复触发器 effect'
    )
  })

  it('BrowserPane：标注写入 effect 的早退守护恰好是那句 released', () => {
    // 变异（实测存活于 surface-memory-budget-contract.test.ts:93 的 toContain('if (released) return')）：
    //   插一句 `if (tab.browserId) return`（browserId 非空串）→ setAnnotationMarkers 永不触发，
    //   而 `if (released) return` 那行字面量还在，toContain 照旧绿。
    const { sourceFile } = readAndParse(componentUrl('BrowserPane.tsx'))
    const calls = findCallsToMember(sourceFile, 'setAnnotationMarkers')
    expect(calls, 'setAnnotationMarkers(...) 应恰有一处').toHaveLength(1)
    assertEarlyExitGuards(calls[0]!, ['released'], 'BrowserPane 标注写入 effect')
  })

  it('FileExplorer：reveal effect 里，选中那次之前的守护恰好是那句 revealRequest 三判', () => {
    // 变异（实测存活于 surface-tool-dock.test.ts:347 的 toContain）：插一句 `if (workspaceId) return`
    //（workspaceId 非空串，reveal 本就只在有 workspace 时有意义）→ setSelection 那条路永不触发，
    // 而 `setSelection(createSingleFileExplorerSelection(revealRequest.path))` 字面量还在，toContain 绿。
    const { sourceFile } = readAndParse(componentUrl('FileExplorer.tsx'))
    // createSingleFileExplorerSelection 在文件里出现多处；reveal effect 那次由实参 revealRequest.path 区分。
    const target = pickCallByArgument(
      findCallsToIdentifier(sourceFile, 'createSingleFileExplorerSelection'),
      'revealRequest.path',
      'FileExplorer reveal 选中调用'
    )
    assertEarlyExitGuards(
      target,
      ['!revealRequest || revealRequest.workspaceId !== workspaceId || revealRequest.requestId === lastRevealRequestIdRef.current'],
      'FileExplorer reveal effect'
    )
  })

  // ---- 守卫的守卫：证明新判据对每种变异各自独立变红，且不是恒真的（不改真文件，变异硬编码 fixture）。 ----

  const parse = (src: string) => parseTsx('fixture.tsx', src)
  const firstCall = (src: string, name: string) => findCallsToIdentifier(parse(src), name)[0]!

  it('assertEarlyExitGuards 自检：另插一句早退 → 守护集合多一项 → 红；删掉合法守护 → 少一项 → 红', () => {
    // 与 EditorPane 同形的干净 fixture：一句合法守护 + 那句调用。
    const CLEAN = [
      'const C = () => {',
      '  useEffect(() => {',
      '    if (document || issue || released) return',
      '    void attachPersistedDocument(a, b)',
      '  }, [])',
      '}'
    ].join('\n')

    // 干净形状：守护恰好是声明的那一句 → 断言通过（否则自检自身恒假）。
    expect(earlyExitConditionsBefore(firstCall(CLEAN, 'attachPersistedDocument')))
      .toEqual(['document || issue || released'])

    // 变异 A：在合法守护之上另插一句无条件早退（保留收窄）。守护集合从 1 项变 2 项。
    const injected = CLEAN.replace(
      '    if (document || issue || released) return',
      '    if (key) return\n    if (document || issue || released) return'
    )
    expect(injected).not.toBe(CLEAN)
    expect(earlyExitConditionsBefore(firstCall(injected, 'attachPersistedDocument')))
      .toEqual(['key', 'document || issue || released'])
    // 直接质询断言：这次变异会让 assertEarlyExitGuards(白名单=['document || issue || released']) 抛。
    expect(() =>
      assertEarlyExitGuards(firstCall(injected, 'attachPersistedDocument'), ['document || issue || released'], 'fixture')
    ).toThrow()

    // 变异 B：删掉那句合法守护。守护集合从 1 项变 0 项 → 与白名单不等 → 红。
    const removed = CLEAN.replace('    if (document || issue || released) return\n', '')
    expect(removed).not.toBe(CLEAN)
    expect(() =>
      assertEarlyExitGuards(firstCall(removed, 'attachPersistedDocument'), ['document || issue || released'], 'fixture')
    ).toThrow()
  })

  it('assertReachable 自检：裸 return 与 if(nonEmpty) return 都被抓住；干净形状通过', () => {
    const clean = 'const C = () => { useEffect(() => { const t = f(); g(t) }, []) }'
    expect(() => assertReachable(firstCall(clean, 'g'), 'fixture')).not.toThrow()

    const bare = 'const C = () => { useEffect(() => { return; const t = f(); g(t) }, []) }'
    expect(() => assertReachable(firstCall(bare, 'g'), 'fixture')).toThrow()

    // 语义恒真但语法有条件的早退——「数出口 + 判极性」那种守卫的盲点，这里照样红。
    const guarded = 'const C = () => { useEffect(() => { if (id) return; const t = f(); g(t) }, []) }'
    expect(() => assertReachable(firstCall(guarded, 'g'), 'fixture')).toThrow()
  })

  it('earlyExitConditionsBefore 自检：嵌套函数里的 return 与调用之后的 return 都不算', () => {
    // setExpanded 回调里的 `return next` 属于那个回调，不是本 effect 的出口（否则 FileExplorer 那条会误报）。
    const withNested = [
      'const C = () => {',
      '  useEffect(() => {',
      '    if (guard) return',
      '    doStuff((cur) => { const n = cur; return n })',
      '    target(revealRequest.path)',
      '  }, [])',
      '}'
    ].join('\n')
    const call = findCallsToIdentifier(parse(withNested), 'target')[0]!
    expect(earlyExitConditionsBefore(call)).toEqual(['guard'])
  })

  it('pickCallByArgument 自检：按实参从同名多处调用里挑出唯一一处，命中数不为 1 就抛', () => {
    const src = [
      'const C = () => {',
      '  sel(create(node.path))',
      '  sel(create(revealRequest.path))',
      '  sel(create(data.path))',
      '}'
    ].join('\n')
    const calls = findCallsToIdentifier(parse(src), 'create')
    expect(calls).toHaveLength(3)
    const picked = pickCallByArgument(calls, 'revealRequest.path', 'fixture')
    expect(picked.getText()).toBe('create(revealRequest.path)')
    // 没有任何一处匹配 → 抛（不是静默返回一个恒过的东西）。
    expect(() => pickCallByArgument(calls, 'nope.nowhere', 'fixture')).toThrow()
  })
})
