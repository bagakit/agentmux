import type { AgentMuxMessagePrefix } from '@agentmux/core/agent-message-render'
import { browserInputContextJson, type BrowserInputContext, type BrowserInputContextSource } from '@agentmux/core/browser-input-context'
import { memo, type ComponentProps } from 'react'
import { SemanticIcon } from '../theme/icons.js'
import { AgentMarkdown } from './AgentMarkdown.js'
import { ConversationBrowserContext } from './ConversationBrowserContext.js'

const Markdown = memo(AgentMarkdown)
type MarkdownProps = Omit<ComponentProps<typeof AgentMarkdown>, 'content' | 'className'>

/** One reading face for complete input text and explicitly opened text resources.
 * Core owns parsing; these spans are declarations and never establish authorship.
 * Full Copy continues to use the original content, independently of this face.
 */
export function ConversationInputText({ text, prefix, inputContext, inputContextSource, ...markdown }: MarkdownProps & {
  text: string
  prefix?: AgentMuxMessagePrefix | null
  inputContext?: BrowserInputContext | undefined
  inputContextSource?: BrowserInputContextSource | undefined
}) {
  const body = prefix ? prefix.declaredContexts && !prefix.sourceLabel
    ? prefix.body.replace(/^(?:\r?\n){1,2}/u, '') : prefix.body : text
  // Only the same original structured context can qualify the declaration's producer.
  // A different wire declaration stays declared and does not borrow another observation's source.
  const recorded = inputContext ? browserInputContextJson(inputContext) : null
  const matching = prefix?.declaredContexts?.findIndex(context => context.inputContext && browserInputContextJson(context.inputContext) === recorded) ?? -1
  return <>
    {inputContext && matching < 0 ? <ConversationBrowserContext context={inputContext} source={inputContextSource} /> : null}
    {prefix?.declaredContexts?.map((context, index) => context.inputContext
      ? <ConversationBrowserContext key={index} context={context.inputContext} source={index === matching ? inputContextSource ?? 'caller-declared' : 'caller-declared'} raw={context.raw} />
      : <details key={index} className="log-turn__declared-context">
      <summary><SemanticIcon name="navigation.disclosure" size={12} aria-hidden="true" />Declared context{prefix.declaredContexts!.length > 1 ? ` ${index + 1}` : ''}</summary>
      <pre>{context.raw}</pre>
    </details>)}
    {prefix?.kind === 'references' ? <section className="log-turn__references" aria-label="A2A message references">
      <p>A2A Inbox references</p>
      <ul>{prefix.references.map((reference, index) => <li key={index}>
        <span>Declared source <code>{reference.declaredAgentSessionId}</code></span>
        <span>Message <code>{reference.declaredMessageId}</code></span>
      </li>)}</ul>
      <p className="log-turn__references-hint">Read originals via <code>{`"$AGENTMUX_CLI" ${prefix.references[0]!.readVia}`}</code></p>
    </section> : prefix?.packet ? prefix.packet.parts.map((part, index) => part.kind === 'text'
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
