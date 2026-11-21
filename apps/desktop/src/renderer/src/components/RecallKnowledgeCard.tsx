import type { ReactNode } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import '../styles/recall-knowledge-card.css'

const Reference = semanticIconComponent('object.link')
const Forward = semanticIconComponent('navigation.forward')

/** Shared presentation for a saved knowledge card. Consumers supply exact navigation. */
export function RecallKnowledgeCard({ title, reference, children, showTitle = true }: { title: string; showTitle?: boolean; reference: ReactNode; children?: ReactNode }) {
  return <article className="recall-knowledge-card" aria-label={title}>
    {showTitle ? <strong className="recall-knowledge-card__title">{title}</strong> : null}
    {reference}
    {children}
  </article>
}

export function RecallCardReference({ label, openLabel, onOpen }: { label: string; openLabel: string; onOpen: (document: Document) => void }) {
  return <button type="button" className="recall-knowledge-card__reference" aria-label={openLabel} onClick={event => onOpen(event.currentTarget.ownerDocument)}>
    <Reference size={14} aria-hidden="true" />
    <span>{label}</span>
    <Forward size={13} aria-hidden="true" />
  </button>
}
