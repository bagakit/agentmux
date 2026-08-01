import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { WorkspaceLayout } from '../src/renderer/src/lib/workbench-layout.js'
import type { WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import {
  handleWorkbenchShortcut,
  type WorkbenchShortcutEvent,
  type WorkbenchShortcutStore
} from '../src/renderer/src/lib/workbench-shortcuts.js'

// ---------------------------------------------------------------------------
// T-007 的接线层。判定层（workbench-shortcuts.test.ts）证明「哪个键是哪个动作」是对的，但判定
// 再对，没人把它接到窗口监听、没人把命令转发到 store，用户按了照样什么都不发生。这一层专挡那两处
// 断裂——正是 f-2248f4yx5 的 Cmd+S 教训：判定测试全绿，删掉注册那一行却没有任何断言会红。
//
// 分两截：
//  1) App 的窗口注册。本仓库组件测试用 renderToStaticMarkup，effect 不跑、发不出 keydown，所以只能
//     读源码断言注册存在（同 terminal-search.test.ts 的「面板把开关露出来」）。先剥注释——注释里
//     描述规则的文字不是规则本身——再把 handleWorkbenchShortcut 所在的那个 effect 整段切出来，证明
//     它确实在 window 上以 capture 段挂了 keydown、且把实时 store 快照喂了进去。删/掐掉注册这里就红。
//  2) handleWorkbenchShortcut 的转发。判定 → 落点解析 → 调 store action 这条链是纯函数，可以真的跑：
//     喂一个假 store，断言四个动作各自打到了对的 action、带着对的实参。改坏任一条转发分支这里就红。
// ---------------------------------------------------------------------------

describe('App 把 workbench 快捷键接到窗口监听', () => {
  const appSource = readFileSync(
    new URL('../src/renderer/src/App.tsx', import.meta.url),
    'utf8'
  )
  // 注释里可能就写着 "window.addEventListener('keydown', ...)" 这类话；先去掉，免得注释假装成注册。
  const code = appSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')

  it('handleWorkbenchShortcut 真的被调用，且喂的是实时 store 快照而非挂载时的闭包', () => {
    // getState() 每次按键重新读：漏了它就会拿挂载那一刻的旧 layout 做决定，切了 Tab / 分了屏之后
    // 序号与落点全部错位。
    expect(code).toMatch(
      /handleWorkbenchShortcut\(\s*event,\s*isMac,\s*useAppStore\.getState\(\)\s*\)/
    )
  })

  it('承载它的那个 effect 在 window 上以 capture 段挂 keydown，命中就 preventDefault', () => {
    // 锚在调用点（带左括号），而不是同名的 import——两者都叫 handleWorkbenchShortcut。
    const idx = code.indexOf('handleWorkbenchShortcut(')
    // 扫描式断言先自证扫到了东西：够不着这个调用就说明整段注册没了。
    expect(idx).toBeGreaterThan(-1)
    const effectStart = code.lastIndexOf('useEffect(', idx)
    const effectEnd = code.indexOf('}, [])', idx)
    expect(effectStart).toBeGreaterThan(-1)
    expect(effectEnd).toBeGreaterThan(idx)
    const effect = code.slice(effectStart, effectEnd)
    // 掐掉这行注册（只保留 onKeyDown 定义）——单测里判定仍全绿，这里会红。
    expect(effect).toContain("window.addEventListener('keydown'")
    expect(effect).toContain('{ capture: true }')
    // capture 段是关键：抢在聚焦的 xterm textarea 吞掉击键之前拿到它。命中本层的键必须
    // preventDefault，压掉浏览器默认行为。（Cmd+W 不落到系统关窗，靠的是主进程换掉了默认菜单，
    // 见 main/application-menu.ts——那条保证在主进程测里守，不在这里。）
    expect(effect).toContain('event.preventDefault()')
  })

  it('注册在卸载时被撤掉，不泄漏监听器', () => {
    const idx = code.indexOf('handleWorkbenchShortcut(')
    const effectEnd = code.indexOf('}, [])', idx)
    const effect = code.slice(code.lastIndexOf('useEffect(', idx), effectEnd)
    expect(effect).toContain("removeEventListener('keydown'")
  })

  it('在非终端可编辑控件里先放行：effect 把 DOM 事实喂给 isEditableChordTarget 并提前 return', () => {
    // 组件测试跑不了 effect，所以这条接线只能读源码钉住：删掉这个守卫，Cmd+D 会在 composer/重命名框里
    // 误分屏、Cmd+W 会关掉正在打字的格，而任何判定测试都不会红。
    const idx = code.indexOf('handleWorkbenchShortcut(')
    const effect = code.slice(code.lastIndexOf('useEffect(', idx), code.indexOf('}, [])', idx))
    expect(effect).toContain('isEditableChordTarget(')
    // 终端焦点必须仍接管——守卫靠 .xterm 子树判定「在不在终端里」。
    expect(effect).toContain(".closest('.xterm')")
    // 判定为真时提前 return，快捷键这一轮不接管。
    expect(effect).toMatch(/isEditableChordTarget\([\s\S]*?\)\)\s*return/)
  })
})

// --- handleWorkbenchShortcut 的转发：喂假 store，看动作有没有真打到 store action 上 ----------

function event(overrides: Partial<WorkbenchShortcutEvent>): WorkbenchShortcutEvent {
  return { key: 'a', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...overrides }
}

/** 一张有两格的 Tab：左 r2a / 右 r2b，活动在 r2b。分屏、关闭、切焦点都作用在活动格上。 */
function splitTab(id: string): WorkbenchTab {
  return {
    id,
    workspaceId: 'ws',
    titleRegionId: 'r2a',
    layout: {
      root: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', regionId: 'r2a' },
        second: { type: 'leaf', regionId: 'r2b' },
        ratio: 0.5
      },
      activeRegionId: 'r2b'
    },
    regions: {
      r2a: { regionId: 'r2a', kind: 'launcher', workspaceId: 'ws' },
      r2b: { regionId: 'r2b', kind: 'launcher', workspaceId: 'ws' }
    }
  }
}

function leafTab(id: string, regionId: string): WorkbenchTab {
  return {
    id,
    workspaceId: 'ws',
    titleRegionId: regionId,
    layout: { root: { type: 'leaf', regionId }, activeRegionId: regionId },
    regions: { [regionId]: { regionId, kind: 'launcher', workspaceId: 'ws' } }
  }
}

function layout(groupId: string, tabOrder: string[], activeTabId: string | null): WorkspaceLayout {
  return {
    root: { type: 'leaf', groupId },
    groups: [{ id: groupId, tabOrder, activeTabId, recentTabIds: activeTabId ? [activeTabId] : [] }],
    activeGroupId: groupId
  }
}

type Spies = {
  activateTab: ReturnType<typeof vi.fn>
  closeRegion: ReturnType<typeof vi.fn>
  requestCloseTab: ReturnType<typeof vi.fn>
  requestCloseRegion: ReturnType<typeof vi.fn>
  splitRegion: ReturnType<typeof vi.fn>
  focusRegion: ReturnType<typeof vi.fn>
}

// 焦点组 g 有三张 Tab，活动的是 t2（两格，活动格 r2b）。
function store(overrides: Partial<WorkbenchShortcutStore> = {}): WorkbenchShortcutStore & Spies {
  const spies: Spies = {
    activateTab: vi.fn(),
    closeRegion: vi.fn(),
    requestCloseTab: vi.fn(),
    requestCloseRegion: vi.fn(),
    splitRegion: vi.fn(),
    focusRegion: vi.fn()
  }
  return {
    mainSurface: 'workbench',
    activeWorkspaceId: 'ws',
    layouts: { ws: layout('g', ['t1', 't2', 't3'], 't2') },
    tabs: {
      t1: leafTab('t1', 'r1'),
      t2: splitTab('t2'),
      t3: leafTab('t3', 'r3')
    },
    ...spies,
    ...overrides
  }
}

describe('handleWorkbenchShortcut 把命令转发到 store action', () => {
  it('按序号切 Tab：Cmd+1 调 activateTab(焦点组, 第一张)，并吃下这个键', () => {
    const s = store()
    const handled = handleWorkbenchShortcut(event({ key: '1', metaKey: true }), true, s)
    expect(handled).toBe(true)
    expect(s.activateTab).toHaveBeenCalledWith('ws', 'g', 't1')
    // 落点解析在这一层，不该顺手误触别的动作。
    expect(s.closeRegion).not.toHaveBeenCalled()
    expect(s.splitRegion).not.toHaveBeenCalled()
    expect(s.focusRegion).not.toHaveBeenCalled()
  })

  it('关闭当前 Region：Cmd+W 在多格 Tab 上投 requestCloseRegion(活动格)，绝不裸调 closeRegion', () => {
    // 活动 Tab t2 有两格、活动在 r2b。裸调 closeRegion 没有脏检查、会静默弃掉那一格未保存的编辑器改动；
    // 鼠标点这一格的 X 会先弹「未保存确认」。同一个「关这一格」只能有一个决定出口，所以键盘也投意图。
    // 把实现改回 `void store.closeRegion(...)`（只接了一侧出口），这里立刻红。
    const s = store()
    expect(handleWorkbenchShortcut(event({ key: 'w', metaKey: true }), true, s)).toBe(true)
    expect(s.requestCloseRegion).toHaveBeenCalledWith('ws', 't2', 'r2b')
    expect(s.closeRegion).not.toHaveBeenCalled()
  })

  it('关整张 Tab：Cmd+W 在单 Region Tab 上调 requestCloseTab（交给组件确认流），不空调 closeRegion', () => {
    // 把活动 Tab 换成单格：这是最常见的状态，也是「关不掉」的常见现场。必须投 requestCloseTab
    // （带组 id），而不是调 closeRegion——后者在只剩一格时静默不动，键却被吞。
    const s = store({
      tabs: {
        t1: leafTab('t1', 'r1'),
        t2: leafTab('t2', 'r2'),
        t3: leafTab('t3', 'r3')
      }
    })
    expect(handleWorkbenchShortcut(event({ key: 'w', metaKey: true }), true, s)).toBe(true)
    expect(s.requestCloseTab).toHaveBeenCalledWith('ws', 'g', 't2')
    expect(s.closeRegion).not.toHaveBeenCalled()
  })

  it('分屏：Cmd+D 调 splitRegion(活动格, right)，方向原样带过去', () => {
    const s = store()
    expect(handleWorkbenchShortcut(event({ key: 'd', metaKey: true }), true, s)).toBe(true)
    expect(s.splitRegion).toHaveBeenCalledWith('ws', 't2', 'r2b', 'right')
  })

  it('切换焦点格：Cmd+Alt+Left 调 focusRegion(几何上左边那一格)', () => {
    // 活动在右格 r2b，向左应落到 r2a——证明用了几何相邻，而不是别的落点。
    const s = store()
    expect(handleWorkbenchShortcut(event({ key: 'ArrowLeft', metaKey: true, altKey: true }), true, s))
      .toBe(true)
    expect(s.focusRegion).toHaveBeenCalledWith('ws', 't2', 'r2a')
  })

  it('已在边缘、方向上没有相邻格时不动焦点、也不吃这个键', () => {
    // 活动格已是左格 r2a，再向左没有邻居：既不调 focusRegion，也返回 false（让别处有机会处理）。
    const s = store({
      tabs: {
        t1: leafTab('t1', 'r1'),
        t2: { ...splitTab('t2'), layout: { ...splitTab('t2').layout, activeRegionId: 'r2a' } },
        t3: leafTab('t3', 'r3')
      }
    })
    expect(handleWorkbenchShortcut(event({ key: 'ArrowLeft', metaKey: true, altKey: true }), true, s))
      .toBe(false)
    expect(s.focusRegion).not.toHaveBeenCalled()
  })

  it('不在 Workbench 主面（比如 Board）时一律不接管，原样放行', () => {
    const s = store({ mainSurface: 'board' })
    expect(handleWorkbenchShortcut(event({ key: 'w', metaKey: true }), true, s)).toBe(false)
    expect(s.closeRegion).not.toHaveBeenCalled()
  })

  it('没有活动 Workspace 时任何键都解析不出落点，返回 false', () => {
    const s = store({ activeWorkspaceId: null, layouts: {} })
    expect(handleWorkbenchShortcut(event({ key: '1', metaKey: true }), true, s)).toBe(false)
    expect(s.activateTab).not.toHaveBeenCalled()
  })

  it('越界序号当没按：Cmd+5（只有三张）不调 activateTab，返回 false', () => {
    const s = store()
    expect(handleWorkbenchShortcut(event({ key: '5', metaKey: true }), true, s)).toBe(false)
    expect(s.activateTab).not.toHaveBeenCalled()
  })

  it('不是本层的键（无主修饰键）原样放行，四个 action 都不碰', () => {
    const s = store()
    expect(handleWorkbenchShortcut(event({ key: 'w' }), true, s)).toBe(false)
    expect(s.activateTab).not.toHaveBeenCalled()
    expect(s.closeRegion).not.toHaveBeenCalled()
    expect(s.splitRegion).not.toHaveBeenCalled()
    expect(s.focusRegion).not.toHaveBeenCalled()
  })
})
