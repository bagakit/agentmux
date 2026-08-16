// 特权 IPC 频道的「发送者可信吗」判据 + 「不可信就抛」这半件处置。抽成可 import 的纯模块，理由与
// window-security.ts 同源：ipc.ts 一 import 就把整条 registerIpc 副作用与 electron（ipcMain/app/shell…）
// 拖进来，任何单测都无法 import 它去质询这条判据。此前这条判据以
// `if (event.sender !== args.window.webContents) throw new Error('Untrusted … sender')` 的形态散落在
// 十余个 handler 里，每处都是一个够不着的语句位置——实测把某处的 `!==` 写成 `===`、或整行删掉、或把
// acceptControl 里那半个比较拿掉，desktop 的相关 8 个测试文件 80/80 全绿、tsc 也退 0（详见
// ipc-sender-trust.test.ts 头部记录的三次变异）。唯一被守住的那处（openExternalFromRenderer）恰恰是因为
// 它是**模块级导出函数**，测试够得着——这正是本文件要给其余频道补的那件事。
//
// 这个文件**必须保持纯**：不 import electron、无模块级副作用。发送者与受信任窗口都以 `unknown` 不透明
// 句柄传入，判据自己用 `Object.is` 比对身份——身份比对这件**承重**的事因此落在被行为测试直接质询的纯
// 函数里，而不是留在 shell 的某个可被静默改坏的语句位置。接线（每个特权 handler 真的先过这道判据）由
// ipc-sender-trust.test.ts 的 AST 接线守卫钉住。

import { CONTROL_RESPONSE_CHANNEL } from '../shared/contracts.js'

/**
 * 每个特权频道对应的人读标签。拒绝理由由 `Untrusted ${label} sender` 拼出，与历史抛错**逐字一致**
 * （'Untrusted clipboard image sender'、'Untrusted Browser Profile sender' …）。
 *
 * 这张表是「哪些频道是特权频道 + 它们各自的拒绝措辞」的唯一真源，有两个作用：
 * 1. 多个频道共用一个标签是**刻意**的——六个 browser:*Profile* 频道共享 'Browser Profile'，此前是六份
 *    手抄的同一个字符串字面量，这里收成一份标签、多个键。
 * 2. 接线守卫遍历它的键，逐个断言那个频道的 handler 真的先过了发送者判据——漏一个就红。
 *
 * `CONTROL_RESPONSE_CHANNEL` 用**计算键**而不是手抄 'control:response'：频道名的 SSOT 在 contracts.ts，
 * ipc.ts 也从那里 import 它去注册 acceptControl。手抄一份就是第二个写入点，contracts 改了名这里会
 * 静默漂移（记忆 ctxmux-endpoint-frozen-across-versions：两个该联动的常量分居两文件必 drift）。计算键
 * 让本表的键随那个常量一起变。
 */
export const PRIVILEGED_SENDER_LABELS = {
  'ui:writeClipboardImage': 'clipboard image',
  'ui:rendererUpdateReady': 'renderer update',
  'ui:captureScreenshot': 'screenshot',
  'ui:listAgentSkills': 'Agent skills',
  'ui:listWorkspaceSkills': 'Workspace agent skills',
  'ui:savePastedImage': 'pasted image',
  'ui:revealCrashLog': 'crash log',
  'ui:notifyAgentAttention': 'notification',
  'browser:switchProfile': 'Browser Profile',
  'browser:listProfiles': 'Browser Profile',
  'browser:createProfile': 'Browser Profile',
  'browser:deleteProfile': 'Browser Profile',
  'browser:detectProfileImportSources': 'Browser Profile',
  'browser:importProfile': 'Browser Profile',
  'browser:selectElement': 'Browser selection',
  'browser:cancelElementSelection': 'Browser selection',
  // 回答「要不要把这个应用链接交给系统」。伪造它等于替用户按下"允许"，于是任意页面能拿它选定的
  // 参数启动本机应用——这正是那一问要挡住的事，所以它和别的特权频道一样验发送方。
  'browser:answerAppLink': 'Browser app link',
  'browser:setAnnotationMarkers': 'Browser annotation',
  // 跑一段 Agent 现写的代码，是 browser:* 里权限最高的一条——比选元素高。任何能伪造这个频道的
  // 发送者都能在用户已登录的页面上做任意操作。
  'browser:runScript': 'Browser automation',
  [CONTROL_RESPONSE_CHANNEL]: 'control response'
} as const

/**
 * 只有登记在 PRIVILEGED_SENDER_LABELS 里的频道能过这道判据。类型收成键的并集，所以「一个特权频道被接线
 * 却没在表里登记标签」是编译期错误，而不是运行期的 `Untrusted undefined sender`。
 */
export type PrivilegedChannel = keyof typeof PRIVILEGED_SENDER_LABELS

/**
 * 一次发送者校验的判定。reject 分支**始终**带上 reason（人读、可日志），即便某些调用方（控制响应频道）
 * 会把它丢掉再静默返回——「为什么拒」这件事由判据负责说清，「拒了怎么处置」（抛 vs 静默返回）由 shell
 * 决定。判定与处置分开，是为了让同一个纯判据既服务会抛的十余个频道，也服务静默返回的控制响应频道。
 */
export type SenderTrust =
  | { readonly trusted: true }
  | { readonly trusted: false; readonly reason: string }

/**
 * 发送者身份是否等于受信任窗口的身份。两个句柄都以 `unknown` 传入——本文件不许持有 electron 的
 * WebContents 类型。身份比对用 `Object.is`（对象引用上与 `===` 等价，对 `unknown` 形参读起来更直白）。
 * 判定与措辞都在这里，shell 侧的适配器因此只剩一次转发表达式，没有可以插早退或翻极性的语句位置。
 */
export function senderTrust(
  channel: PrivilegedChannel,
  sender: unknown,
  trustedFrame: unknown
): SenderTrust {
  if (Object.is(sender, trustedFrame)) return { trusted: true }
  return { trusted: false, reason: `Untrusted ${PRIVILEGED_SENDER_LABELS[channel]} sender` }
}

/**
 * 「不可信就抛」这半件处置——供会抛的那十余个特权频道用。抽成纯函数（而不是把 `if (!trust.trusted)
 * throw` 留在 shell 的适配器里）是为了让适配器变成**单表达式**：`assertSenderTrusted(senderTrust(...))`，
 * 体里一句语句都没有，接线守卫因此只需判「体就是这一次转发」这件结构上不可绕的事。控制响应频道**不**用
 * 它——它要的是静默返回，那半件处置留在它自己的 shell 里（见 ipc.ts 的 acceptControl）。
 *
 * accept 分支是本族习惯性无人守的那一侧：把判据取反后「可信也抛」这种改法只有正向用例（可信→不抛）
 * 才认得出，所以行为测试两侧都钉。
 */
export function assertSenderTrusted(trust: SenderTrust): void {
  if (!trust.trusted) throw new Error(trust.reason)
}
