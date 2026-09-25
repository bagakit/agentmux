import type { AgentDisplayState } from '@agentmux/core'
import type { ComposerShortcut } from '../../../shared/contracts'

/** Presentation only. The mounted Session composer owns the existing typed submit/queue path. */
export function AgentStatusPromptActions({ prompts, state, disabled, queue, onSelect }: {
  prompts: readonly ComposerShortcut[]
  state: AgentDisplayState
  disabled: boolean
  queue: boolean
  onSelect(prompt: ComposerShortcut): void
}) {
  // Reserve one row only for Providers with user-bound actions. State changes never add/remove it.
  if (!prompts.some((prompt) => prompt.states?.length)) return null
  const visible = prompts.filter((prompt) => prompt.states?.includes(state))
  return <div className="agent-status-prompts" role="group" aria-label={`Prompts for ${state}`}>
    {visible.map((prompt) => <button key={prompt.id} type="button"
      className="small-button agent-status-prompts__button" disabled={disabled}
      aria-label={`${queue ? 'Queue' : 'Send'} ${prompt.label}`} title={prompt.body}
      onFocus={(event) => event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' })}
      onClick={() => onSelect(prompt)}>
      {queue ? <span className="agent-status-prompts__queue">Queue ·</span> : null}
      <span className="agent-status-prompts__label">{prompt.label}</span>
    </button>)}
  </div>
}
