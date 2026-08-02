import type { AgentDisplayState } from '@agentmux/core'
import { attentionAccentFor, type AttentionCategory } from './attention-event'

/**
 * Board 卡片根元素的属性：状态色的来源，以及「这张卡要不要带色框」。
 *
 * 两件事一起返回，因为它们都是同一个 `state` 的投影，分两处各算一次必然漂移——而这里漂移的症状
 * 恰好是此前的缺陷本身：卡框说琥珀、卡里的状态点说红。
 *
 * `className` 只带 `status--<state>`，**不带 `.status` 本体**（理由与恢复横幅同源，见
 * `session-recovery-banner.ts`：`.status` 是 `inline-flex` + `capitalize` 的行内小构件语汇，套到
 * grid 卡片上会掀翻版式并把措辞大写化）。需要的只是 `--status-ink` 那一次赋值，而赋值全在
 * `.status--<state>` 这一族上。于是卡框的颜色来自 chrome.css 那张唯一的状态色表，不再自己挑。
 *
 * `data-attention` 决定的是**画不画**，不是画什么颜色。取值走 {@link attentionAccentFor}——也就是
 * 头像与快速切换器问的同一个问题，答案恰好两个（needs-you / error）加一个 null：
 *
 *   - `waiting` / `blocked` → needs-you，带框（琥珀由色表给）；
 *   - `error` → error，带框（红由色表给）；
 *   - `disconnected` → null，不带框。此前它被画成琥珀，而 `attention-event.ts` 写明「掉线不是一次
 *     请求，它有自己的中性处理，正是为了让琥珀只表示等你」——所以那抹琥珀本身就是缺陷：一条掉线的
 *     链路被画成了「你是瓶颈」。掉线仍然读得出来：卡里的状态点是空心中性环（色表那条规则）；
 *   - `done` → null，不带框。`attentionAccentFor` 刻意把 done 排除在上色之外（红与琥珀留给「你是
 *     瓶颈」和「这坏了」，完成态跟着抢同一抹墨，一眼扫过就什么都读不出了）。
 *
 * 换句话说：卡片不再持有第二份「哪些状态要上色」的清单。清单只有 `attentionAccentFor` 一份。
 */
export function boardRunCardAttributes(state: AgentDisplayState): {
  className: string
  'data-attention'?: AttentionCategory
} {
  const accent = attentionAccentFor(state)
  return {
    className: `board-run-card status--${state}`,
    ...(accent ? { 'data-attention': accent } : {})
  }
}
