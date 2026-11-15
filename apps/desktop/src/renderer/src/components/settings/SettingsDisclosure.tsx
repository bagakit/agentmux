import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { ReactNode } from 'react'
import './settings-disclosure.css'

const Chevron = semanticIconComponent('navigation.disclosure')

/** Keep original editors mounted when their secondary settings are folded. */
export function SettingsDisclosure({ title, description, children, onOpenChange }: {
  title: string
  description: string
  children: ReactNode
  onOpenChange?(open: boolean): void
}) {
  return <details className="settings-disclosure" onToggle={event => onOpenChange?.(event.currentTarget.open)}>
    <summary>
      <span><strong>{title}</strong><small>{description}</small></span>
      <Chevron size={16} aria-hidden="true" />
    </summary>
    <div className="settings-disclosure__body">{children}</div>
  </details>
}
