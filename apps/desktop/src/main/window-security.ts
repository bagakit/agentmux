// 主窗口的安全隔离取值 + 弹窗判据。抽成可 import 的纯模块，是因为 index.ts 一 import 就跑 Electron
// app 的副作用（顶层 crashReporter.start / app.setPath / requestSingleInstanceLock），任何测试都无法
// import 它——于是这些取值此前只能靠源码文本扫描来守。实测过那条路失效：把四个隔离开关全部取反、加
// webSecurity:false、并把 setWindowOpenHandler 从 deny 翻成 allow，9 个碰 index.ts 的测试 98/98 全绿、
// tsc 退 0（webPreferences 是很宽的可选类型，tsc 看不出取值变了）。
//
// 这个文件**必须保持纯**：不 import electron、无模块级副作用。preload 路径依赖 index.ts 侧的
// import.meta.dirname，所以由调用方传进来，取值判据本身不碰文件系统。接线（真的把它喂进 BrowserWindow、
// 真的在 setWindowOpenHandler 里用这个判定）由 window-security.test.ts 的 AST 接线守卫钉住。

/**
 * 主窗口 webPreferences 的安全部分。字段类型刻意用 `boolean` 而不是字面量 `true`/`false`——这是为了
 * **忠实复现事故形状**：生产里这些键就是宽类型，tsc 拦不住取反，唯一的判据是行为测试直接质询取值。
 *
 * 每个开关都对应一个具体威胁：
 * - `contextIsolation: true`：renderer 的 JS 世界与 preload/Electron 内部隔离。设成 false，页面脚本能
 *   直接改写 preload 暴露的对象原型、拿到 Node 原语，特权桥彻底失守。
 * - `sandbox: true`：renderer 进程跑在 OS 沙箱里，即使被 XSS 也拿不到文件系统/进程能力。设成 false，
 *   一次 renderer 侧 RCE 就等于主机级 RCE。
 * - `nodeIntegration: false`：页面里没有 `require`/`process`/`Buffer`。设成 true，任何注入脚本直接
 *   `require('child_process').exec(...)`。
 * - `preload`：那座受控的特权桥入口本身。
 *
 * `webSecurity` 刻意不出现在这里（默认即 true）：它是最容易被静默塞成 false 的键（本仓 src/ 与 test/ 下
 * 曾 0 命中，等于没人盯），所以它的判据在测试里单独钉——要么缺席、要么为 true，绝不为 false。
 */
export interface WindowSecurityWebPreferences {
  readonly preload: string
  readonly contextIsolation: boolean
  readonly sandbox: boolean
  readonly nodeIntegration: boolean
  readonly webSecurity?: boolean
}

/**
 * 造主窗口的安全 webPreferences。调用方（index.ts）只负责把 preload 的绝对路径传进来（那依赖
 * import.meta.dirname，不能落在这个纯文件里）。返回的对象**就是** BrowserWindow 要用的那份取值——
 * index.ts 不许另手抄一份对象字面量（接线守卫会红）。
 */
export function windowSecurityWebPreferences(preloadPath: string): WindowSecurityWebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false
  }
}

/**
 * 一次「窗口想开新窗口/弹窗」的判定。现状：只有 `https://` 目标交给系统浏览器（shell.openExternal），
 * 且**一律不在应用内开新窗口**（action: 'deny'）。
 *
 * 把判定搬成纯函数，index.ts 的 setWindowOpenHandler 只剩副作用（真的调 shell.openExternal）。这样
 * 「一律 deny」这条判据能被单元测试直接质询——留在 Electron 回调里就只能扫文本，而文本扫描看不见
 * 把 deny 翻成 allow 的取反（本仓吃过这个亏）。
 */
export interface WindowOpenDecision {
  /** 是否允许在应用内开这个新窗口。现状恒为 'deny'：应用不开子窗口。 */
  readonly action: 'allow' | 'deny'
  /** 是否把这个 URL 交给系统默认浏览器打开。仅 https:// 为真。 */
  readonly openExternally: boolean
}

export function windowOpenDecision(url: string): WindowOpenDecision {
  return {
    action: 'deny',
    openExternally: url.startsWith('https://')
  }
}
