// 渲染层唯一的「这台机器是什么平台」取值处，以及每条随平台变化的文案。
//
// 建它之前，`navigator.userAgent.includes('Mac')` 在渲染层被手抄 11 处，Windows 的判定另抄两份，
// 而同一个「在文件管理器中显示」动作有四种说法：两处三态（Finder / File Explorer / File Manager）、
// 一处无条件写 "Reveal in Finder"、两处无条件写 "Reveal in Explorer"。后三处在 Windows 与 Linux 上
// 直接说错话——"Explorer" 是 Windows 的词，"Finder" 是 mac 的词，两者都被无条件用在了所有平台。
//
// 那两处三态今天恰好一致，且其中一处的注释自称「与文件树右键菜单同一套说法」——手抄且知道自己在
// 手抄。本仓的教训是：同一条规则抄两份，改对一份就以为改完了，另一份静默保留旧行为。所以判定与
// 文案同住一处，组件只读，不再自己算。
//
// 为什么是三态而不是 `isMac: boolean`：文案有三种（Finder / File Explorer / File Manager），键盘
// 修饰键有两种。二态模型表达不了前者，于是每个需要第三种的地方都自己再判一次 Windows——这正是漂移
// 的来源。`hostPlatform()` 给出三态，`isMacPlatform()` 是它之上的一个问句，不是另一条判定。

/** 这台机器属于哪一族。`other` 覆盖 Linux 与任何未识别的平台——它不是「出错了」，是一个正常答案。 */
export type HostPlatform = 'mac' | 'windows' | 'other'

/**
 * 当前平台。取值源是 `navigator.userAgent`——渲染层没有 `process.platform`，而 preload 也不暴露它。
 *
 * 顺序有意义：先认 mac 再认 Windows。Windows 上的 userAgent 不含 "Mac"，mac 上的不含 "Windows"，
 * 所以两个判子今天互斥；写成顺序而不是互斥断言，是因为将来若有含两个词的 UA（嵌入式浏览器改过 UA），
 * 保守地当 mac 处理比抛错好——修饰键判错只是别扭，抛错会让整个菜单渲染不出来。
 *
 * `navigator` 缺席时取 `other` 而不是抛。注意这条防护在今天的两个运行环境里**都不会被触发**：
 * Electron 渲染进程当然有 `navigator`，而 node 测试环境里它也在场（`navigator.userAgent` 读出
 * `Node.js/24`）。留着它不是因为今天需要，而是因为它的代价是一次 typeof 比较，而缺了它的失败方式是
 * 整棵组件树渲染不出来——为了右键菜单里的一句文案不值得。缺省参数不够：`navigator` 不存在时求值它
 * 本身就抛，所以这里显式判在场。
 *
 * 别把这条注释读成「静态渲染测试会走到 `other` 分支」——那是它先前的说法，是错的。测试要覆盖三态得
 * 显式传 userAgent。
 */
export function hostPlatform(userAgent?: string): HostPlatform {
  const ua = userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent)
  if (ua.includes('Mac')) return 'mac'
  if (ua.includes('Windows')) return 'windows'
  return 'other'
}

/**
 * 修饰键该读 `metaKey` 还是 `ctrlKey`——键盘那条轴只有两态，mac 与其余。
 *
 * 这不是第二条判定：它由 {@link hostPlatform} 派生，所以平台判定改了它自动跟上。快捷键注册表的
 * `mac` / `other` 两组和弦、以及每个读 `event.metaKey` 的地方都走这里。参数一路传下去而不在这里
 * 兜默认值，`navigator` 缺席的处理就只有一处。
 */
export function isMacPlatform(userAgent?: string): boolean {
  return hostPlatform(userAgent) === 'mac'
}

/**
 * 系统文件管理器的名字。三个平台三个名字，`other`（含 Linux）用中性的 "File Manager"——Linux 上
 * 具体是 Nautilus 还是 Dolphin 由桌面环境决定，我们探测不到，说个准确的类名比猜一个错的品牌名好。
 */
export function fileManagerName(platform: HostPlatform = hostPlatform()): string {
  switch (platform) {
    case 'mac': return 'Finder'
    case 'windows': return 'File Explorer'
    case 'other': return 'File Manager'
  }
}

/**
 * 「在文件管理器中显示」这个动作的完整措辞。全部五个入口（编辑器错误态按钮、Tab 右键菜单、
 * 文件树右键菜单、Topic 右键菜单、Topic 行上的图标按钮）都用这一句，所以三处曾经互不相同的说法
 * 现在必然一致——它们读的是同一个函数，不是三份碰巧相同的字面量。
 */
export function revealInFileManagerLabel(platform: HostPlatform = hostPlatform()): string {
  return `Reveal in ${fileManagerName(platform)}`
}
