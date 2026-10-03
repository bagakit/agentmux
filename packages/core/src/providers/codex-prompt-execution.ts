import type { AgentPromptExecutionContext, AgentTerminalScreenSnapshot } from '../types.js'

/** Codex 0.160.1's ordinary bottom pane, not its transcript or a historical prompt.
 * A clipped native preview is not evidence of an empty native queue. Require spare
 * viewport above the complete status/composer/footer group before using Escape.
 * Placeholder spans are dim; actual draft cells (including after the cursor) are not.
 */
export function inspectCodexPromptExecution(screen: AgentTerminalScreenSnapshot): AgentPromptExecutionContext {
  const { lines, cursor, cols, rows } = screen
  if (cols < 50 || rows < 16 || cursor.row < 8 || cursor.row >= rows - 1) return 'unavailable'
  if (lines.some(line => /^\s*• (?:Messages to be submitted|Queued messages|Rejected messages|Pending questions)/u.test(line.text))) return 'unavailable'
  const composer = lines[cursor.row]
  if (!composer || composer.wrapped || !/^\s*› /u.test(composer.text)) return 'unavailable'
  const markerColumn = composer.cells.findIndex(cell => cell.chars === '›')
  if (cursor.column !== markerColumn + 2) return 'unavailable'
  // Never mistake a cursor at the start of an existing draft for an empty composer.
  if (composer.cells.slice(markerColumn + 2).some(cell => cell.chars.trim() && !cell.dim)) return 'unavailable'
  // The complete composer must be one row: attachments, multiline drafts and popups
  // make this specific operation unavailable, without closing ordinary input.
  let footerRow = cursor.row + 1
  while (footerRow < rows && !lines[footerRow]?.text.trim()) footerRow++
  const footer = lines[footerRow]?.text.trim() ?? ''
  if (!footer || !/^(?:\? for shortcuts|\S+ (?:none|minimal|low|medium|high|xhigh|default)(?: ·|$)|\d+% context left)/u.test(footer)) return 'unavailable'
  // A custom status line leaves the native shortcut hint on the next row.
  // The native warning badge shares the last row with a non-dim shortcut label.
  // Recognize its complete, aligned layout; other hints retain the dim label check.
  const hintLine = lines[footerRow + 1]
  const hint = hintLine?.text.trim() ?? ''
  const nativeWarnings = Boolean(!footer.startsWith('?') && hintLine && !hintLine.wrapped && footerRow + 1 === rows - 1 &&
    hintLine.text.search(/\S/u) === markerColumn + 2 && hintLine.text.trimEnd().length === cols - 1 &&
    /^\? for shortcuts {2,}⚠ [1-9]\d* warnings? · f2 to view$/u.test(hint) &&
    hintLine.cells.every(cell => !cell.chars.trim() || !cell.dim))
  if (hint && !nativeWarnings) {
    if (footer.startsWith('?') || hintLine?.wrapped ||
        !/^(?:tab to queue(?: message)?|\? for shortcuts)$/u.test(hint)) return 'unavailable'
    const labelColumn = hintLine!.text.search(/\S/u) + (hint.startsWith('tab') ? 3 : 1)
    if (hintLine!.cells.slice(labelColumn).some(cell => cell.chars.trim() && !cell.dim)) return 'unavailable'
  }
  if (lines.slice(footerRow + 2).some(line => line.text.trim())) return 'unavailable'
  let statusRow = cursor.row - 1
  while (statusRow >= 0 && !lines[statusRow]?.text.trim()) statusRow--
  const status = lines[statusRow]?.text.trim() ?? ''
  // Pending native inputs are rendered between the active status and composer.
  // Requiring that exact adjacent group and at least eight spare rows rejects a
  // preview whose requested height consumed/clipped the available viewport.
  if (/\besc to interrupt\)/u.test(status) && !/\b(?:review|hook)\b/iu.test(status) &&
      statusRow >= 8 && cursor.row - statusRow === 3) return 'interruptible'
  // Idle requires an ordinary shortcut footer; absence of a busy string alone does
  // not establish idle. Core also checks the native end/initial readiness evidence.
  if (!/to interrupt/u.test(status) && !/pending|queued|↳|approval|question|hook/iu.test(status)) return 'idle'
  return 'unavailable'
}
