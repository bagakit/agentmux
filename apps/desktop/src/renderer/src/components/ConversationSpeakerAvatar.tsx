import type { AgentProviderId } from '@agentmux/core'
import { UserRound } from 'lucide-react'
import type { CSSProperties } from 'react'
import type { ConversationSpeaker } from '../lib/conversation-speaker'
import { speakerColorHue } from '../lib/conversation-avatar-color'
import { AgentProviderIcon } from './AgentProviderIcon'

/**
 * 说话人头像：把一个 `{role, id}` 身份画成一枚可扫视的小圆片。
 *
 * ## 为什么是这个组件、而不是复用 AgentAvatar
 *
 * 设计合同「对话体的说话人要有头像与身份」要的是两条轴（自我 Agent 轴、说话人轴）**共用同一套身份
 * 表示**——那套表示就是 `ConversationSpeaker` 的 `{role, id}`，不是某个现成组件。`AgentAvatar` 是
 * Board 上「可跳转的 Agent 行头像」：它是 `<button>`、带 `onOpen` 导航、`AgentDisplayState` 状态外
 * 描边、`AttentionCategory` 角标，且 `providerId` 必填。人类没有 providerId，说话人标记也不是一个可点
 * 跳转的控件，所以这里另起一个**纯标记**组件，只回答「这段话是谁说的」。
 *
 * ## 受控纯组件（验收 1）
 *
 * props 进、元素树出：不读 Store、不 import api。因此 `providerId` 与 `name` 都由**调用方**解析后
 * 传入——这正是设计里「role 选画法，id 去 store 查 providerId」那句话的落点：查 store 发生在组件之外，
 * 组件本身可在无 DOM 的测试里直接 `renderToStaticMarkup` 求值。`providerId` 不进身份判定、也不进本
 * 组件的身份语义，它只回答 agent 这一路「怎么画」。
 *
 * ## 按 role 分叉画法（human 与任何 provider 图标在 16px 下都要能分开）
 *
 * - **human**：用 lucide 的 `UserRound`（头肩剪影）。它与 `Bot`（方头带天线，provider 兜底图）以及
 *   各家 provider 真图标在轮廓上就不同，16px 下靠**形状**即可分辨，不依赖颜色——满足「不存在只有
 *   视觉能获得的身份信息」里对形状的那一半。人类的颜色固定取 `--blue`（正文里用户说话已经是蓝色，
 *   见 activity-conversation.css 的 `--user_message` 节点），不派生：今天只有一个人类身份，给一个
 *   常量 id 派生色相纯属多余，且派生结果可能撞到 `--amber`（状态语汇里 amber 专表「需要你」，见
 *   StatusDot）或 `--green`（assistant 色），反而与既定配色打架。
 * - **agent**：复用 `AgentProviderIcon`（已是纯受控、`aria-hidden`、吃 `size`、未知 provider 兜底
 *   `Bot`）。身份颜色由 id 派生成一个色相（见 {@link speakerColorHue}），画成圆片的底色 + currentColor
 *   基色。这样**两个同 provider 的 Agent**（比如两条 Claude）共用同一枚品牌图标，却因 id 不同而拿到
 *   不同的底色——这正是 A2A 场景下「同一条对话里两个 Agent 必须能区分」在视觉上的兑现。
 *
 * ## 无障碍（验收 3）
 *
 * 圆片本身是 `role="img"` 且带 `aria-label={name}`——身份名以可访问文本提供，读屏拿到的是「谁」，
 * 不是一个无名图标。内部 glyph 一律 `aria-hidden`：human 的 `UserRound` 显式传入，agent 的
 * `AgentProviderIcon` 自带。于是颜色（纯视觉）绝不是唯一的身份载体。
 *
 * ## 两个尺寸都可用（验收 4）
 *
 * `size` 是这枚头像在轴上的边长（16 或 20，两条轴的实际取值）。它同时驱动圆片外框与内部 glyph 的
 * 尺寸，glyph 比外框内缩 4px 留出圆片边距。两个尺寸都实际取过值、都可用，而不是只为一个尺寸调过。
 *
 * @example
 * // 说话人轴上的人类身份（name 由调用方按命名链解析后传入）
 * <ConversationSpeakerAvatar speaker={{ role: 'human', id: HUMAN_SPEAKER_ID }} name="You" />
 * // 自我 Agent 轴上某个 Agent 说话的位置（providerId/name 由调用方查 store 得到）
 * <ConversationSpeakerAvatar speaker={agentSpeaker} name="Claude" providerId="claude" size={20} />
 */
export function ConversationSpeakerAvatar({
  speaker,
  name,
  providerId,
  size = 16
}: {
  /** 身份：唯一的身份输入，来自 `speakerOf(item)`。role 选画法，id 派生颜色。 */
  speaker: ConversationSpeaker
  /** 可读的身份名。必填——没有它这枚头像就成了只有视觉能识别的身份，违反验收 3。 */
  name: string
  /** 这个 agent 怎么画；由调用方用 `speaker.id` 去 store 查得。human 不需要。 */
  providerId?: AgentProviderId
  /** 边长。轴上取 16、对话正文取 20，两者都有生产调用者，所以两条尺寸路径都要可用。 */
  size?: number
}) {
  // glyph 比圆片内缩，留出圆片的边距；下限钳到 8px，避免极小尺寸下 glyph 归零。
  const glyphSize = Math.max(8, size - 4)
  const isAgent = speaker.role === 'agent'
  // 圆片外框尺寸随 size 走（验收 4 的可观测信号之一）；agent 再挂上 id 派生的色相自定义属性，
  // CSS 据此在固定饱和/明度带内取色（见 conversation-avatar.css）。
  const style = {
    width: size,
    height: size,
    ...(isAgent ? { '--speaker-hue': speakerColorHue(speaker.id) } : {})
  } as CSSProperties

  return (
    <span
      className={`conversation-avatar conversation-avatar--${speaker.role}`}
      role="img"
      aria-label={name}
      title={name}
      style={style}
    >
      {isAgent ? (
        // `providerId` 原样传下去，缺失就是缺失——`AgentProviderIcon` 的签名承认这一路（缺失走 Bot
        // 兜底），所以这里不需要把「查不到」编码成一个假值。`exactOptionalPropertyTypes` 下显式
        // `undefined` 不能喂给 optional 属性，故按缺席传，而不是退回 `?? ''` 那种假值。
        <AgentProviderIcon {...(providerId === undefined ? {} : { providerId })} size={glyphSize} />
      ) : (
        <UserRound size={glyphSize} strokeWidth={1.9} aria-hidden="true" />
      )}
    </span>
  )
}
