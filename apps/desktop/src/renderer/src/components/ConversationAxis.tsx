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
  onSelect,
  onPeek,
  onPeekEnd
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
  /**
   * 指到（或聚焦到）一枚标记：交出这枚标记的**矩形**、它对应的那条 item、以及已解析好的身份名。
   *
   * 交矩形而不是指针坐标：标记是个 24px 的圆形命中区，按指针锚定会让浮层在标记内部随指针漂移；
   * 按标记自身的矩形锚定，浮层与它所描述的那枚头像是固定关系。交名字是因为名字**已经**在这里解析
   * 过一次（`describe` 是轴的入参、button 的 aria-label 就是它）——让调用方再解析一遍就是把同一个
   * 判断复制到两处，两处必须逐字一致却各调一次。交 item 而不是已经取好的引文：「展示什么」是调用
   * 方的决定，轴不知道也不该知道面板里放什么。
   */
  onPeek?: (peek: { rect: DOMRect; mark: ConversationAxisMark; name: string }) => void
  /**
   * 指针离开、失焦、或按下 Escape：与 {@link onPeek} 同一条出口的另一半。
   *
   * 返回「刚才真的关掉了一个开着的面板吗」。轴不持有面板状态，所以它无法自己判断该不该吃掉
   * Escape；由唯一知道答案的那一层回答，轴据此决定是否阻止冒泡。
   */
  onPeekEnd?: () => boolean
}) {
  const marks = conversationAxis(items, belongs)
  // 空轴不画空槽：一条还没有人说话的 Session 上，说话人轴什么也不表达。
  if (marks.length === 0) return null

  return (
    <div
      className="conversation-axis"
      role="group"
      aria-label={label}
      // Escape 关面板。挂在轴容器而不是每枚标记上：事件从聚焦的那枚标记冒上来，一处足够，而挂在
      // 标记上就是同一个 handler 写 N 遍。面板本身 `pointer-events: none`，永远拿不到焦点，所以
      // 「关它」这件事只能由触发它的那个控件所在的子树来承担。
      //
      // `onPeekEnd` 返回「刚才真的关掉了一个开着的面板吗」，只有为真时才 stopPropagation：轴不
      // 知道面板开没开，而无条件吞掉 Escape 会让它在面板关着时也被静默吃掉，外层可能正等着用它
      // 关一个更大的东西（Region、对话框）。把这个判断留给唯一知道答案的那一层。
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        if (onPeekEnd?.() === true) event.stopPropagation()
      }}
    >
      {marks.map((mark) => (
        <AxisMark
          key={mark.item.id}
          mark={mark}
          size={size}
          describe={describe}
          selected={mark.index === selectedIndex}
          onSelect={onSelect}
          {...(onPeek === undefined ? {} : { onPeek })}
          {...(onPeekEnd === undefined ? {} : { onPeekEnd })}
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
  onSelect,
  onPeek,
  onPeekEnd
}: {
  mark: ConversationAxisMark
  size: number
  describe: DescribeSpeaker
  selected: boolean
  onSelect: (index: number) => void
  onPeek?: (peek: { rect: DOMRect; mark: ConversationAxisMark; name: string }) => void
  onPeekEnd?: () => boolean
}) {
  const { name, providerId } = describe(mark.speaker)
  // hover 与 focus 走**同一个** peek，pointerleave 与 blur 走同一个 peekEnd：触屏上没有 hover，
  // 键盘上没有指针，若两条通路各写一份，移动端与键盘就成了两套要各自维护的实现。这里让四个事件
  // 收敛到一对出口上，于是「不存在只能靠鼠标 hover 才能获得的信息」是结构性的，不靠自觉。
  const peek = (event: { currentTarget: HTMLButtonElement }): void => {
    onPeek?.({ rect: event.currentTarget.getBoundingClientRect(), mark, name })
  }
  return (
    <button
      type="button"
      className="conversation-axis__mark"
      // 位置来自全量 scale 的 fraction，与主刻度同一条时间基准。
      style={{ left: `${mark.fraction * 100}%` }}
      data-selected={selected ? '' : undefined}
      // 名字挂在 button 上，不拼时刻：诚实的时刻只能从 scale 的 readout 取，而这枚标记手里的
      // `createdAt` 是个裸数字——把它格式化进任何属性，就把 ruler 特意做成类型上不可表达的那种
      // 不诚实（序数轴上没有时刻）又请了回来。时刻归面板，走 readout。
      aria-label={name}
      onClick={() => onSelect(mark.index)}
      onPointerEnter={peek}
      onFocus={peek}
      onPointerLeave={() => onPeekEnd?.()}
      onBlur={() => onPeekEnd?.()}
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
