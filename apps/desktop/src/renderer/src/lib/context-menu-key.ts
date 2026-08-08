/**
 * 「这个按键该不该打开右键菜单」——一个决定，多个消费者。
 *
 * 平台通行的两种拼法：
 *   - `ContextMenu`（多数 PC 键盘上那颗 Menu / Application 键；mac 上通常根本没有这颗键）；
 *   - `Shift+F10`（跨平台通行的那个，mac 上实际靠它进右键菜单）。
 * 两者都不带其它修饰键——单独的 `F10` 是别的东西（部分系统的窗口聚焦、Fn 组合），所以 F10 那一支
 * 必须要求 Shift 且排除 Alt / Ctrl / Meta，否则会把无关的 F10 组合误当成开菜单。
 *
 * 这条判据本身与「是哪个部件的菜单」无关：文件树、Region 右键菜单问的是同一句话。收成一处，避免
 * 各处各抄一份、在「要不要认某个新拼法」时静默漂移（本仓反复栽在重复规则上）。`file-explorer-move`
 * 里的 `isFileExplorerMenuKey` 保留自己的名字（它的 foundations 测试按那个名字钉着）与签名，实现
 * 委托到这里——两者只有一个真相，drift 由「两函数逐事件同答」那条守卫钉住。
 */
export function opensContextMenuFromKeyboard(event: {
  key: string
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}): boolean {
  if (event.key === 'ContextMenu') return true
  return event.key === 'F10' && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
}
