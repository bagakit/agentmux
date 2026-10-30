import { SemanticIcon, type SemanticIconId } from '@agentmux/client-ui/icons'
import { useId, type ReactNode } from 'react'
import './settings-concept-summary.css'

/** Read-only product meaning. The original pane owns every action and saved fact. */
export function SettingsConceptSummary({ icon, title, description, steps, action }: {
  icon: SemanticIconId
  title: string
  description: string
  steps?: readonly { label: string; detail: string }[]
  action?: ReactNode
}) {
  const heading = useId()
  return <section className="settings-concept-summary" aria-labelledby={heading}>
    <div className="settings-concept-summary__heading">
      <span className="settings-concept-summary__symbol"><SemanticIcon name={icon} size={22} aria-hidden="true" /></span>
      <div><h3 id={heading}>{title}</h3><p>{description}</p></div>
      {action ? <div className="settings-concept-summary__action">{action}</div> : null}
    </div>
    {steps?.length ? <ol className="settings-concept-summary__steps">{steps.map((step, index) => <li key={step.label}>
      <span aria-hidden="true">{index + 1}</span><div><strong>{step.label}</strong><small>{step.detail}</small></div>
    </li>)}</ol> : null}
  </section>
}
