import { AgentWorkModeBadge } from './AgentWorkModeBadge'
import type { ReactNode } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { MarkdownExcerpt } from '@agentmux/client-ui/components/MarkdownExcerpt'
import type { FocusContext } from '../lib/focus-context'
import { launcherRecapExcerpt } from '@agentmux/client-ui/conversation-recap'
import { AgentAvatar, ResolvedAgentAvatar } from './AgentAvatar'
import { FocusContextStateMark } from './FocusContextState'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'
import type { FocusTopicHeading } from '../lib/focus-collection-lanes'
import { FocusTopicLabel } from './FocusTopicLabel'

const ThemeObjectTerminalIcon = semanticIconComponent('object.terminal')
const ThemeObjectConversationIcon = semanticIconComponent('object.conversation')

function showsActivity(context: FocusContext, presentation: 'row' | 'card'): boolean {
  return context.detailKind === 'service' && !context.detailIsRecap || presentation === 'card' && context.detailKind === 'observation'
}

/** Shared visibility rule for status and service facts, independent of the surface. */
export function mandatoryAgentContextDetails(context: FocusContext, presentation: 'row' | 'card'): boolean {
  return context.bucket === 'attention' || showsActivity(context, presentation) || context.detailKind === 'observation' || context.activitySemantic === 'unknown' || context.state === 'disconnected'
}

/** Pure held-fact content. Each surface keeps its own button, navigation and disclosures. */
export function AgentContextContent({ context, metadata, identity, headingAccessory, presentation = 'row', disclosure, topic, list = false }: {
  context: FocusContext; metadata?: ReactNode; identity?: ReactNode; headingAccessory?: ReactNode; presentation?: 'row' | 'card'
  disclosure?: { status: number; summary: number } | undefined
  list?: boolean
  topic?: FocusTopicHeading | undefined
}) {
  const active = useWorkbenchPresentationActive()
  // A retained excerpt describes its original record, even after its known Run
  // was interrupted. The adjacent state and service reason keep that distinct
  // from a current reply or a working Agent.
  const recap = !list && context.bucket !== 'attention' ? context.recap : null
  const showActivity = showsActivity(context, presentation)
  const mandatory = mandatoryAgentContextDetails(context, presentation)
  const status = mandatory ? 1 : disclosure?.status ?? 1, summary = mandatory ? 1 : disclosure?.summary ?? 1
  const avatar = identity ?? <span className="focus-context__avatar focus-context__avatar--compact-content" inert aria-hidden="true">{context.kind === 'agent' ? context.access ? <ResolvedAgentAvatar label={context.name} providerId={context.providerId ?? undefined} executorId={context.executorId} state={context.state} size={18} /> : <AgentAvatar sessionId={active ? context.id : undefined} executorId={context.executorId} label={context.name} state={context.state} providerId={context.providerId ?? undefined} size={18} visible={false} /> : <ThemeObjectTerminalIcon size={16} />}</span>
  return <>
    {presentation === 'row' ? avatar : null}
    <span className="focus-context__copy">
      {topic ? <FocusTopicLabel topic={topic} /> : null}
      <span className="focus-context__identity">{presentation === 'card' ? avatar : null}<strong>{context.name}</strong>{context.kind === 'agent' && !context.access ? <AgentWorkModeBadge source={context} embedded /> : null}{metadata}{headingAccessory}<span className="focus-context__state" style={disclosure ? { opacity: status } : undefined} title={context.detailKind === 'observation' ? context.detail : context.stateLabel} aria-hidden={context.detailKind === 'observation' ? undefined : true}><FocusContextStateMark context={context} /><small>{presentation !== 'card' && context.detailKind === 'observation' ? context.detail : context.stateLabel}</small></span></span>
      {(!list || mandatory && context.detail && context.detail !== context.stateLabel) && <span className={`focus-context__detail${recap ? ' focus-context__detail--recap' : ''}${showActivity ? ' focus-context__detail--service' : ''}`} style={disclosure ? { opacity: summary } : undefined} aria-hidden={summary === 0 || undefined}>
        {recap ? <><span className="focus-context__recap" title={`${recap.source} (${recap.origin})`}>{presentation === 'row' ? <ThemeObjectConversationIcon size={10} aria-hidden="true" /> : null}<MarkdownExcerpt content={launcherRecapExcerpt(recap)} /></span>{showActivity ? <span className="focus-context__activity">{context.detail}</span> : null}</> : presentation !== 'card' && context.detailKind === 'observation' ? context.stateLabel : context.detail}
      </span>}
    </span>
  </>
}
