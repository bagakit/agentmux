import type { SurveyCompositionSelectionControl } from '../lib/survey-composition-drag'

/** Selection is a local closed intent; it never changes the current reading or input target. */
export function SurveyCompositionCheckbox({ selection, label }: { selection: SurveyCompositionSelectionControl; label: string }) {
  return <label className="survey-composition-checkbox" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    <input type="checkbox" aria-label={label} checked={selection.checked} aria-checked={selection.partial ? 'mixed' : selection.checked}
      ref={input => { if (input) input.indeterminate = selection.partial }} onChange={event => selection.toggle(event.target.checked)} />
  </label>
}
