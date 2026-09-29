import type { AgentDisplayState } from '@agentmux/core'
import type { ComposerShortcut } from '../../../shared/contracts'

/** Presentation only. The mounted Session composer owns the existing typed submit/queue path. */
export function AgentStatusPromptActions({ prompts, state, disabled, disabledReason, queue, onSelect }: {
  prompts: readonly ComposerShortcut[]
  state: AgentDisplayState
  disabledReason?: string | undefined
  disabled: boolean
  queue: boolean
  onSelect(prompt: ComposerShortcut): void
}) {
  const visible = prompts.filter((prompt) => prompt.states?.includes(state))
  if (visible.length === 0) return null
  return <section className="agent-status-prompts" role="group" aria-label={`Prompts for ${state}`}>
    <h3>User prompts</h3>
    {disabledReason ? <p className="agent-status-prompts__reason">{disabledReason}</p> : null}
    {visible.map((prompt) => <button key={prompt.id} type="button"
      className="small-button agent-status-prompts__button" disabled={disabled}
      aria-label={`${queue ? 'Queue' : 'Send'} ${prompt.label}`} title={prompt.body}
      onFocus={(event) => event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' })}
      onClick={() => onSelect(prompt)}>
      <span className="agent-status-prompts__copy"><span className="agent-status-prompts__label">{prompt.label}</span><small>{prompt.body}</small></span>
      <span className="agent-status-prompts__intent">{queue ? 'Queue' : 'Send'}</span>
    </button>)}
  </section>
}
