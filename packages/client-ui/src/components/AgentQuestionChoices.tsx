import type { ReactNode } from 'react'

/** Shared option presentation; the original caller owns selection and submission semantics. */
export function AgentQuestionChoices({ options, selectedId, disabled, onChoose, marker }: {
  options: readonly { id: string; label: string; description?: string }[]
  selectedId: string | null
  disabled: boolean
  onChoose(id: string): void
  marker?: ReactNode
}) {
  return <div className="agent-interaction__options">
    {options.map(option => <button key={option.id} type="button" disabled={disabled}
      aria-pressed={selectedId === option.id} onClick={() => onChoose(option.id)}>
      {marker ? <span className="agent-question__choice-mark" aria-hidden="true">{selectedId === option.id ? marker : null}</span> : null}
      <span>{option.label}</span>
      {option.description ? <small>{option.description}</small> : null}
    </button>)}
  </div>
}
