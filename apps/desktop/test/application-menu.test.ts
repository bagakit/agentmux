import { describe, expect, it } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { applicationMenuTemplate } from '../src/main/application-menu.js'

/**
 * 应用菜单模板的判定层测试。承重事实是：**这份模板绝不含任何会注入「毁灭性原生加速键」的路径**，
 * 同时**保留 Edit 菜单**（终端粘贴走原生 Paste role）。原生加速键在按键进渲染进程之前就被 AppKit
 * 处理，渲染层 preventDefault 拦不住——所以「不注入这些键」是主平台快捷键能按预期工作的唯一前提。
 *
 * 「毁灭性加速键」不是单个键、而是一族——触发即静默丢数据：
 *   - Cmd+W（role 'close'，也被复合 role 'fileMenu' / 'windowMenu' 内部注入）：关闭窗口，丢整个 workbench。
 *   - Cmd+R / Cmd+Shift+R（role 'reload' / 'forceReload'，被复合 role 'viewMenu' 整段注入）：重载
 *     webContents，把未保存的编辑器缓冲一起清空。
 *
 * 关键：这些加速键是 role 在 buildFromTemplate 时**隐式**绑上的，模板对象里根本没有 accelerator
 * 字段，测试又不跑 Electron 运行时（纯函数），所以**无法**从 item.accelerator 观察到 role 注入的键。
 * 因此守卫按「这一族的性质」判，用两个互补的出口覆盖同一个属性「没有 path 注入毁灭性加速键」：
 *   (1) role 拒绝集——curated 的实测知识：哪些 role 会注入这族键（叶子 close/reload/forceReload +
 *       会展开成它们的复合 viewMenu/fileMenu/windowMenu）。这一路抓「有人又用了整段 role」。
 *   (2) 显式加速键正则——抓「有人手工加了一项、直接把 accelerator 写成这族键」的形状。
 * 下方 describe 自检块注入两种事故形状，证明守卫真会红、且对保留项不误判（非恒红）。
 */

function walk(items: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const flat: MenuItemConstructorOptions[] = []
  for (const item of items) {
    flat.push(item)
    if (Array.isArray(item.submenu)) flat.push(...walk(item.submenu))
  }
  return flat
}

// (1) 会隐式注入毁灭性加速键的 role。模板里看不到它们绑的键，只能靠这份实测知识列举「哪些 role 会注入」。
const destructiveRoles = new Set<MenuItemConstructorOptions['role']>([
  'close', // Cmd+W：关闭窗口
  'reload', // Cmd+R：重载 webContents
  'forceReload', // Cmd+Shift+R：强制重载
  'fileMenu', // 复合：展开含 close
  'windowMenu', // 复合：展开含 close
  'viewMenu' // 复合：展开含 reload + forceReload
])

// (2) 显式写在 item 上的毁灭性加速键：Cmd+W（关窗族）、Cmd+R / Cmd+Shift+R（重载族）。
const destructiveAcceleratorKey = (accelerator: string): boolean => {
  const norm = accelerator.replace(/\s/g, '').toLowerCase()
  const mod = '(command|cmd|commandorcontrol|cmdorctrl|control|ctrl)'
  return new RegExp(`^${mod}\\+w$`).test(norm) || new RegExp(`^${mod}\\+(shift\\+)?r$`).test(norm)
}

// 同一个属性的单一判定出口：一条 path 只要命中任一路，就会注入毁灭性加速键。
const injectsDestructiveAccelerator = (item: MenuItemConstructorOptions): boolean =>
  destructiveRoles.has(item.role) ||
  (typeof item.accelerator === 'string' && destructiveAcceleratorKey(item.accelerator))

describe('毁灭性加速键守卫自检——证明守卫有分辨力，不是恒绿也不是恒红', () => {
  it('两种事故形状都被判红：裸 role（viewMenu/reload/forceReload/close）与显式 accelerator（Cmd+W/Cmd+R/Cmd+Shift+R）', () => {
    // 审计现场的两种事故：有人又用了整段 role，或手工加一项直接绑这族键。
    expect(injectsDestructiveAccelerator({ role: 'viewMenu' })).toBe(true)
    expect(injectsDestructiveAccelerator({ role: 'reload' })).toBe(true)
    expect(injectsDestructiveAccelerator({ role: 'forceReload' })).toBe(true)
    expect(injectsDestructiveAccelerator({ role: 'close' })).toBe(true)
    expect(injectsDestructiveAccelerator({ label: 'X', accelerator: 'Cmd+W' })).toBe(true)
    expect(injectsDestructiveAccelerator({ label: 'Reload', accelerator: 'Cmd+R' })).toBe(true)
    expect(injectsDestructiveAccelerator({ label: 'Force Reload', accelerator: 'Cmd+Shift+R' })).toBe(true)
  })

  it('保留的项一个都不误判——若守卫恒真这条会红', () => {
    for (const role of ['resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen', 'toggleDevTools', 'editMenu'] as const) {
      expect(injectsDestructiveAccelerator({ role })).toBe(false)
    }
  })

  it('端到端：把事故形状注入模板后，真正的守卫表达式（filter→toEqual([])）会红', () => {
    // 用与下方守卫**完全相同**的表达式跑事故模板，证明这不是「谓词能分辨、但守卫没连上」。
    // 事故一：有人把裸 viewMenu 加回来（reload/forceReload 的加速键在模板里不可见，只有这条 role 能抓到）。
    const reintroducedViewMenu = walk([{ role: 'editMenu' }, { role: 'viewMenu' }])
    expect(reintroducedViewMenu.filter(injectsDestructiveAccelerator)).not.toEqual([])
    // 事故二：有人手搭 View 菜单时，把某一项的 accelerator 直接写成 Cmd+R。
    const handAddedReload = walk([{ label: 'View', submenu: [{ label: 'Reload', accelerator: 'CmdOrCtrl+R' }] }])
    expect(handAddedReload.filter(injectsDestructiveAccelerator)).not.toEqual([])
    // 反向：当前这份真实模板跑同一表达式必须是空——否则上面的 not.toEqual 只是恒真。
    expect(walk(applicationMenuTemplate(true)).filter(injectsDestructiveAccelerator)).toEqual([])
  })
})

for (const isMac of [true, false]) {
  describe(`applicationMenuTemplate (isMac=${isMac})`, () => {
    const items = walk(applicationMenuTemplate(isMac))

    it('不含 close role——它默认绑 Cmd+W，会抢走关格键位', () => {
      expect(items.some((item) => item.role === 'close')).toBe(false)
    })

    it('不含 fileMenu / windowMenu role——两者内部都会注入一个绑 Cmd+W 的 close', () => {
      expect(items.some((item) => item.role === 'fileMenu')).toBe(false)
      expect(items.some((item) => item.role === 'windowMenu')).toBe(false)
    })

    it('没有任何 path 会注入毁灭性加速键（关窗族 Cmd+W + 重载族 Cmd+R/Cmd+Shift+R，含裸 role 与显式 accelerator 两种形状）', () => {
      // 这条同时守两侧：再用裸 viewMenu（role 注入）或手工绑 Cmd+R（显式 accelerator）都会让 offenders 非空。
      const offenders = items.filter(injectsDestructiveAccelerator)
      expect(offenders).toEqual([])
    })

    it('保留 Edit 菜单——终端粘贴依赖原生 Paste role', () => {
      // 用 editMenu 整段（含 paste）或至少含一个 paste role 都算保住；这里锚在 editMenu role 上，
      // 因为实现就是用它。删掉这行 Edit 菜单，终端就粘贴不了。
      expect(items.some((item) => item.role === 'editMenu')).toBe(true)
    })

    it('仍给出退出口（Quit）——换菜单不能把退出弄没了', () => {
      // mac 的 Quit 在 appMenu 里，非 mac 在手搭的 File 里。两边都必须有一个可达的 quit。
      const hasQuit = items.some((item) => item.role === 'quit')
      const hasAppMenu = items.some((item) => item.role === 'appMenu')
      expect(hasQuit || hasAppMenu).toBe(true)
    })
  })
}
