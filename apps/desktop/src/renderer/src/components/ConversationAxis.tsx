import type { AgentProviderId } from '@agentmux/core'
import type { AgentTimelineItem } from '../../../shared/contracts'
import { conversationAxis, type ConversationAxisMark, type SpeakerPredicate } from '../lib/conversation-axis'
import type { ConversationSpeaker } from '../lib/conversation-speaker'
import { ConversationSpeakerAvatar } from './ConversationSpeakerAvatar'

/**
 * 把一个身份解析成「叫什么、画哪个 provider」。
 *
 * 是一个具名类型而不是行内写四遍：轴、轴标记、Activity 的正文回合、以及接线层都要说这同一句话，
 * 而它们必须逐字一致——providerId 是 optional 且在 `exactOptionalPropertyTypes` 下「缺席」与
 * 「显式 undefined」不是一回事，抄第四遍就是给漂移开一个口子。
 *
 * 解析发生在**调用方**（唯一持有 session 的那一层），不在这些组件里：组件因此不读 store，可在无
 * DOM 的测试里直接求值。返回的 `name` 是身份的判别器——同 provider 的两个 Agent 共用一枚品牌图标、
 * 色相又有约 52% 概率撞在 20° 内（已实测，见设计 SSOT），所以接线方必须给出互相可分的名字。
 */
export type DescribeSpeaker = (speaker: ConversationSpeaker) => {
  name: string
  providerId?: AgentProviderId
}

/**
 * 一条说话人轴：把某一类身份的发言画成时间轴上的若干枚头像。
 *
 * ## 一个组件、两条轴
 *
 * 设计 SSOT 要求两条轴是「同一个可复用组件按轴的语义参数化，不是两个」。参数化落在 `belongs`
 * 这一个谓词上（{@link SpeakerPredicate}），定位与筛选都在 {@link conversationAxis} 里只写一遍。
 * 调用处于是是同一个组件用两组参数渲染两次，代码里不存在第二套轴。
 *
 * 谓词作用在**已判定的身份**上而不是 item，所以这里没有任何路径能按 `kind` 反推「谁说的」——那是
 * 设计 SSOT 明确要挡掉的东西。机器上报（tool_call / permission / lifecycle）在身份判定处就返回
 * null，两条轴都收不到它。
 *
 * ## 空轴不占位
 *
 * 没有标记时返回 `null` 而不是一个空的轨道 `<div>`。今天的说话人轴在一条还没有人说话的 Session 上
 * 就是空的，画一条空槽会让"这里有一条你还没用上的功能"占掉纵向密度，而它什么也不表达。
 *
 * ## 受控、无 Store
 *
 * 组件不读 Store、不 import api：身份用什么名字、agent 画哪个 provider 的图标，都由调用方通过
 * `describe` 解析后给出。这既让组件能在无 DOM 的测试里直接求值，也把「拿 id 去 store 查」这件事
 * 留在唯一该做它的那一层。
 *
 * ## 名字是身份的判别器，颜色只是辅助
 *
 * 已实测（见设计 SSOT）：色相由 id 派生虽然分布均匀，但 4 个身份就有约 52% 的概率出现一对相隔
 * 不到 20°，而同 provider 的两个 Agent 画的是同一枚品牌图标——形状也不分。所以调用方**必须**为
 * 同一条对话里的多个身份给出互相可分的 `name`；两个身份能不能认出来，压在名字上，不压在颜色上。
 */
export function ConversationAxis({
  items,
  belongs,
  label,
  size,
  describe,
  selectedIndex,
  onSelect
}: {
  /** 全量 timeline。scale 在全量上建，位置按原始下标取——两条轴因此与主刻度时间基准同源。 */
  items: readonly AgentTimelineItem[]
  /** 轴语义：哪些身份在这条轴上留标记。两条轴只有这个参数不同。 */
  belongs: SpeakerPredicate
  /** 这条轴是什么的可读名，作为轨道的可访问名。 */
  label: string
  /** 头像边长。两条轴今天同取 16；对话正文里同一个头像取 20，所以两个值都有生产调用者。 */
  size: number
  /** 把身份解析成「叫什么、画哪个 provider」。调用方查 store，组件本身不查。 */
  describe: DescribeSpeaker
  /** 主刻度当前选中的下标，用于把同一个选择在轴上也标出来。 */
  selectedIndex: number | null
  /** 点一枚头像＝选中它对应的那条 item，走调用方那一个选择出口。 */
  onSelect: (index: number) => void
}) {
  const marks = conversationAxis(items, belongs)
  // 空轴不画空槽：一条还没有人说话的 Session 上，说话人轴什么也不表达。
  if (marks.length === 0) return null

  return (
    <div className="conversation-axis" role="group" aria-label={label}>
      {marks.map((mark) => (
        <AxisMark
          key={mark.item.id}
          mark={mark}
          size={size}
          describe={describe}
          selected={mark.index === selectedIndex}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
}

/**
 * 轴上的一枚标记。
 *
 * 是 `<button>` 而不是带 onClick 的 `<span>`：轴的用途是"不滚动就找到那句话在哪儿"，所以每枚标记
 * 都得可点、可聚焦、Enter 可达。这也是移植到触屏的前提——`hover` 在触屏上不存在，若标记只对
 * hover 有反应，移植就得重写。
 */
function AxisMark({
  mark,
  size,
  describe,
  selected,
  onSelect
}: {
  mark: ConversationAxisMark
  size: number
  describe: DescribeSpeaker
  selected: boolean
  onSelect: (index: number) => void
}) {
  const { name, providerId } = describe(mark.speaker)
  return (
    <button
      type="button"
      className="conversation-axis__mark"
      // 位置来自全量 scale 的 fraction，与主刻度同一条时间基准。
      style={{ left: `${mark.fraction * 100}%` }}
      data-selected={selected ? '' : undefined}
      // 名字挂在 button 上，不拼时刻：诚实的时刻只能从 scale 的 readout 取，而这枚标记手里的
      // `createdAt` 是个裸数字——把它格式化进任何属性，就把 ruler 特意做成类型上不可表达的那种
      // 不诚实（序数轴上没有时刻）又请了回来。时刻归 T-005 的面板，走 readout。
      aria-label={name}
      onClick={() => onSelect(mark.index)}
    >
      {/* 头像在这里是**装饰**：可访问名已由 button 给出，头像自带的 `role="img"` + `aria-label` 会
          让读屏把同一个名字念两遍。`aria-hidden` 只作用在这一处包装，头像组件本身不动——它在对话
          正文里外层是纯 span，那里那份 aria-label 正是唯一的名字来源，删掉它会让正文的头像变成只有
          视觉能识别的身份。 */}
      <span className="conversation-axis__glyph" aria-hidden="true">
      <ConversationSpeakerAvatar
        speaker={mark.speaker}
        name={name}
        size={size}
        {...(providerId === undefined ? {} : { providerId })}
      />
      </span>
    </button>
  )
}
