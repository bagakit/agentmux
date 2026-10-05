import type { ReactNode } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { FocusContext } from '../lib/focus-context'
import { AgentAvatar } from './AgentAvatar'
import { FocusContextStateMark } from './FocusContextState'

const ThemeObjectTerminalIcon = semanticIconComponent('object.terminal')
const ThemeObjectConversationIcon = semanticIconComponent('object.conversation')


/** Pure held-fact content. Each surface keeps its own button, navigation and disclosures. */
export function AgentContextContent({ context, metadata }: { context: FocusContext; metadata?: ReactNode }) {
  const recap = context.bucket !== 'attention' && context.state !== 'disconnected' && context.processState === 'running' && !context.runUnobserved ? context.recap : null
  const showActivity = context.detailKind === 'service' && !context.detailIsRecap
  return <>
    <span className="focus-context__avatar focus-context__avatar--compact-content" inert aria-hidden="true">{context.kind === 'agent' ? <AgentAvatar sessionId={context.id} label={context.name} state={context.state} providerId={context.providerId ?? undefined} size={18} visible={false} /> : <ThemeObjectTerminalIcon size={16} />}</span>
    <span className="focus-context__copy">
      <span className="focus-context__identity"><strong>{context.name}</strong><span className="focus-context__state" title={context.stateLabel} aria-hidden="true"><FocusContextStateMark context={context} /><small>{context.stateLabel}</small></span>{metadata}</span>
      <span className={`focus-context__detail${recap ? ' focus-context__detail--recap' : ''}${showActivity ? ' focus-context__detail--service' : ''}`}>
        {recap ? <><span className="focus-context__recap" title={`${recap.source} (${recap.origin})`}><ThemeObjectConversationIcon size={10} aria-hidden="true" /><span>{recap.displayText ?? recap.text}</span></span>{showActivity ? <span className="focus-context__activity">{context.detail}</span> : null}</> : context.detail}
      </span>
    </span>
  </>
}
