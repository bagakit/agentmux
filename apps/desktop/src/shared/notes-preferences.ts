export const NOTE_FONT_SIZE_MIN = 10
export const NOTE_FONT_SIZE_MAX = 24
export const NOTE_FONT_SIZE_DEFAULT = 13
export const NOTE_CONTENT_WIDTHS = ['standard', 'wide'] as const
export type NoteContentWidth = typeof NOTE_CONTENT_WIDTHS[number]

export type NotesPreferences = { fontSize?: number; contentWidth?: NoteContentWidth }

export function resolveNotesPreferences(value: NotesPreferences | undefined): Required<NotesPreferences> {
  return { fontSize: value?.fontSize ?? NOTE_FONT_SIZE_DEFAULT, contentWidth: value?.contentWidth ?? 'standard' }
}

export function validNoteFontSize(value: number): boolean {
  return Number.isInteger(value) && value >= NOTE_FONT_SIZE_MIN && value <= NOTE_FONT_SIZE_MAX
}
