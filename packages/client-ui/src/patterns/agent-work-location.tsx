import type { ComponentPropsWithRef } from 'react'
import { SemanticIcon } from '../theme/semantic-icon.js'

export type AgentWorkLocationObservation =
  | { state: 'confirmed'; positions: Iterable<string> }
  | { state: 'unconfirmed' }
  | { state: 'failed'; detail: string }

export type AgentWorkLocationSummary =
  | { state: 'confirmed'; count: number }
  | Exclude<AgentWorkLocationObservation, { state: 'confirmed' }>

/** Position keys are physical identities supplied by the host. Each route keeps its own target. */
export function summarizeAgentWorkLocations(observation: AgentWorkLocationObservation): AgentWorkLocationSummary {
  return observation.state === 'confirmed'
    ? { state: 'confirmed', count: new Set(observation.positions).size }
    : observation
}

export type AgentWorkLocationAddressField = {
  label: string
  value: string
}

type ChoiceDescription = {
  title: string
  detail: string
  address: readonly AgentWorkLocationAddressField[]
}

/** Add original address fields only for choices with colliding labels. */
export function describeAgentWorkLocationChoices<Choice extends ChoiceDescription>(choices: readonly Choice[]): Array<Omit<Choice, 'detail'> & { detail: string }> {
  const labels = new Map<string, Choice[]>()
  const key = (choice: Choice) => JSON.stringify([choice.title, choice.detail])
  for (const choice of choices) {
    const label = key(choice)
    const peers = labels.get(label)
    if (peers) peers.push(choice)
    else labels.set(label, [choice])
  }
  return choices.map(choice => {
    let peers = labels.get(key(choice))!.filter(other => other !== choice)
    if (!peers.length) return choice
    const hints: string[] = []
    for (const [index, field] of choice.address.entries()) {
      const matches = peers.filter(other => other.address[index]?.value === field.value)
      if (matches.length !== peers.length) hints.push(`${field.label} ${field.value}`)
      peers = matches
      if (!peers.length) break
    }
    return { ...choice, detail: [...hints, choice.detail].filter(Boolean).join(' · ') }
  })
}

export type AgentWorkLocationTriggerProps = Omit<ComponentPropsWithRef<'button'>, 'children' | 'type'> & {
  agentName: string
  actionLabel: string
  summary: AgentWorkLocationSummary
  describeSummary: (summary: AgentWorkLocationSummary) => string
}

/** The trigger presents an observation. Its host owns the chooser and any navigation. */
export function AgentWorkLocationTrigger({
  agentName, actionLabel, summary, describeSummary, className, ...button
}: AgentWorkLocationTriggerProps) {
  const label = describeSummary(summary)
  return <button type="button" className={className ? `agent-locations ${className}` : 'agent-locations'}
    aria-label={`${agentName} · ${label} · ${actionLabel}`} data-location-observation={summary.state} {...button}>
    <SemanticIcon name="navigation.space" size={14} aria-hidden="true" />
    <span>{label}</span><span>{actionLabel}</span>
  </button>
}
