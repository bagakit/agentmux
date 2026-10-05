import { memo, useMemo } from 'react'
import type { ToolkitAgentCard as Card, ToolkitAgentCardField, ToolkitResultDocument } from '@agentmux/core/control'
import { useAppStore } from '../../store'
import { createToolkitAgentCardSelector, toolkitAgentCardKey, type ToolkitAgentCardFacts } from '../../lib/toolkit-agent-card-facts'
import { ResolvedAgentAvatar } from '../AgentAvatar'
import { agentProviderLabel } from '../AgentProviderIcon'

export { toolkitAgentCardKey, type ToolkitAgentCardFacts }

export function useToolkitAgentCards(items: readonly Card[], fields: readonly ToolkitAgentCardField[], active = true) {
  const references = JSON.stringify(items.map(card => card.reference)), selection = JSON.stringify(fields)
  const select = useMemo(() => createToolkitAgentCardSelector(JSON.parse(references), JSON.parse(selection), active), [references, selection, active])
  return useAppStore(select)
}

/** Data-only cards share the standard face; this presenter has no Store, API or input owner. */
type CardProps = {
  card: Card; fields: readonly ToolkitAgentCardField[]; resolvedFacts?: ToolkitAgentCardFacts | undefined
}
export const ToolkitAgentCard = memo(function ToolkitAgentCard({ card, fields, resolvedFacts }: CardProps) {
  const shown = new Set(fields), facts = resolvedFacts
  const resolved = facts?.state === 'resolved'
  return <span className="toolkit-agent-card" data-toolkit-agent-card={toolkitAgentCardKey(card.reference)} data-agent-card-state={facts?.state ?? 'unavailable'}>
    {shown.size ? <span className="toolkit-agent-card__identity">
      {resolved ? <>
        {shown.has('avatar') && facts.provider ? <span data-card-field="avatar"><ResolvedAgentAvatar label={facts.name ?? 'Agent'} providerId={facts.provider} state={facts.status} appearance={facts.appearance} executorId={facts.executorId} /></span> : null}
        {shown.has('name') ? <strong className="toolkit-agent-card__name" data-card-field="name" title={facts.name}>{facts.name}</strong> : null}
        <span className="toolkit-agent-card__facts">
          {shown.has('status') ? <span data-card-field="status">{facts.statusLabel}</span> : null}
          {shown.has('provider') ? <span data-card-field="provider">{agentProviderLabel(facts.provider ?? '')}</span> : null}
          {shown.has('workspace') ? <span data-card-field="workspace" title={facts.workspace}>{facts.workspace}</span> : null}
          {shown.has('host') ? <span data-card-field="host">{facts.host}</span> : null}
          {shown.has('sessionId') ? <span data-card-field="sessionId">{facts.sessionId}</span> : null}
          {shown.has('runId') ? <span data-card-field="runId">{facts.runId}</span> : null}
        </span>
      </> : <span className="toolkit-agent-card__name">{facts?.reason ?? 'Agent identity unavailable'}<small>{card.reference.hostId} · {card.reference.kind === 'session' ? card.reference.sessionId : card.reference.runId}</small></span>}
    </span> : null}
    {card.metrics.length ? <span className="toolkit-agent-card__metrics">{card.metrics.map((metric, index) => <span key={index} data-toolkit-card-metric><span>{metric.label}</span><strong>{metric.value}</strong></span>)}</span> : null}
  </span>
}, (previous, next) => previous.resolvedFacts === next.resolvedFacts &&
  toolkitAgentCardKey(previous.card.reference) === toolkitAgentCardKey(next.card.reference) &&
  previous.fields.length === next.fields.length && previous.fields.every((field, index) => field === next.fields[index]) &&
  previous.card.metrics.length === next.card.metrics.length && previous.card.metrics.every((metric, index) => metric.label === next.card.metrics[index]!.label && metric.value === next.card.metrics[index]!.value))

export function ToolkitAgentCards({ cards, active }: { cards: NonNullable<ToolkitResultDocument['agentCards']>; active: boolean }) {
  const facts = useToolkitAgentCards(cards.items, cards.fields, active)
  return <div className="toolkit-agent-cards">{cards.items.map((card, index) => <ToolkitAgentCard key={JSON.stringify([toolkitAgentCardKey(card.reference), index])} card={card} fields={cards.fields} resolvedFacts={facts.get(toolkitAgentCardKey(card.reference))} />)}
    {cards.omittedItems ? <p className="settings-hint">{cards.omittedItems} additional cards omitted from this result.</p> : null}
  </div>
}
