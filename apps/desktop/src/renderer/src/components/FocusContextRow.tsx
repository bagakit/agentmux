import { memo } from 'react'
import { ArrowUpRight, SquareTerminal } from 'lucide-react'
import { AgentAvatar } from './AgentAvatar'
import type { FocusContext } from '../lib/focus-context'

export const FocusContextRow = memo(function FocusContextRow({ context, selected, onSelect }: { context: FocusContext; selected: boolean; onSelect(id: string): void }) {
  return <button type="button" className={`focus-context${selected ? ' is-selected' : ''}`} data-session-id={context.id} data-state={context.state} data-bucket={context.bucket} aria-pressed={selected} title={`${context.name}\n${context.detail}\n${context.workspacePath}`} onClick={() => onSelect(context.id)}>
    <span className="focus-context__avatar">{context.kind === 'agent' ? <AgentAvatar sessionId={context.id} label={context.name} state={context.state} providerId={context.providerId ?? undefined} size={18} /> : <SquareTerminal size={16} />}</span>
    <span className="focus-context__copy"><span className="focus-context__identity"><strong>{context.name}</strong><small>{context.stateLabel}</small></span><span className="focus-context__detail">{context.detail}</span></span>
    <ArrowUpRight className="focus-context__open" size={13} aria-hidden="true" />
  </button>
})
