import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// App 的窗口路由接线层。判定/翻译/转发各自的纯函数层由 shortcut-registry.test.ts 与
// workbench-shortcuts.test.ts 守；但判定再对，没人把它接到窗口监听、没人把 handler map 喂进路由，用户
// 按了照样什么都不发生。这一层专挡那处断裂——正是 f-2248f4yx5 的 Cmd+S 教训：判定测试全绿，删掉注册那
// 一行却没有任何断言会红。
//
// 本仓库组件测试用 renderToStaticMarkup，effect 不跑、发不出 keydown，所以只能读源码断言注册存在（同
// terminal-search.test.ts 的「面板把开关露出来」）。先剥注释——注释里描述规则的文字不是规则本身——再把
// routeWindowShortcut 所在的那个 effect 整段切出来，证明：它在 window 上以 capture 段挂了 keydown、把
// 实时 store 快照喂进了 handler map、命中就 preventDefault、卸载时撤掉监听。壳里除这些转发外没有分支
// （「抽进 lib 只解决一半」的补法：往壳里插一句早退或让它只路由一半，都要红）。
// ---------------------------------------------------------------------------

const appSource = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
// 注释里可能就写着 "window.addEventListener('keydown', ...)" 这类话；先去掉，免得注释假装成注册。
const code = appSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '')

function routerEffect(): string {
  const idx = code.indexOf('routeWindowShortcut(')
  expect(idx, '够不着 routeWindowShortcut 调用——整段路由注册没了').toBeGreaterThan(-1)
  const start = code.lastIndexOf('useEffect(', idx)
  const end = code.indexOf('}, [])', idx)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(idx)
  return code.slice(start, end)
}

describe('App 把窗口快捷键接到唯一的 capture 路由', () => {
  it('routeWindowShortcut 真的被调用，且喂的是实时 store 快照构建的 handler map', () => {
    // getState() 每次按键重新读：漏了它就会拿挂载那一刻的旧 layout 做决定，切了 Tab / 分了屏之后落点错位。
    // windowShortcutHandlers 从实时快照构建，routeWindowShortcut 消费它。
    expect(code).toContain('windowShortcutHandlers(useAppStore.getState()')
    expect(code).toMatch(/routeWindowShortcut\(\s*event,\s*isMac,\s*editableTarget,\s*handlers\s*\)/)
  })

  it('承载它的那个 effect 在 window 上以 capture 段挂 keydown，命中就 preventDefault', () => {
    const effect = routerEffect()
    // 掐掉这行注册（只保留 onKeyDown 定义）——单测里判定/转发仍全绿，这里会红。
    expect(effect).toContain("window.addEventListener('keydown'")
    expect(effect).toContain('{ capture: true }')
    // capture 段是关键：抢在聚焦的 xterm textarea 吞掉击键之前拿到它。命中本层的键必须 preventDefault。
    // （Cmd+W 不落到系统关窗，靠的是主进程换掉了默认菜单，见 main/application-menu.ts——那条保证在主进程
    // 测里守，不在这里。）
    expect(effect).toContain('event.preventDefault()')
    // 且 preventDefault 挂在路由返回真时——不是无条件 preventDefault（那会吞掉所有键）。
    expect(effect).toMatch(/if\s*\(\s*routeWindowShortcut\([\s\S]*?\)\)\s*event\.preventDefault\(\)/)
  })

  it('注册在卸载时被撤掉，不泄漏监听器', () => {
    expect(routerEffect()).toContain("removeEventListener('keydown'")
  })

  it('editableTarget 由 isEditableChordTarget 从 DOM 事实折出，喂给路由做门', () => {
    // 组件测试跑不了 effect，所以这条接线只能读源码钉住：删掉这个守卫，Cmd+D 会在 composer/重命名框里
    // 误分屏、Cmd+W 会关掉正在打字的格，而任何判定测试都不会红。
    const effect = routerEffect()
    expect(effect).toContain('isEditableChordTarget(')
    // 终端焦点必须仍接管——门靠 .xterm 子树判定「在不在终端里」。
    expect(effect).toContain(".closest('.xterm')")
    // 折出的布尔必须真的作为第三个实参喂进路由，否则门是死的。
    expect(effect).toMatch(/const\s+editableTarget\s*=/)
    expect(effect).toContain('editableTarget, handlers')
  })

  it('quick switch 的 toggle 通过 handler map 接进同一个路由，不是另起一个监听器', () => {
    // 收敛的证据：整个 App 只有一处 keydown 注册，quick-switch 走 handler map 而非第二个 effect。
    const effect = routerEffect()
    expect(effect).toContain('toggleQuickSwitch')
    // 全文件只有一处 window keydown capture 注册。两个 → 说明没收敛成单路由。
    const registrations = code.match(/window\.addEventListener\('keydown'/g) ?? []
    expect(registrations.length).toBe(1)
  })

  it('快捷键清单的召唤走同一个 handler map，且面板真的被挂进 App', () => {
    // 「组件触发面可静默失效」的接线侧：判定/渲染的单测再全绿，若 help 的 toggle 没接进路由、或
    // ShortcutsCheatSheet 根本没被 App 渲染，用户按了召唤键什么都不出、菜单又没有加速键，清单就发现不了。
    // toggle 走的是与 quick-switch 同一份 handler map（help.shortcuts 由 windowShortcutHandlers 接），不另起监听。
    expect(routerEffect()).toContain('toggleShortcutsHelp')
    // 面板被挂进渲染树——删掉这一句，effect 层全绿而清单永远不显示。
    expect(code).toContain('<ShortcutsCheatSheet')
    // 且它的开关状态由 App 持有（shortcutsHelpOpen），open 由它驱动，不是恒 false 的死值。
    expect(code).toMatch(/setShortcutsHelpOpen/)
    expect(code).toMatch(/<ShortcutsCheatSheet[\s\S]*?open=\{shortcutsHelpOpen\}/)
  })

  it('onKeyDown 壳里没有任何早退——只有取值、构建 handler、路由这几句转发', () => {
    // 「抽进 lib 只解决一半」的补法：壳里除转发外没有语句。往壳顶插一句 `return` 会让整个路由变 no-op，
    // 而判定/转发的单测全绿。这里钉「onKeyDown 函数体内不含 return」——门是作为实参喂进路由的，壳本身
    // 永远不需要 return，所以壳里出现 return 就是那次 no-op 变异的唯一签名。
    const start = code.indexOf('const onKeyDown = ')
    expect(start).toBeGreaterThan(-1)
    // onKeyDown 定义结束于它被 addEventListener 注册处；这段区间就是壳体。
    const body = code.slice(start, code.indexOf("window.addEventListener('keydown'", start))
    expect(body).not.toMatch(/\breturn\b/)
    // 且壳体确实调用了路由（自证扫到了东西，不是空区间恒过）。
    expect(body).toContain('routeWindowShortcut(')
  })
})
