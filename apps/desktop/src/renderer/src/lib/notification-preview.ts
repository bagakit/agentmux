/** The two notification previews share a 100-code-point budget, with their original
 * whitespace and ellipsis semantics. Pending whitespace avoids trimming a full copy.
 * A title may need to scan trailing whitespace to distinguish an exact fit. */
export function notificationPreview(text: string, mode: 'title' | 'announcement'): string {
  const trim = mode === 'title'
  let preview = '', points = 0, pendingSpace = false
  for (const point of text) {
    if (/\s/u.test(point)) {
      if (!trim || points) pendingSpace = true
      continue
    }
    if (pendingSpace) {
      if (points === 100) return `${preview}…`
      preview += ' '; ++points; pendingSpace = false
      if (!trim && points === 100) return preview
    }
    if (points === 100) return `${preview}…`
    preview += point; ++points
    if (!trim && points === 100) return preview
  }
  if (!trim && pendingSpace && points < 100) preview += ' '
  return preview
}
