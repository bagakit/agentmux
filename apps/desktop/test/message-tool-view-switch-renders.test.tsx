// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AgentComposerTools } from '../src/renderer/src/components/AgentComposerTools.js'

/**
 * Agent 视图切换（Terminal ⇄ Activity）真的渲染在 Message Tool 里，且真的会切。
 *
 * 病史（2026-09-25）：`message-tool-view-switch.test.tsx` 三条断言全是
 * `expect(tools).toContain('composer-tool-view-switch')` 这种**读源码文本**。实测变异：把渲染条件
 * 改成 `{false && viewMode && onViewModeChange ? …}`——切换键从此永不出现，而那两个测试
 * **32 条全绿**。源码里的字符串还在，`toContain` 照旧为真（本仓记过
 * class-name-present-but-nothing-selects-it 同族）。
 *
 * 所以这份判据渲染组件、查真 DOM、点真按钮。它守四件事：
 *   1. 切换键在场（渲染出来的，不是源码里写着）；
 *   2. 两个方向都切对——只测一个方向会放过"恒定切到某一个视图"；
 *   3. 无障碍名随当前视图变，说的是**要去哪**而不是**现在在哪**；
 *   4. Composer 被禁用时它照样点得动——看哪个视图和能不能发是两件事。
 *
 * 判据走 `querySelector` 不走字符串切片：这一行工具键里每一个兄弟都带
 * `<span className="composer-tool__label">`，一旦切换键也加上标签，
 * `markup.indexOf('</span>')` 就会提前截断，切出来的那段越短、`not.toContain` 越容易恒真
 * （本仓记过 indexof-anchor-gone-slices-to-empty-string）。DOM 没有这个面。
 */

const BASE = {
  disabled: false,
  commands: [],
  loadSkills: async () => [],
  onChooseSkill: vi.fn(),
  onCommand: vi.fn(),
  runAction: async (action: () => void | Promise<void>) => { await action() }
}

type Mounted = { toggle: HTMLButtonElement | null; host: HTMLElement; unmount: () => Promise<void> }

async function mount(props: Record<string, unknown>): Promise<Mounted> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(createElement(AgentComposerTools, { ...BASE, ...props } as never)))
  return {
    toggle: host.querySelector<HTMLButtonElement>('.composer-tool--view-toggle'),
    host,
    unmount: async () => { await act(async () => root.unmount()); host.remove() }
  }
}

describe('Message Tool 里的 Agent 视图切换', () => {
  // 不给这个标志，`act()` 只打一行 stderr 警告就放行——更新会在断言之后才刷进 DOM，
  // 于是"点了没反应"这种缺陷读起来像通过。与 hover-dropdown-menu.test.tsx 同一套路。
  beforeAll(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
  afterEach(() => { document.body.replaceChildren() })

  it('切换键真的渲染出来——两种视图下都在', async () => {
    for (const viewMode of ['terminal', 'activity'] as const) {
      const view = await mount({ viewMode, onViewModeChange: vi.fn() })
      expect(
        view.toggle,
        `viewMode=${viewMode} 时切换键没有渲染。源码里有那个类名不等于它出现在 DOM 里——` +
          '把渲染条件改成恒假，读源码的断言照样全绿（2026-09-25 实测）'
      ).not.toBeNull()
      await view.unmount()
    }
  })

  it('无障碍名说的是"要去哪"，且两种视图下不同', async () => {
    const fromTerminal = await mount({ viewMode: 'terminal', onViewModeChange: vi.fn() })
    const fromActivity = await mount({ viewMode: 'activity', onViewModeChange: vi.fn() })
    // 钉在这个按钮自己的属性上，不在整段 HTML 里找子串：邻座工具的文案不会混进来。
    expect(fromTerminal.toggle?.getAttribute('aria-label'), '在 Terminal 视图时，这个键该通往 Activity')
      .toBe('Show Activity')
    expect(fromActivity.toggle?.getAttribute('aria-label'), '在 Activity 视图时，这个键该通往 Terminal')
      .toBe('Show Terminal')
    // 悬停提示与无障碍名必须是同一句：读屏听到的和看见的不该是两回事。
    expect(fromTerminal.toggle?.getAttribute('title')).toBe('Show Activity')
    expect(fromActivity.toggle?.getAttribute('title')).toBe('Show Terminal')
    await fromTerminal.unmount()
    await fromActivity.unmount()
  })

  it('点下去真的切，且两个方向都切对', async () => {
    // 真的挂进 DOM 再真的 click()，不绕过控件直接调 handler：组件带 hooks，当函数调会在
    // `useState` 上抛；而绕过按钮直接调回调，会在"按钮 disabled / 没接上 onClick"时照样绿。
    for (const [viewMode, expected] of [['terminal', 'activity'], ['activity', 'terminal']] as const) {
      const onViewModeChange = vi.fn()
      const view = await mount({ viewMode, onViewModeChange })
      expect(view.toggle, `viewMode=${viewMode}：切换键没挂进 DOM，这条判据在空转`).not.toBeNull()

      await act(async () => view.toggle!.click())
      expect(onViewModeChange, `viewMode=${viewMode} 时点击没有调用 onViewModeChange`).toHaveBeenCalledTimes(1)
      expect(
        onViewModeChange,
        `从 ${viewMode} 点下去应该切到 ${expected}。只测一个方向会放过"恒定切到某一个视图"`
      ).toHaveBeenCalledWith(expected)
      await view.unmount()
    }
  })

  it('Composer 被禁用时，视图切换照样点得动', async () => {
    // `disabled` 说的是"现在不能发"，不是"现在不能看"。Agent 正在生成时用户最需要的恰恰是
    // 翻到 Terminal 看它在干什么——把这个键一起禁掉，人就被关在门外了。
    // 判据必须喂 `disabled: true`：喂 false 时就算有人给它接上 `disabled={disabled}`，
    // 按钮的 disabled 仍是 false，断言照样绿——那就成了一条什么都不记的恒真断言。
    const onViewModeChange = vi.fn()
    const view = await mount({ disabled: true, viewMode: 'terminal', onViewModeChange })
    expect(view.toggle, 'Composer 禁用时切换键整个消失了——看哪个视图不该跟着发送权限走').not.toBeNull()
    expect(view.toggle!.disabled, 'Composer 禁用时切换键也被禁了：Agent 正在跑时反而翻不到 Terminal').toBe(false)

    await act(async () => view.toggle!.click())
    expect(onViewModeChange, 'Composer 禁用时点击没有生效').toHaveBeenCalledWith('activity')
    await view.unmount()
  })
})
