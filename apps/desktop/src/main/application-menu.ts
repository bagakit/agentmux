import type { MenuItemConstructorOptions } from 'electron'

/**
 * 应用菜单模板——纯函数，不碰 Electron 运行时（测试环境跑不起 app/Menu）。index.ts 只做
 * `Menu.buildFromTemplate` + `Menu.setApplicationMenu` 的接线。
 *
 * 为什么要自建、而不是沿用 Electron 默认菜单：默认菜单里有若干 role 会绑上**原生加速键**，而原生
 * 加速键由 AppKit 在按键进入 webContents 之前就处理掉，渲染进程 keydown 的 event.preventDefault()
 * 取消不了它。其中有一族加速键会造成**静默数据丢失**，必须从菜单里挖掉——注意是一族、不止 Cmd+W：
 *
 *   - Cmd+W（role 'close'，也被 'fileMenu' / 'windowMenu' 内部注入）：默认「关闭窗口」，会丢掉整个
 *     workbench。而 Cmd+W 正是 Workbench「关闭当前 Region」的主键位——不挖掉，系统会抢走去关整窗。
 *   - Cmd+R / Cmd+Shift+R（role 'reload' / 'forceReload'，被 'viewMenu' 整段注入）：重载整个
 *     webContents，把渲染层连同**所有未保存的编辑器缓冲**一起重建回落盘内容。实测：脏 buffer 不在
 *     persist 白名单里（那里只存 layout/topology/preferences），reload 后全部归零，且没有任何确认
 *     对话框。浏览器肌肉记忆下 Cmd+R 比 Cmd+W 还更容易误触。
 *
 * 两族的共同点：加速键是 role 在 buildFromTemplate 时**隐式**绑上的，模板对象里根本看不到
 * accelerator 字段（所以也没法靠改 accelerator 来拦）。唯一的办法是**根本不用**这些会注入它的
 * role——把 fileMenu / windowMenu / viewMenu 换成手搭的、只含安全项的等价物，把这些键让回渲染层。
 *
 * 但不能把菜单整个删掉（`setApplicationMenu(null)`）：终端粘贴走的是原生 Edit→Paste role（见
 * TerminalView 的粘贴注释——渲染层故意不接管 Cmd/Ctrl+V，靠原生 Paste 落到 xterm 的 textarea）。删掉
 * Edit 菜单，终端就粘贴不了。所以只保留 appMenu / editMenu 这两段不含危险加速键的整段 role，其余手搭。
 */
export function applicationMenuTemplate(isMac: boolean): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = []
  // appMenu 自带 Quit（Cmd+Q），不含 Cmd+W；mac 上有了它就不需要单独的 File 菜单——默认 File 菜单在
  // mac 上几乎只剩「Close Window」这一个 Cmd+W 项，正是要避开的东西，干脆整段不要。
  if (isMac) template.push({ role: 'appMenu' })
  // 非 mac 的 Quit 没处放，手搭一个只含 Quit 的 File 菜单。不用 role 'fileMenu'：它在部分平台会带
  // close，等于把 Cmd+W 又请回来。
  else template.push({ label: 'File', submenu: [{ role: 'quit' }] })
  // Edit 整段保留：粘贴是承重能力（终端的原生粘贴路径依赖这里的 Paste role）。此段不含危险加速键。
  template.push({ role: 'editMenu' })
  // View 手搭：默认的 role 'viewMenu' 会整段注入 reload（Cmd+R）/ forceReload（Cmd+Shift+R），它们重载
  // webContents 会连同未保存的编辑器缓冲一起清空（见文件头）。只留不重载页面的项：缩放、全屏、DevTools。
  // toggleDevTools 不属于危险那族——它只开关 devtools 面板，不重载页面、不动编辑器状态。
  template.push({
    label: 'View',
    submenu: [
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { role: 'toggleDevTools' }
    ]
  })
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
