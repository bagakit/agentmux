import { Copy, Send } from 'lucide-react'
import { formatMessagingAddress, formatSessionAddress } from './agent-address'

/**
 * Roster 行右键菜单的动作源。
 *
 * Roster 是「列出本窗口每个 Agent」的地方，因此最该在这里就能寻址/交接——而不必先切到分屏格。
 * 动作一律复用 `agent-address` 的 formatter：同一个 Session 从 Roster、Tab、Region 三处复制出来
 * 必须逐字一致。这里不重写任何寻址逻辑，只把已有的 formatter 接成菜单项。
 *
 * Roster 行没有 View/Region 语境（它就是一个 Session），所以交接解析成 **Session 地址**——它在
 * View 被关掉、移动、分屏之后依然指向同一个 Agent，与 Tab 菜单同一条规则。
 *
 * 每行都是一个 Agent，故这两项恒在场、无 gating。做成数据（而非 JSX 里的一串项）是为了让
 * 「点了发生什么」在没有 DOM 的情况下也断言得着：本仓 renderToStaticMarkup 渲不出 Radix 的
 * Portal 内容，把在场与行为降成数据是唯一咬得住「不渲染」「点了不生效」两种变异的做法。
 */
export type AgentRosterMenuAction = {
  key: 'message' | 'copy-session'
  label: 'Message this Agent' | 'Copy Session Address'
  icon: typeof Send
  onSelect(): Promise<void>
}

export function agentRosterMenuActions(input: {
  sessionId: string
  writeClipboardText(text: string): Promise<void>
}): AgentRosterMenuAction[] {
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
