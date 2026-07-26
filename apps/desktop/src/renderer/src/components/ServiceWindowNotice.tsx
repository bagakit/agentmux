import { Info } from 'lucide-react'
import type { RenderableServiceNotice } from '../lib/service-window-notice'

/**
 * 服务窗（AGENTS.md 原则 11）。像窗口上贴的一条告示：停在旁边，不挡路，也不消失。
 *
 * 它**不是** toast（会自己消失，用户就再也无从知道自己在降级状态里），**不是**错误弹窗
 * （会抢焦点、挡住工作，且在说「你完了」——而事实是「能干活，只是少一项能力」）。它说清三件事：
 * 哪一步没走通、现在按什么状态在跑、要恢复完整能力该做什么；随条件消失，而非随用户点关闭消失。
 *
 * 这个组件是纯展示：分不分得清、要不要出现、说什么，全在 `lib/service-window-notice.ts` 判定。
 * 拿到 null 就渲染 null（healthy 与 agent-broken 都不由服务窗承载）——调用方把判定结果直接传进来。
 */
export function ServiceWindowNotice({
  notice
}: {
  notice: RenderableServiceNotice | null
}) {
  if (!notice) return null
  // 分不清与流程降级用同一种告示形态，只以 data 属性区分语气：两者都不阻断、都不静默。
  return (
    <aside
      className="service-window"
      data-kind={notice.kind}
      role="status"
      aria-live="polite"
    >
      <span className="service-window__icon" aria-hidden="true">
        <Info size={14} />
      </span>
      <div className="service-window__body">
        <strong className="service-window__step">{notice.notice.step}</strong>
        <span className="service-window__mode">{notice.notice.mode}</span>
        <span className="service-window__restore">{notice.notice.restore}</span>
      </div>
    </aside>
  )
}
