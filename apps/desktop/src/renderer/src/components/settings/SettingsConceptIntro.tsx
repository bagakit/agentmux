import { useId } from 'react'
import capsuleArt from '../../assets/settings/capsule-keepsake.png'
import goalsArt from '../../assets/settings/goals-companions.png'
import './settings-concept-intro.css'

/** Read-only illustrations. Configuration and execution remain with each pane. */
export function CapsuleIntroduction() {
  const titleId = useId()
  return <section className="settings-concept-intro" data-concept="capsule" aria-labelledby={titleId}>
    <div className="settings-concept-intro__copy">
      <span className="settings-concept-intro__eyebrow">从一次产出，到随手可用</span>
      <h3 className="settings-concept-intro__title" id={titleId}>把好用的页面，留在手边。</h3>
      <p className="settings-concept-intro__description">Agent 做出的页面，保存为 Capsule，下次还能打开。</p>
    </div>
    <div className="settings-concept-intro__art" aria-hidden="true">
      <img src={capsuleArt} alt="" width="1536" height="1024" draggable={false} />
    </div>
  </section>
}

export function GoalsIntroduction() {
  const titleId = useId()
  return <section className="settings-concept-intro" data-concept="goals" aria-labelledby={titleId}>
    <div className="settings-concept-intro__copy">
      <span className="settings-concept-intro__eyebrow">方向清楚，合作才有着落</span>
      <h3 className="settings-concept-intro__title" id={titleId}>让想做到的事，一步步成形。</h3>
      <p className="settings-concept-intro__description">和 Agent 一起拆解目标、推进工作，再核对结果。</p>
    </div>
    <div className="settings-concept-intro__art settings-concept-intro__art--goals" aria-hidden="true">
      <img src={goalsArt} alt="" width="1536" height="1024" draggable={false} />
    </div>
  </section>
}
