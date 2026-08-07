// 主窗口顶帧的导航闸：只允许「留在应用自己的文档里」，拦下一切离开应用来源的导航。
//
// 为什么需要它：主窗口的 preload 会把特权桥 `agentmux`（files.read/write/create/move/delete、
// ui.openExternal/savePastedImage、整套 git/gh、workspaces、会话控制）无条件挂到 window 上
// （src/preload/index.ts:238 的 contextBridge.exposeInMainWorld），而 preload 会在**每次导航后重新
// 执行**。应用自己的 CSP 只是 index.html 里的一个 <meta>，不会跟着导航附到别的文档上。于是只要顶帧
// 被导航到一个应用之外的文档（Chromium 默认把「往顶帧拖入一个文件」变成一次 file:/// 导航），那个
// 文档就继承了这座桥、且没有 CSP —— 等于拿到对文件系统/git/shell 的脚本级访问。这个闸就是那道
// 「顶帧不许离开应用来源」的判据。
//
// 这个函数**只做判定、不接线**：接线（在 webContents 上挂 will-navigate 并对被拒目标 preventDefault）
// 落在 index.ts 的建窗处。把判据抽成可 import 的纯函数，是因为本仓反复吃过的亏——判据留在 Electron
// 调用点里就只能靠扫源码文本来守，而文本扫描看不见提前返回、也看不见取反的分支（见记忆
// grep-guard-cannot-see-early-return / guard-must-check-reachability-not-presence）。抽出来后，
// 判据本身由单元测试直接质询，接线层另用一条接线守卫钉住「被拒真的 preventDefault 了」。

/**
 * 计算主窗口顶帧的「应用来源」判据所依据的形状。
 *
 * 关键在于 dev 与 prod 的「来源」根本不是同一种东西，且**必须从窗口实际加载内容的同一处派生**，
 * 不能两头手抄一个 URL（本仓被两个该联动却各自手抄的常量坑过不止一次）：
 *
 * - **dev**：窗口 `loadURL(process.env.ELECTRON_RENDERER_URL)`，那是一个 Vite dev server 的 http(s)
 *   URL（如 http://localhost:5173）。此时「同源」是 URL origin 相等——HMR/热更都在这个 origin 内跳转，
 *   必须放行，否则 dev 直接废掉。
 * - **prod**：窗口 `loadFile(.../renderer/index.html)`，那是一个 file:// 文档。**这里有个致命陷阱**：
 *   所有 file:// URL 的 `origin` 都序列化成字符串 "null"（实测：file:///任意路径 的 origin 都是 "null"）。
 *   若 prod 也按 origin 相等来判，`file:///tmp/evil.html` 的 origin 同样是 "null"，会被判成「同源」而放行——
 *   那正是要防的洞。所以 prod 下不能比 origin，必须比 file 的**规范化路径**：只有指向被打包的那个
 *   renderer 文档（忽略 query/hash，资源探针会带 ?agentmux-file-editing-report=1 之类）才算「留在应用里」。
 */
export type TopFrameOrigin =
  | { readonly mode: 'dev'; readonly origin: string }
  | { readonly mode: 'prod'; readonly filePath: string }

/**
 * 从「窗口实际用来加载内容的东西」派生出应用来源。传入的两个值就是 index.ts 建窗时用的同两处：
 * dev 传 `process.env.ELECTRON_RENDERER_URL`，prod 传 `loadFile` 的那个 index.html 绝对路径。二选一，
 * dev 优先（与 index.ts 里 `if (ELECTRON_RENDERER_URL) loadURL else loadFile` 的分支同构）。
 *
 * dev URL 取其 origin 作为判据锚点；这里做一次显式解析，畸形的 dev URL 直接抛，而不是悄悄退化成一个
 * 谁都不匹配（或谁都匹配）的锚点。
 */
export function topFrameOrigin(input: {
  rendererDevServerUrl: string | undefined
  packagedRendererFilePath: string
}): TopFrameOrigin {
  const dev = input.rendererDevServerUrl
  if (dev !== undefined && dev !== '') {
    return { mode: 'dev', origin: new URL(dev).origin }
  }
  return { mode: 'prod', filePath: input.packagedRendererFilePath }
}

/**
 * 顶帧是否允许导航到 `targetUrl`。这是那道闸的全部判据——被它拒的，接线层必须 preventDefault。
 *
 * 规则（每一条都对应一个真实威胁，不是凑数）：
 * - dev：仅当 `targetUrl` 的 origin 与 dev server origin 逐字相等时放行。跨站 https、file:// 一律拒。
 * - prod：仅当 `targetUrl` 是 file:// 且其**路径**规范化后等于被打包 renderer 文档的路径时放行
 *   （忽略 query/hash）。任何 http(s)、任何指向别的 file 路径（如拖入的 /tmp/evil.html）一律拒。
 * - 无法解析成 URL 的（畸形串）：拒。宁可错杀一个畸形导航，也不放过。
 *
 * 这个闸**不**处理的（诚实说明其边界）：它只管顶帧的 will-navigate/will-redirect。新窗口/popup 由
 * `webContents.setWindowOpenHandler`（index.ts:152，一律 deny 并把 https 交给系统浏览器）另行覆盖，
 * 不在这里重复。它也不给被放行的文档补 CSP——CSP 是另一层，这道闸买的只是「顶帧文档始终是应用自己
 * 那一个」，从而 preload 那座桥永远只落在受 <meta> CSP 约束的应用文档上。
 */
export function isAllowedTopFrameNavigation(appOrigin: TopFrameOrigin, targetUrl: string): boolean {
  let target: URL
  try {
    target = new URL(targetUrl)
  } catch {
    // 连 URL 都解析不出来（畸形串、about:blank 之外的空壳等）——顶帧没有理由去那里。
    return false
  }
  if (appOrigin.mode === 'dev') {
    // origin 逐字相等。about:blank、file://、javascript: 的 origin 都是 "null"，与一个 http origin 不等，
    // 自然被拒；带凭据的 http://user:pass@host 的 origin 会剥掉凭据，与裸 origin 相等——这是符合预期的，
    // 凭据不改变来源。host 大小写：URL 解析已把 host 归一为小写，故 LOCALHOST 与 localhost 同源。
    return target.origin === appOrigin.origin
  }
  // prod：必须是 file:// 且路径指向被打包的 renderer 文档本身。绝不能比 origin——file 的 origin 恒为
  // "null"，比 origin 会把任意拖入的 file:///tmp/evil.html 判成同源放行（这正是本模块要堵的洞）。
  if (target.protocol !== 'file:') return false
  // 路径可能被 percent-encode（打包路径里有空格等），解码后再逐字比对被打包文档的绝对路径。畸形的
  // percent 序列会让 decodeURIComponent 抛——那种目标同样拒，绝不因解码失败而放行。
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(target.pathname)
  } catch {
    return false
  }
  return decodedPath === appOrigin.filePath
}

/** will-navigate / will-redirect 事件里本判据用得到的最小形状（Electron 的 Event 是它的超集）。 */
export type TopFrameNavigationEvent = {
  readonly url: string
  readonly isMainFrame: boolean
  preventDefault(): void
}

/**
 * 造一个 will-navigate / will-redirect 处理器：顶帧导航到应用来源之外时 `preventDefault()` 掐死它。
 *
 * 把处理器体做成可 import 的工厂而不是留在 index.ts 的建窗闭包里，是为了让「被拒真的 preventDefault 了」
 * 这条判据能被单元测试**直接执行**质询——本仓的教训是留在 Electron 调用点里就只能扫源码文本，而文本
 * 扫描看不见提前返回、也看不见取反的分支（记忆 grep-guard-cannot-see-early-return）。index.ts 那边的
 * 接线守卫只需再钉住「这个工厂产出的处理器确实挂到了 webContents 的两个事件上」。
 *
 * 只作用于顶帧：子帧导航不触及顶帧那座特权桥，且拖文件触发的是顶帧导航。
 */
export function topFrameNavigationGuard(
  appOrigin: TopFrameOrigin
): (event: TopFrameNavigationEvent) => void {
  return (event) => {
    if (!event.isMainFrame) return
    if (!isAllowedTopFrameNavigation(appOrigin, event.url)) event.preventDefault()
  }
}
