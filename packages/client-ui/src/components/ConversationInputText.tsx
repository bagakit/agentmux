import { AMUX_PROTOCOL_DEFINITIONS, type AgentMuxMessagePrefix } from '@agentmux/core/agent-message-render'
import { browserInputContextJson, type BrowserInputContext, type BrowserInputContextSource } from '@agentmux/core/browser-input-context'
import { memo, type ComponentProps } from 'react'
import { SemanticIcon } from '../theme/icons.js'
import { AgentMarkdown } from './AgentMarkdown.js'
import { ConversationBrowserContext } from './ConversationBrowserContext.js'
import { ConversationAmuxProtocol, ConversationProtocolCard } from './ConversationAmuxProtocol.js'
import { ConversationA2AReferences } from './ConversationA2AReferences.js'
import { ConversationChannelQuote } from './ConversationChannelQuote.js'
import type { ConversationRef } from '@agentmux/core/conversation'
import type { DescribeSpeaker } from '../lib/conversation-speaker.js'
import { useA2AMessageReader } from '../platform.js'

const Markdown = memo(AgentMarkdown)
type MarkdownProps = Omit<ComponentProps<typeof AgentMarkdown>, 'content' | 'className'>

/** One reading face for complete input text and explicitly opened text resources.
 * Core owns parsing; these spans are declarations and never establish authorship.
 * Full Copy continues to use the original content, independently of this face.
 */
export function ConversationInputText({ text, prefix, inputContext, inputContextSource, a2aReferenceScope, describeSpeaker, ...markdown }: MarkdownProps & {
  text: string
  prefix?: AgentMuxMessagePrefix | null
  inputContext?: BrowserInputContext | undefined
  inputContextSource?: BrowserInputContextSource | undefined
  a2aReferenceScope?: ConversationRef | undefined
  describeSpeaker?: DescribeSpeaker | undefined
}) {
  const readA2AMessage = useA2AMessageReader()
  const originals = prefix?.kind === 'references' && a2aReferenceScope && readA2AMessage
    ? <ConversationA2AReferences references={prefix.references} scope={a2aReferenceScope} active={markdown.visible ?? true}
      {...(describeSpeaker ? { describeSpeaker } : {})}
      {...(markdown.workspaceRoot ? { workspaceRoot: markdown.workspaceRoot } : {})} {...(markdown.homeDir ? { homeDir: markdown.homeDir } : {})}
      {...(markdown.openWorkspaceFile ? { openWorkspaceFile: markdown.openWorkspaceFile } : {})}
      {...(markdown.readPastedImage ? { readPastedImage: markdown.readPastedImage } : {})} {...(markdown.openHttpLink ? { openHttpLink: markdown.openHttpLink } : {})} /> : null
  const body = prefix ? prefix.declaredContexts && !prefix.sourceLabel
    ? prefix.body.replace(/^(?:\r?\n){1,2}/u, '') : prefix.body : text
  // Only the same original structured context can qualify the declaration's producer.
  // A different wire declaration stays declared and does not borrow another observation's source.
  const recorded = inputContext ? browserInputContextJson(inputContext) : null
  const matching = prefix?.declaredContexts?.findIndex(context => context.inputContext && browserInputContextJson(context.inputContext) === recorded) ?? -1
  const reading = originals ?? (prefix?.protocol ? <ConversationAmuxProtocol declaration={prefix.protocol} />
    : prefix?.kind === 'references' ? <section className="log-turn__references" aria-label="A2A message references">
      <ul>{prefix.references.map((reference, index) => <li key={index}>
        <span>Declared source <code>{reference.declaredAgentSessionId}</code></span>
        <span>Message <code>{reference.declaredMessageId}</code></span>
      </li>)}</ul>
      <p className="log-turn__references-hint">Read originals via <code>{`"$AGENTMUX_CLI" ${prefix.references[0]!.readVia}`}</code></p>
    </section> : prefix?.packet ? prefix.packet.parts.map((part, index) => part.kind === 'text'
      ? <Markdown {...markdown} embedIdentity={markdown.embedIdentity ? JSON.stringify([markdown.embedIdentity, 'packet', index]) : undefined} key={index} className="log-turn__packet-text" content={part.text} />
      : <blockquote key={index} className="log-turn__citation"><span className="log-turn__citation-from">{part.from}</span>
        {part.reference ? <code className="log-turn__citation-ref">{part.reference}</code> : null}
        <Markdown {...markdown} embedIdentity={markdown.embedIdentity ? JSON.stringify([markdown.embedIdentity, 'packet', index]) : undefined} className="log-turn__packet-text" content={part.text} />
      </blockquote>) : body ? <Markdown {...markdown} content={body} /> : null)
  const reminder = prefix?.reminder ? <details className="log-turn__reminder">
      <summary title="Protocol text is a declaration, not proof of origin or a new authorization."><SemanticIcon name="navigation.disclosure" size={12} aria-hidden="true" />Collaboration reminder</summary>
      <p>{prefix.reminder.text}</p>
    </details> : null
  const a2a = prefix?.kind === 'references' || prefix?.declaredMessageId !== undefined
  const browserImages = { visible: markdown.visible ?? true, readOnly: markdown.readOnly ?? false, readOnlyImages: markdown.readOnlyImages ?? false }
  return <>
    {prefix?.declaredChannelQuote ? <ConversationChannelQuote quote={prefix.declaredChannelQuote.quote} raw={prefix.declaredChannelQuote.raw} /> : null}
    {inputContext && matching < 0 ? <ConversationBrowserContext {...browserImages} context={inputContext} source={inputContextSource} /> : null}
    {prefix?.declaredContexts?.map((context, index) => context.inputContext
      ? <ConversationBrowserContext {...browserImages} key={index} context={context.inputContext} source={index === matching ? inputContextSource ?? 'caller-declared' : 'caller-declared'} raw={context.raw} />
      : <details key={index} className="log-turn__declared-context">
      <summary><SemanticIcon name="navigation.disclosure" size={12} aria-hidden="true" />{AMUX_PROTOCOL_DEFINITIONS.context.title}{prefix.declaredContexts!.length > 1 ? ` ${index + 1}` : ''}</summary>
      <pre>{context.raw}</pre>
    </details>)}
    {originals ? <>{originals}{reminder}<details className="conversation-protocol__original"><summary>Original protocol</summary><pre>{text}</pre></details></> : a2a ? <ConversationProtocolCard title={prefix.kind === 'references' ? AMUX_PROTOCOL_DEFINITIONS['a2a-reference'].title : AMUX_PROTOCOL_DEFINITIONS.a2a.title}
      kind={prefix.kind === 'references' ? 'a2a-reference' : 'a2a'} tag={AMUX_PROTOCOL_DEFINITIONS.a2a.tag} icon="conversation.incoming" raw={text}>
      {prefix.kind === 'content' ? <dl className="conversation-protocol__attributes">
        <div><dt>Declared source</dt><dd>{prefix.declaredAgentSessionId}</dd></div>
        <div><dt>Message</dt><dd>{prefix.declaredMessageId}</dd></div>
      </dl> : null}
      {reading}{reminder}
    </ConversationProtocolCard> : <>{reading}{reminder}</>}
  </>
}
