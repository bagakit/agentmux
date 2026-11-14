import { resolveFocusSelectionAccent, resolveFocusSelectionFillPercent, resolveFocusSelectionBorderPercent, type FocusPreferences, type FocusSelectionAccent } from '../../../shared/focus-preferences'

const inks: Record<FocusSelectionAccent, string> = { neutral: 'var(--text)', accent: 'var(--focus-line)', blue: 'var(--blue)', purple: 'var(--purple)' }

/** Shared by the real scan and its draft example; selection facts stay with each original caller. */
export function focusSelectionStyle(preferences: Pick<FocusPreferences, 'selectionFillPercent' | 'selectionBorderPercent' | 'selectionAccent'> | undefined) {
  return {
    '--focus-selection-ink': inks[resolveFocusSelectionAccent(preferences?.selectionAccent)],
    '--focus-selection-fill': `${resolveFocusSelectionFillPercent(preferences?.selectionFillPercent)}%`,
    '--focus-selection-border': `${resolveFocusSelectionBorderPercent(preferences?.selectionBorderPercent)}%`
  }
}
