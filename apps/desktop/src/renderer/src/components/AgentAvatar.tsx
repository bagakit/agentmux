import type { AgentDisplayState, AgentProviderId } from '@agentmux/core'
import { attentionAccentFor } from '../lib/attention-event'
import { AgentProviderIcon } from './AgentProviderIcon'

/**
 * 一个 Agent 的头像：身份看图标，注意力与状态都由**同一个** `state` 说了算。
 *
 * 只收 `state` 一个权威输入，注意力在组件内部由 `attentionAccentFor(state)` 派生。曾经它还收一个
 * `attention` prop，于是两个调用方能对同一个 state 各递一个不同的答案（Topic 侧递算好的 accent、
 * Branch 侧硬写 null），组件照单全收——「waiting 画成 idle」就是这么静默发生的。派生掉之后，
 * 「需不需要你」在整个应用里只有一处裁决。
 *
 * 边框色不在这里挑——它读 `.status--<state>` 继承下来的 `--status-ink`，那是"状态到颜色"的唯一
 * 定义处（styles.css 的状态语汇段）。运行态 CSS 读取它绘制 outline/glow；其他状态不画常驻边界。
 *
 * 有 `onOpen` 才是 `<button>`，否则退成 `role="img"` 的 `<span>`：一个点不动的头像不该进 Tab 序，
 * 也不该报成按钮。按钮那支自己就是可聚焦元素，Enter/Space 天然等价于点击——不必也不该再挂一套
 * keydown。`stopPropagation` 不是防御性代码：头像坐在整行的打开按钮之上，不拦住冒泡就会既跳
 * Agent 又开 Topic。调用方给的 `onOpen` 必须是全局那个 `selectSession`，不另开跳转路径。
 */
export function AgentAvatar({
  label,
  onOpen,
  providerId,
  state
}: {
  label: string
  onOpen?: (() => void) | undefined
  providerId: AgentProviderId
  state: AgentDisplayState
}) {
  const attention = attentionAccentFor(state)
  const Element = onOpen ? 'button' : 'span'
  return (
    <Element
      className={`agent-avatar status status--${state}`}
      type={onOpen ? 'button' : undefined}
      role={onOpen ? undefined : 'img'}
      aria-label={`${label} · ${state}`}
      title={`${label} · ${state}`}
      {...(attention ? { 'data-attention': attention } : {})}
      onClick={onOpen ? (event) => {
        event.stopPropagation()
        onOpen()
      } : undefined}
    >
      <AgentProviderIcon providerId={providerId} size={12} />
    </Element>
  )
}
