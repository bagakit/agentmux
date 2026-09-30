import { memo } from 'react'
import { ArrowUpRight, MessageSquare, SquareTerminal } from 'lucide-react'
import { AgentAvatar } from './AgentAvatar'
import type { FocusContext } from '../lib/focus-context'
import { FocusContextMenu } from './FocusContextMenu'

export const FocusContextRow = memo(function FocusContextRow({ context, selected, compact = false, onSelect }: { context: FocusContext; selected: boolean; compact?: boolean; onSelect(id: string): void }) {
  const recap = context.bucket !== 'attention' && context.state !== 'disconnected' ? context.recap : null
  const description = [context.detailIsRecap && context.recap ? null : context.detail, context.recap ? `${context.recap.source} (${context.recap.origin}) · ${context.recap.text}` : null].filter(Boolean).join('\n')
  const card = <button type="button" className={`focus-context${compact ? ' focus-context--compact' : ''}${selected ? ' is-selected' : ''}`} data-session-id={context.id} data-state={context.state} data-bucket={context.bucket} aria-pressed={selected} aria-label={`${context.name} · ${context.stateLabel} · ${description}`} aria-description={context.originAddress} title={`${context.name} · ${context.stateLabel}\n${description}\n${context.workspacePath}${context.originAddress ? `\n${context.originAddress}` : ''}`} onClick={() => onSelect(context.id)}>
    <span className="focus-context__avatar">{context.kind === 'agent' ? <AgentAvatar sessionId={context.id} label={context.name} state={context.state} providerId={context.providerId ?? undefined} size={18} /> : <SquareTerminal size={16} />}</span>
    <span className="focus-context__copy"><span className="focus-context__identity"><strong>{context.name}</strong><span className={`focus-context__state status status--${context.state}`} title={context.stateLabel} aria-hidden="true"><span className="status__dot" /><small>{context.stateLabel}</small></span></span><span className={`focus-context__detail${recap ? ' focus-context__detail--recap' : ''}`}>
      {recap ? <><span className="focus-context__recap" title={`${recap.source} (${recap.origin})`}><MessageSquare size={10} aria-hidden="true" /><span>{recap.text}</span></span>{context.detailIsRecap ? null : <span className="focus-context__activity">{context.detail}</span>}</> : context.detail}
    </span></span>
    <ArrowUpRight className="focus-context__open" size={13} aria-hidden="true" />
  </button>
  return context.kind === 'agent' ? <FocusContextMenu sessionId={context.id}>{card}</FocusContextMenu> : card
})
