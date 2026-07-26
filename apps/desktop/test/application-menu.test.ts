import { describe, expect, it } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { applicationMenuTemplate } from '../src/main/application-menu.js'

/**
 * 应用菜单模板的判定层测试。承重事实是：**这份模板绝不含任何会把 Cmd+W 绑到「关闭窗口」的菜单**，
 * 同时**保留 Edit 菜单**（终端粘贴走原生 Paste role）。默认 Electron 菜单会绑 Cmd+W，而原生加速键在
 * 按键进渲染进程之前就被处理，渲染层 preventDefault 拦不住——所以这条「不绑 Cmd+W」是主平台
 * Cmd+W 关格能工作的唯一前提。
 *
 * 会注入 Cmd+W 的 role 有三个：'close'（默认加速键 Cmd+W）、'fileMenu' 和 'windowMenu'（两者内部都
 * 含一个 close 项）。这里逐个断言它们都不出现，并且没有任何 item 自己把 accelerator 设成 Cmd+W。
 */

function walk(items: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const flat: MenuItemConstructorOptions[] = []
  for (const item of items) {
    flat.push(item)
    if (Array.isArray(item.submenu)) flat.push(...walk(item.submenu))
  }
  return flat
}

const cmdWLike = (accelerator: string): boolean =>
  /^(command|cmd|commandorcontrol|cmdorctrl|control|ctrl)\+w$/i.test(accelerator.replace(/\s/g, ''))

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

    it('没有任何 item 把 accelerator 显式设成 Cmd+W / Ctrl+W', () => {
      const offenders = items.filter(
        (item) => typeof item.accelerator === 'string' && cmdWLike(item.accelerator)
      )
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
