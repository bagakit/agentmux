import { Copy, Send } from 'lucide-react'
import { formatMessagingAddress, formatSessionAddress } from './agent-address'

/**
 * 终端画布右键菜单里的身份动作。
 *
 * 用户报的是「右键 TUI 上，实际也没有办法复制出某个 agent 自己的身份，这样就不方便和他通信」。
 * 而 Region、Tab、Roster 三处右键早就有这两项了，全部走 `agent-address` 那个唯一出口——**缺的
 * 只是终端画布这一个入口**。这不是缺一种地址，是同一份真相少接了一处：用户正在跟这个 Agent
 * 对话、光标就在它的 TUI 里，却必须离开画布去别的菜单里找它的身份。
 *
 * 所以这里一个字符串都不拼，只把已有的 formatter 接成菜单项——与 `agent-roster-menu.ts` 同一条
 * 纪律：同一个 Session 从终端、Region、Tab、Roster 四处复制出来必须逐字一致，那是同一份真相的
 * 四个入口，不是四套格式。
 *
 * 终端画布**没有** Region 语境（它拿到的是自己那一格的 `session`，不是 region id），所以寻址
 * 解析成 Session 地址——它在 View 被关掉、移动、分屏之后依然指向同一个 Agent，与 Tab 菜单、
 * Roster 同一条规则。想要 Region 地址的人在 Region 菜单里已经有它了，这里再给一份就是同一个
 * 入口的第二个说法。
 *
 * 做成数据而不是 JSX 里的一串项，与 roster 同一个理由：本仓 `renderToStaticMarkup` 渲不出 Radix
 * 的 Portal 内容，把在场与行为降成数据是唯一咬得住「不渲染」与「点了不生效」两种变异的做法。
 */
export type TerminalIdentityMenuAction = {
  key: 'message' | 'copy-session'
  label: 'Message this Agent' | 'Copy Session Address'
  icon: typeof Send
  onSelect(): Promise<void>
}

/**
 * 非 Agent 的那一格返回空数组，**不是两项灰掉的菜单**。
 *
 * 终端 Session 没有 Agent 身份可寻址。给它画一个 disabled 的「给这个 Agent 发消息」是在承诺
 * 一件不存在的事——用户会去想"为什么这个是灰的、我要怎么把它点亮"，而答案是"这里根本没有
 * Agent"。缺席才是如实。
 *
 * 这也不是降级、不需要服务窗提醒（AGENTS.md 原则 11 的判据是「Agent 还能不能干活」，而这里
 * 压根没有 Agent，属于第 3 类"完全好的：不打扰"）。
 *
 * 入参收 `kind` 而不是 `isAgent: boolean`：判据要跟着 `SessionSnapshot` 的判别键走，这样将来
 * 多一种 session kind 时这里是一个明确的取舍点，而不是某个调用方在外面替它算了一次布尔值。
 */
export function terminalIdentityMenuActions(input: {
  sessionId: string
  sessionKind: 'agent' | 'terminal'
  writeClipboardText(text: string): Promise<void>
}): TerminalIdentityMenuAction[] {
  if (input.sessionKind !== 'agent') return []
  return [
    {
      key: 'message',
      label: 'Message this Agent',
      icon: Send,
      onSelect: async () =>
        input.writeClipboardText(formatMessagingAddress({ agentSessionId: input.sessionId }))
    },
    {
      key: 'copy-session',
      label: 'Copy Session Address',
      icon: Copy,
      onSelect: async () => input.writeClipboardText(formatSessionAddress(input.sessionId))
    }
  ]
}
