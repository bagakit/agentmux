const NO_FOCUSED_PANE_ERROR = 'Select a workspace and focus a pane before opening a browser.'

/** The Browser Tools action must turn a missing focus into visible feedback, never a no-op. */
export function browserOpenError(activePaneId: string | undefined): string | null {
  return activePaneId ? null : NO_FOCUSED_PANE_ERROR
}
