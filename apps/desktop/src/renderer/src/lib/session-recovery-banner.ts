import type { AgentDisplayState } from '@agentmux/core'

/**
 * 恢复横幅代表的是哪个状态。
 *
 * 只有一处判定，因为这个取值要同时决定两件事：横幅自己的修饰类（`terminal-recovery--<state>`，
 * 决定版式）与状态语汇的赋值类（`status--<state>`，决定颜色）。分两处各算一次必然漂移，而漂移的
 * 症状是"版式说掉线、颜色说崩了"——两个都对得上自己那半边，合起来在说两件事。
 *
 * 返回值刻意收在 {@link AgentDisplayState} 里：颜色必须来自 chrome.css 那张唯一的状态色表
 * （`--status-ink`），而那张表的键就是这个联合类型。取一个不在联合里的名字，就等于又铸了一份
 * 状态色表——这正是横幅此前的形状：它把 `disconnected` 写死成 `var(--amber)`，而色表明确判它是
 * `--text-3`，并在注释里写明"琥珀只表示等你"。于是一条掉线的链路被画成了"你是瓶颈"。
 *
 * 三个入参就是渲染现场已有的那三个事实，顺序即优先级：还连着但链路断了（`disconnected`）优先于
 * 进程已退（`exited`），两者都不是才是"会话不可用"（`error`）。
 */
export function sessionRecoveryState(input: {
  disconnected: boolean
  exited: boolean
}): AgentDisplayState {
  if (input.disconnected) return 'disconnected'
  if (input.exited) return 'exited'
  return 'error'
}

/**
 * 横幅根元素的 class。
 *
 * 两个类一起返回，是为了让"版式类与颜色类同源"成为结构事实而不是靠人盯。
 *
 * 只带 `status--<state>` 而**不带 `.status` 本体**：`.status` 是给状态点那种行内小构件用的
 * （`display:inline-flex` + `capitalize`），套到横幅上会掀翻它的 grid 版式并把正文措辞大写化。
 * 需要的只是 `--status-ink` 那一次赋值，而赋值全在 `.status--<state>` 这一族上。
 */
export function sessionRecoveryClassName(state: AgentDisplayState): string {
  return `terminal-recovery terminal-recovery--${state} status--${state}`
}
