import { useId } from 'react'
import capsuleArt from '@agentmux/client-ui/brand/illustrations/concepts/capsule-keepsake.png'
import goalsArt from '@agentmux/client-ui/brand/illustrations/concepts/goals-companions.png'
import spaceArt from '@agentmux/client-ui/brand/illustrations/concepts/space-workchamber.png'
import focusArt from '@agentmux/client-ui/brand/illustrations/concepts/focus-workframe.png'
import recallArt from '@agentmux/client-ui/brand/illustrations/concepts/recall-fold.png'
import './settings-concept-intro.css'

/** Read-only illustrations. Configuration and execution remain with each pane. */
export function RecallIntroduction() {
  const titleId = useId()
  return <section className="settings-concept-intro settings-concept-intro--workview" data-concept="recall" aria-labelledby={titleId}>
    <div className="settings-concept-intro__copy">
      <h3 className="settings-concept-intro__title" id={titleId}>Keep useful knowledge close.</h3>
      <p className="settings-concept-intro__description">Organize notes, pages and sources so you can return to what matters.</p>
    </div>
    <div className="settings-concept-intro__art" aria-hidden="true">
      <img src={recallArt} alt="" width="1536" height="1024" loading="lazy" decoding="async" draggable={false} />
    </div>
  </section>
}

export function SpaceIntroduction() {
  const titleId = useId()
  return <section className="settings-concept-intro settings-concept-intro--workview" data-concept="space" aria-labelledby={titleId}>
    <div className="settings-concept-intro__copy">
      <h3 className="settings-concept-intro__title" id={titleId}>Give your work a place.</h3>
      <p className="settings-concept-intro__description">Keep Agents, files and pages together. Arrange them side by side as you work.</p>
    </div>
    <div className="settings-concept-intro__art" aria-hidden="true">
      <img src={spaceArt} alt="" width="1536" height="1024" loading="lazy" decoding="async" draggable={false} />
    </div>
  </section>
}

export function FocusIntroduction() {
  const titleId = useId()
  return <section className="settings-concept-intro settings-concept-intro--workview" data-concept="focus" aria-labelledby={titleId}>
    <div className="settings-concept-intro__copy">
      <h3 className="settings-concept-intro__title" id={titleId}>See what needs you now.</h3>
      <p className="settings-concept-intro__description">See work in progress and requests for your attention. Return to the same context.</p>
    </div>
    <div className="settings-concept-intro__art" aria-hidden="true">
      <img src={focusArt} alt="" width="1254" height="1254" loading="lazy" decoding="async" draggable={false} />
    </div>
  </section>
}

export function CapsuleIntroduction() {
  const titleId = useId()
  return <section className="settings-concept-intro" data-concept="capsule" aria-labelledby={titleId}>
    <div className="settings-concept-intro__copy">
      <span className="settings-concept-intro__eyebrow">From a result to a useful tool</span>
      <h3 className="settings-concept-intro__title" id={titleId}>Keep the pages that work for you.</h3>
      <p className="settings-concept-intro__description">Save a page made by an Agent as a Capsule and open it again when you need it.</p>
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
      <span className="settings-concept-intro__eyebrow">A shared direction for the work</span>
      <h3 className="settings-concept-intro__title" id={titleId}>Turn an intention into progress.</h3>
      <p className="settings-concept-intro__description">Break down a goal with Agents, work through it and review the results.</p>
    </div>
    <div className="settings-concept-intro__art settings-concept-intro__art--goals" aria-hidden="true">
      <img src={goalsArt} alt="" width="1536" height="1024" draggable={false} />
    </div>
  </section>
}
