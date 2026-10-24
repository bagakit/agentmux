import type { ReactNode } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { MarkdownExcerpt } from '@agentmux/client-ui/components/MarkdownExcerpt'
import type { FocusContext } from '../lib/focus-context'
import { launcherRecapExcerpt } from '@agentmux/client-ui/conversation-recap'
import { AgentAvatar } from './AgentAvatar'
import { FocusContextStateMark } from './FocusContextState'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'

const ThemeObjectTerminalIcon = semanticIconComponent('object.terminal')
const ThemeObjectConversationIcon = semanticIconComponent('object.conversation')


/** Pure held-fact content. Each surface keeps its own button, navigation and disclosures. */
export function AgentContextContent({ context, metadata, identity, headingAccessory, presentation = 'row', disclosure }: {
  context: FocusContext; metadata?: ReactNode; identity?: ReactNode; headingAccessory?: ReactNode; presentation?: 'row' | 'card'
  disclosure?: { status: number; summary: number } | undefined
}) {
  const active = useWorkbenchPresentationActive()
  const recap = context.bucket !== 'attention' && context.state !== 'disconnected' && (context.processState === 'running' || context.processState === 'exited') && !context.runUnobserved ? context.recap : null
  const showActivity = context.detailKind === 'service' && !context.detailIsRecap
  const mandatory = context.bucket === 'attention' || showActivity || context.detailKind === 'observation' || context.activitySemantic === 'unknown' || context.state === 'disconnected'
  const status = mandatory ? 1 : disclosure?.status ?? 1, summary = mandatory ? 1 : disclosure?.summary ?? 1
  const avatar = identity ?? <span className="focus-context__avatar focus-context__avatar--compact-content" inert aria-hidden="true">{context.kind === 'agent' ? <AgentAvatar sessionId={active ? context.id : undefined} executorId={context.executorId} label={context.name} state={context.state} providerId={context.providerId ?? undefined} size={18} visible={false} /> : <ThemeObjectTerminalIcon size={16} />}</span>
  return <>
    {presentation === 'row' ? avatar : null}
    <span className="focus-context__copy">
      <span className="focus-context__identity">{presentation === 'card' ? avatar : null}<strong>{context.name}</strong>{metadata}{headingAccessory}<span className="focus-context__state" style={disclosure ? { opacity: status } : undefined} title={context.detailKind === 'observation' ? context.detail : context.stateLabel} aria-hidden={context.detailKind === 'observation' ? undefined : true}><FocusContextStateMark context={context} /><small>{context.detailKind === 'observation' ? context.detail : context.stateLabel}</small></span></span>
      <span className={`focus-context__detail${recap ? ' focus-context__detail--recap' : ''}${showActivity ? ' focus-context__detail--service' : ''}`} style={disclosure ? { opacity: summary } : undefined} aria-hidden={summary === 0 || undefined}>
        {recap ? <><span className="focus-context__recap" title={`${recap.source} (${recap.origin})`}>{presentation === 'row' ? <ThemeObjectConversationIcon size={10} aria-hidden="true" /> : null}<MarkdownExcerpt content={launcherRecapExcerpt(recap)} /></span>{showActivity ? <span className="focus-context__activity">{context.detail}</span> : null}</> : context.detailKind === 'observation' ? context.stateLabel : context.detail}
      </span>
    </span>
  </>
}
