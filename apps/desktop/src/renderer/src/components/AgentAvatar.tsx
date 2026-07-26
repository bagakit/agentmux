import type { AgentDisplayState, AgentProviderId } from '@agentmux/core'
import type { AttentionCategory } from '../lib/attention-event'
import { AgentProviderIcon } from './AgentProviderIcon'

/**
 * 一个 Agent 的头像：身份看图标，只有运行态才看外描边；停止态用灰度保留身份。
 *
 * 一枚方块同时承载两件事，省掉"点讲状态、文字讲身份"要读两处。边框色不在这里挑——它读
 * `.status--<state>` 继承下来的 `--status-ink`，那是"状态到颜色"的唯一定义处（styles.css 的
 * 状态语汇段）。运行态 CSS 读取它绘制 outline/glow；其他状态不画常驻边界。
 *
 * 点击定位到该 Agent；调用方给的 `onOpen` 必须是全局那个 `selectSession`，不另开跳转路径。
 */
export function AgentAvatar({
  attention,
  label,
  onOpen,
  providerId,
  state
}: {
  attention: AttentionCategory | null
  label: string
  onOpen(): void
  providerId: AgentProviderId
  state: AgentDisplayState
}) {
  return (
    <button
      className={`agent-avatar status status--${state}`}
      type="button"
      // 按钮自己就是可聚焦元素，Enter/Space 天然等价于点击——不必也不该再挂一套 keydown。
      onClick={(event) => {
        // 头像坐在整行的打开按钮之上，不拦住冒泡就会既跳 Agent 又开 Topic。
        event.stopPropagation()
        onOpen()
      }}
      aria-label={`${label} · ${state}`}
      title={`${label} · ${state}`}
      {...(attention ? { 'data-attention': attention } : {})}
    >
      <AgentProviderIcon providerId={providerId} size={12} />
    </button>
  )
}
