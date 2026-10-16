import type { AgentMuxMessagePrefix } from '@agentmux/core/agent-message-render'
import { memo, type ComponentProps } from 'react'
import { SemanticIcon } from '../theme/icons.js'
import { AgentMarkdown } from './AgentMarkdown.js'

const Markdown = memo(AgentMarkdown)
type MarkdownProps = Omit<ComponentProps<typeof AgentMarkdown>, 'content' | 'className'>

/** One reading face for complete input text and explicitly opened text resources.
 * Core owns parsing; these spans are declarations and never establish authorship.
 * Full Copy continues to use the original content, independently of this face.
 */
export function ConversationInputText({ text, prefix, ...markdown }: MarkdownProps & {
  text: string
  prefix?: AgentMuxMessagePrefix | null
}) {
  const body = prefix ? prefix.declaredContexts && !prefix.sourceLabel
    ? prefix.body.replace(/^(?:\r?\n){1,2}/u, '') : prefix.body : text
  return <>
    {prefix?.declaredContexts?.map((context, index) => <details key={index} className="log-turn__declared-context">
      <summary><SemanticIcon name="navigation.disclosure" size={12} aria-hidden="true" />Declared context{prefix.declaredContexts!.length > 1 ? ` ${index + 1}` : ''}</summary>
      <pre>{context.raw}</pre>
    </details>)}
    {prefix?.packet ? prefix.packet.parts.map((part, index) => part.kind === 'text'
      ? <Markdown {...markdown} key={index} className="log-turn__packet-text" content={part.text} />
      : <blockquote key={index} className="log-turn__citation"><span className="log-turn__citation-from">{part.from}</span>
        {part.reference ? <code className="log-turn__citation-ref">{part.reference}</code> : null}
        <Markdown {...markdown} className="log-turn__packet-text" content={part.text} />
      </blockquote>) : body ? <Markdown {...markdown} content={body} /> : null}
    {prefix?.reminder ? <details className="log-turn__reminder">
      <summary title="Protocol text is a declaration, not proof of origin or a new authorization."><SemanticIcon name="navigation.disclosure" size={12} aria-hidden="true" />Collaboration reminder</summary>
      <p>{prefix.reminder.text}</p>
    </details> : null}
  </>
}
