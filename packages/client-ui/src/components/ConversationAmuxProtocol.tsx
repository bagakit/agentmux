import { AMUX_PROTOCOL_DEFINITIONS, type AmuxProtocolDeclaration } from '@agentmux/core/agent-message-render'
import type { ReactNode, ComponentProps } from 'react'
import { SemanticIcon } from '../theme/icons.js'
import { formatAmuxObjectLink } from '@agentmux/core/sharing'
import { useObjectLinkRenderer } from '../platform.js'
import { objectLinkReference } from '../lib/object-link-reference.js'

/** A reading surface inside the original message. It owns no business actions or author facts. */
export function ConversationProtocolCard({ title, tag, kind, icon = 'file.code', raw, sourceFacts, children }: {
  title: string
  tag?: string
  kind: string
  icon?: ComponentProps<typeof SemanticIcon>['name']
  sourceFacts?: ReactNode
  raw?: string | undefined
  children?: ReactNode
}) {
  return <section className="conversation-protocol" data-protocol-kind={kind} aria-label={title}>
    <header className="conversation-protocol__header"><SemanticIcon name={icon} size={14} aria-hidden="true" />
      <span className="conversation-protocol__title">{title}</span>{tag ? <code>{tag}</code> : null}</header>
    {children}
    {raw === undefined ? null : <details className="conversation-protocol__original">
      <summary><SemanticIcon name="navigation.disclosure" size={12} aria-hidden="true" />Original protocol</summary>{sourceFacts}<pre>{raw}</pre>
    </details>}
  </section>
}

/** The answer leads; the question is its context. Reading it never proves who answered or that it was adopted. */
function CapsuleAnswerCard({ declaration, answer }: { declaration: AmuxProtocolDeclaration; answer: NonNullable<AmuxProtocolDeclaration['capsuleAnswer']> }) {
  const renderObjectLink = useObjectLinkRenderer()
  const page = objectLinkReference(formatAmuxObjectLink({ kind: 'capsule', capsuleId: answer.capsuleId }), 'Open page')
  return <ConversationProtocolCard title={AMUX_PROTOCOL_DEFINITIONS['capsule-answer'].title} tag={declaration.tag} kind="capsule-answer" icon="object.browser" raw={declaration.raw}>
    <p className="conversation-capsule-answer__question">{answer.question}</p>
    <p className="conversation-capsule-answer__answer">{answer.answer}</p>
    {page && renderObjectLink ? <div className="conversation-capsule-answer__page">{renderObjectLink(page)}</div> : null}
  </ConversationProtocolCard>
}

export function ConversationAmuxProtocol({ declaration }: { declaration: AmuxProtocolDeclaration }) {
  if (declaration.capsuleAnswer) return <CapsuleAnswerCard declaration={declaration} answer={declaration.capsuleAnswer} />
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
