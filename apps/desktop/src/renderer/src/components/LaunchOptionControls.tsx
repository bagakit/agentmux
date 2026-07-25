import { ChevronRight, Sliders } from 'lucide-react'
import type { LaunchOption, LaunchOptionSelection } from '@agentmux/core'

/**
 * Renders the DESCRIBE half of the sealed launch-option contract as a progressive-disclosure affordance.
 * Every control is drawn purely from the {@link LaunchOption} declaration the Provider shipped through the
 * catalog — this component knows nothing about which Provider it came from and never branches on a provider
 * id. A Provider that declares no option hands down an empty array, so the parent renders nothing; absence
 * hides the control rather than disabling it or leaving an empty region.
 *
 * Collapsed by default, it is a single ghost toggle row carrying a one-line summary of the current posture:
 * an italic "{n} options · provider defaults" while untouched (no argv contributed), or the picked value
 * labels once the user chooses — each tinted by its choice tier so a dangerous posture is visible without
 * expanding. Expanded, it reveals one hairline-divided row per option, reusing the existing segmented
 * control verbatim. These remain launch-time choices, not live switches: the picked ids flow back to Core,
 * which resolves each choice's argv at spawn.
 */
export function LaunchRefine({
  options,
  selection,
  expanded,
  onToggle,
  onSelect,
  disabled
}: {
  options: LaunchOption[]
  selection: LaunchOptionSelection
  expanded: boolean
  onToggle(): void
  onSelect(optionId: string, choiceId: string | null): void
  disabled?: boolean
}) {
  // Absence hides: a Provider with no declaration draws no toggle, no panel, no placeholder. The footer's
  // own margin then supplies the gap under the textarea, so there is no empty region (the common case).
  if (options.length === 0) return null

  // The summary is derived, never stored: it reads the same selection map that drives the panel below, so
  // the collapsed line and the expanded controls can never drift. An empty map is the honest untouched
  // state — nothing is pre-selected, so no value is fabricated and no argv is added until the user picks.
  const touched = Object.keys(selection).length > 0
  const chosen = options.flatMap((option) => {
    const choice = option.choices.find((candidate) => candidate.id === selection[option.id])
    return choice ? [{ optionId: option.id, label: choice.label, tier: choice.tier ?? 'safe' }] : []
  })

  return (
    <div className="launch-refine">
      <button
        type="button"
        className={`launch-refine__toggle ${expanded ? 'launch-refine__toggle--expanded' : ''}`}
        aria-expanded={expanded}
        aria-controls="launch-refine-panel"
        onClick={onToggle}
      >
        <Sliders className="launch-refine__toggle-icon" size={14} />
        <span className="launch-refine__toggle-label">Launch options</span>
        {touched ? (
          <span className="launch-refine__summary">
            {chosen.map((entry, index) => (
              <span key={entry.optionId}>
                {index > 0 ? <span className="launch-refine__sep"> · </span> : null}
                <span className="launch-refine__val" data-tier={entry.tier}>{entry.label}</span>
              </span>
            ))}
          </span>
        ) : (
          <span className="launch-refine__summary launch-refine__summary--empty">
            {options.length} option{options.length === 1 ? '' : 's'} · provider defaults
          </span>
        )}
        <span className="launch-refine__count">{options.length}</span>
        <ChevronRight className={`launch-refine__chevron ${expanded ? 'icon-rotate-90' : ''}`} size={12} />
      </button>

      {expanded ? (
        <div
          id="launch-refine-panel"
          className="launch-refine__panel animate-fade-in"
          role="group"
          aria-label="Launch options"
        >
          {options.map((option) => {
            const active = selection[option.id]
            return (
              <div className="launch-refine__row" key={option.id}>
                <div className="launch-refine__head">
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
      ) : null}
    </div>
  )
}
