/** These are reader budgets. They never truncate or transform the editable source. */
export const DATA_PREVIEW_MAX_BYTES = 1024 * 1024
export const DATA_PREVIEW_MAX_ROWS = 5000
export const DATA_PREVIEW_MAX_COLUMNS = 128

export type DataPreviewFailure = { status: 'invalid' | 'too-large'; message: string }

export function dataPreviewBudget(content: string): DataPreviewFailure | null {
  if (content.length > DATA_PREVIEW_MAX_BYTES) return { status: 'too-large', message: 'Use Source to read the full file. Structured preview is limited to 1 MB.' }
  const bytes = new Uint8Array(Math.min(DATA_PREVIEW_MAX_BYTES + 1, content.length * 3))
  const result = new TextEncoder().encodeInto(content, bytes)
  return result.read < content.length || result.written > DATA_PREVIEW_MAX_BYTES
    ? { status: 'too-large', message: 'Use Source to read the full file. Structured preview is limited to 1 MB.' } : null
}
