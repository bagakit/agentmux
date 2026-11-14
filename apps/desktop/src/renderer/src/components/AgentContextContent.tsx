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

/** Identity used by both the detailed card and the compact task line. */
export function AgentContextAvatar({ context, placeholder = false }: { context: FocusContext; placeholder?: boolean }) {
  const active = useWorkbenchPresentationActive()
  const providerId = context.providerId ?? undefined
  return <span className="focus-context__avatar focus-context__avatar--compact-content" inert aria-hidden="true">
    {context.kind !== 'agent' ? <ThemeObjectTerminalIcon size={16} /> : context.access || placeholder
      ? <ResolvedAgentAvatar label={context.name} providerId={providerId} executorId={context.executorId} state={context.state} size={18} />
      : <AgentAvatar sessionId={active ? context.id : undefined} label={context.name} providerId={providerId} executorId={context.executorId} state={context.state} size={18} visible={false} />}
  </span>
}

/** Pure held-fact content. Each surface keeps its own button, navigation and disclosures. */
export function AgentContextContent({ context, metadata, identity, headingAccessory, presentation = 'row', disclosure, topic }: {
  context: FocusContext; metadata?: ReactNode; identity?: ReactNode; headingAccessory?: ReactNode; presentation?: 'row' | 'card'
  disclosure?: { status: number; summary: number } | undefined
  topic?: FocusTopicHeading | undefined
}) {
  // A retained excerpt describes its original record, even after its known Run
  // was interrupted. The adjacent state and service reason keep that distinct
  // from a current reply or a working Agent.
  const recap = context.bucket !== 'attention' ? context.recap : null
  const showActivity = showsActivity(context, presentation)
  const mandatory = mandatoryAgentContextDetails(context, presentation)
  const status = mandatory ? 1 : disclosure?.status ?? 1, summary = mandatory ? 1 : disclosure?.summary ?? 1
  const avatar = identity ?? <AgentContextAvatar context={context} />
  return <>
    {presentation === 'row' ? avatar : null}
    <span className="focus-context__copy">
      {topic ? <FocusTopicLabel topic={topic} /> : null}
      <span className="focus-context__identity">{presentation === 'card' ? avatar : null}<strong>{context.name}</strong>{context.kind === 'agent' && !context.access ? <AgentWorkModeBadge source={context} embedded /> : null}{metadata}{headingAccessory}<span className="focus-context__state" style={disclosure ? { opacity: status } : undefined} title={context.detailKind === 'observation' ? context.detail : context.stateLabel} aria-hidden={context.detailKind === 'observation' ? undefined : true}><FocusContextStateMark context={context} /><small>{presentation !== 'card' && context.detailKind === 'observation' ? context.detail : context.stateLabel}</small></span></span>
      <span className={`focus-context__detail${recap ? ' focus-context__detail--recap' : ''}${showActivity ? ' focus-context__detail--service' : ''}`} style={disclosure ? { opacity: summary } : undefined} aria-hidden={summary === 0 || undefined}>
        {recap ? <><span className="focus-context__recap" title={`${recap.source} (${recap.origin})`}>{presentation === 'row' ? <ThemeObjectConversationIcon size={10} aria-hidden="true" /> : null}<MarkdownExcerpt content={launcherRecapExcerpt(recap)} /></span>{showActivity ? <span className="focus-context__activity">{context.detail}</span> : null}</> : presentation !== 'card' && context.detailKind === 'observation' ? context.stateLabel : context.detail}
      </span>
    </span>
  </>
}
