import type { MenuItemConstructorOptions } from 'electron'

/**
 * 应用菜单模板——纯函数，不碰 Electron 运行时（测试环境跑不起 app/Menu）。index.ts 只做
 * `Menu.buildFromTemplate` + `Menu.setApplicationMenu` 的接线。
 *
 * 为什么要自建、而不是沿用 Electron 默认菜单：默认菜单在 macOS 上把「关闭窗口」绑到 Cmd+W
 * （File / Window 里的 role 'close'）。而 Cmd+W 正是 Workbench「关闭当前 Region」的主键位。原生菜单
 * 加速键由 AppKit 在按键进入 webContents 之前就处理掉，渲染进程 keydown 的 event.preventDefault()
 * 取消不了它——不换菜单，用户按 Cmd+W 想关一格，系统会抢走去关掉整个窗口（丢掉整个 workbench，
 * 带数据丢失）。所以这里显式建一份**不含任何会绑 Cmd+W 的 role**（'close' / 'fileMenu' / 'windowMenu'
 * 都会注入它）的菜单，把 Cmd+W 让回渲染层。
 *
 * 但不能把菜单整个删掉（`setApplicationMenu(null)`）：终端粘贴走的是原生 Edit→Paste role（见
 * TerminalView 的粘贴注释——渲染层故意不接管 Cmd/Ctrl+V，靠原生 Paste 落到 xterm 的 textarea）。删掉
 * Edit 菜单，终端就粘贴不了。所以保留 appMenu/editMenu/viewMenu 这些不含 Cmd+W 的整段 role，只把会
 * 注入 Cmd+W 的 fileMenu/windowMenu 换成手搭的、不含 close 的等价物。
 */
export function applicationMenuTemplate(isMac: boolean): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = []
  // appMenu 自带 Quit（Cmd+Q），不含 Cmd+W；mac 上有了它就不需要单独的 File 菜单——默认 File 菜单在
  // mac 上几乎只剩「Close Window」这一个 Cmd+W 项，正是要避开的东西，干脆整段不要。
  if (isMac) template.push({ role: 'appMenu' })
  // 非 mac 的 Quit 没处放，手搭一个只含 Quit 的 File 菜单。不用 role 'fileMenu'：它在部分平台会带
  // close，等于把 Cmd+W 又请回来。
  else template.push({ label: 'File', submenu: [{ role: 'quit' }] })
  // Edit 整段保留：粘贴是承重能力（终端的原生粘贴路径依赖这里的 Paste role）。此段不含 Cmd+W。
  template.push({ role: 'editMenu' })
  template.push({ role: 'viewMenu' })
  // Window 手搭：默认的 role 'windowMenu' 会带一个绑 Cmd+W 的 Close——正是要避开的键。只留最小化/缩放
  // （mac 再加 Bring All to Front），一个 close 都不放。
  template.push({
    label: 'Window',
    submenu: isMac
      ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
      : [{ role: 'minimize' }, { role: 'zoom' }]
  })
  return template
}
