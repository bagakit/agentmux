import { AMUX_PROTOCOL_DEFINITIONS, type AmuxProtocolDeclaration } from '@agentmux/core/agent-message-render'
import type { ReactNode, ComponentProps } from 'react'
import { SemanticIcon } from '../theme/icons.js'

/** A reading surface inside the original message. It owns no business actions or author facts. */
export function ConversationProtocolCard({ title, tag, kind, icon = 'file.code', raw, children }: {
  title: string
  tag: string
  kind: string
  icon?: ComponentProps<typeof SemanticIcon>['name']
  raw?: string | undefined
  children?: ReactNode
}) {
  return <section className="conversation-protocol" data-protocol-kind={kind} aria-label={title}>
    <header className="conversation-protocol__header"><SemanticIcon name={icon} size={14} aria-hidden="true" />
      <strong>{title}</strong><code>{tag}</code></header>
    {children}
    {raw === undefined ? null : <details className="conversation-protocol__original">
      <summary><SemanticIcon name="navigation.disclosure" size={12} aria-hidden="true" />Original protocol</summary><pre>{raw}</pre>
    </details>}
  </section>
}

export function ConversationAmuxProtocol({ declaration }: { declaration: AmuxProtocolDeclaration }) {
  const definition = declaration.id ? AMUX_PROTOCOL_DEFINITIONS[declaration.id] : undefined
  return <ConversationProtocolCard title={definition?.title ?? 'Protocol declaration'} tag={declaration.tag} kind={declaration.id ?? 'generic'}
    icon={declaration.id === 'continue' ? 'action.resume' : declaration.id === 'reaction' ? 'conversation.user-message' : 'file.code'} raw={declaration.raw}>
    {declaration.code ? <code className="conversation-protocol__keyword">{declaration.code}</code> : null}
    {definition ? <p className="conversation-protocol__description">{definition.description}</p> : null}
    {declaration.attributes.length ? <dl className="conversation-protocol__attributes">{declaration.attributes.map(attribute =>
      <div key={attribute.name}><dt>{attribute.name}</dt><dd>{attribute.value}</dd></div>)}</dl> : null}
    {declaration.body ? <pre className="conversation-protocol__body">{declaration.body}</pre> : null}
  </ConversationProtocolCard>
}
