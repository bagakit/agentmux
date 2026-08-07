// 阻断「往窗口里拖入文件」触发的原生导航。
//
// Chromium 的默认行为：把一个文件拖放到帧上，帧会导航到那个文件的 file:/// URL。对主窗口顶帧而言这是
// 一条真实的提权路径——顶帧文档继承 preload 挂上的特权桥 `agentmux`（src/preload/index.ts:238），而拖入
// 的恶意 .html 一旦成为顶帧文档就拿到了整座桥、且不受应用 <meta> CSP 约束。
//
// 为什么在渲染层也拦一道（而不是只靠主进程的 will-navigate 闸）：
// - will-navigate 闸（src/main/index.ts 建窗处）是**权威后盾**——任何真的发起的顶帧导航，只要离开应用
//   来源就被 preventDefault 掐死。它一定兜得住这次拖放导航。
// - 但「拖放→导航」是浏览器的默认动作，最干净的做法是让它**根本不发起**：在 dragover/drop 上 preventDefault，
//   浏览器就不会尝试那次 file:/// 导航。这既省掉一次无谓的导航尝试，也是 Electron 安全实践的规范做法，
//   并对「某些 Chromium 版本把拖放导航走了不触发 will-navigate 的路径」这种未知形状多一层纵深。
//   两道一起 = 「不发起」+「就算发起也拦下」。
//
// 为什么这道全局拦截**不会**打断应用内既有的拖拽：应用内所有拖拽都走 @dnd-kit 的 PointerSensor，那是基于
// pointer 事件（pointerdown/pointermove）的合成拖拽，**不产生原生 HTML5 DragEvent**，也不读 dataTransfer。
// 渲染层此前没有任何 native dragover/drop/dataTransfer 监听（已核实）。所以在 window 上无条件 preventDefault
// 原生 dragover/drop，掐掉的只有「从 OS 拖文件进来」这一种，碰不到 @dnd-kit 的文件树/工作台拖拽。

// 只用到 window 的这两个方法，不依赖整个 Window 类型，方便测试传入最小替身。
export type FileDropGuardHost = Pick<Window, 'addEventListener' | 'removeEventListener'>

/**
 * 在宿主上安装原生拖放拦截：dragover 与 drop 都 preventDefault，阻止浏览器把拖入的文件变成一次顶帧导航。
 *
 * 返回自己的 disposer——监听器归安装者所有，测试（或将来的拆卸路径）可以移除它而不泄漏全局监听。
 *
 * 两个事件都要拦：光拦 drop 不拦 dragover，浏览器不会把该元素当作放置目标，drop 事件可能根本不派发到这里；
 * 拦了 dragover 才让 drop 真正落到我们手里被 preventDefault。这是 HTML5 拖放规范里成对的一步。
 */
export function installFileDropGuard(host: FileDropGuardHost): () => void {
  const preventNavigation = (event: Event): void => {
    event.preventDefault()
  }
  host.addEventListener('dragover', preventNavigation)
  host.addEventListener('drop', preventNavigation)
  return () => {
    host.removeEventListener('dragover', preventNavigation)
    host.removeEventListener('drop', preventNavigation)
  }
}
