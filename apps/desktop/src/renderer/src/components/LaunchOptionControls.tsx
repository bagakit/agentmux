import type { LaunchOption, LaunchOptionSelection } from '@agentmux/core'

/**
 * Renders the DESCRIBE half of the sealed launch-option contract. Every control is drawn purely from the
 * {@link LaunchOption} declaration the Provider shipped through the catalog — this component knows nothing
 * about which Provider it came from and never branches on a provider id. A Provider that declares no option
 * hands down an empty array, so the parent renders nothing; absence hides the control rather than disabling
 * it. These are launch-time choices, not live switches: the header says so, and the picked choice ids flow
 * back to Core, which resolves each choice's argv at spawn.
 */
export function LaunchOptionControls({
  options,
  selection,
  onSelect,
  disabled
}: {
  options: LaunchOption[]
  selection: LaunchOptionSelection
  onSelect(optionId: string, choiceId: string | null): void
  disabled?: boolean
}) {
  if (options.length === 0) return null
  return (
    <div className="launch-options" aria-label="Launch options">
      <div className="launch-options__label">
        <span>Launch options</span>
        <em>Applied when the agent starts</em>
      </div>
      {options.map((option) => {
        const active = selection[option.id]
        return (
          <div className="launch-option" key={option.id}>
            <div className="launch-option__head">
              <strong>{option.label}</strong>
              {option.description ? <small>{option.description}</small> : null}
            </div>
            <div className="launch-option__segments" role="group" aria-label={option.label}>
              {option.choices.map((choice) => {
                const selected = active === choice.id
                return (
                  <button
                    type="button"
                    key={choice.id}
                    className={`launch-option__segment ${selected ? 'launch-option__segment--selected' : ''}`}
                    data-tier={choice.tier ?? 'safe'}
                    aria-pressed={selected}
                    disabled={disabled}
                    title={choice.description ?? choice.label}
                    // Clicking the active choice clears it, returning to the Provider's own default (no
                    // argv contributed). Nothing is pre-selected unless the declaration named a default.
                    onClick={() => onSelect(option.id, selected ? null : choice.id)}
                  >
                    {choice.label}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
