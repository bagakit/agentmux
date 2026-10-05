import type { AgentPromptPreparationWaitReason } from '../prompt-preparation.js'
import type { AgentCapabilities, AgentPromptExecutionContext, AgentTerminalScreenSnapshot } from '../types.js'

/** Codex's ordinary bottom pane, not its transcript or a historical prompt.
 * A clipped native preview is not evidence of an empty native queue. Require spare
 * viewport above the complete status/composer/footer group before using Escape.
 * Placeholder spans are dim; actual draft cells (including after the cursor) are not.
 */
function inspectCodexPromptPane(screen: AgentTerminalScreenSnapshot, strategy: NonNullable<AgentCapabilities['promptExecution']>['immediate'] = 'interrupt-before-input'): AgentPromptExecutionContext | AgentPromptPreparationWaitReason {
  const { lines, cursor, cols, rows } = screen
  const steering = strategy === 'native-steer'
  if (steering ? cols < 3 || rows < 3 || cursor.row < 0 || cursor.row >= rows - 1 :
      cols < 50 || rows < 16 || cursor.row < 8 || cursor.row >= rows - 1) return 'unavailable'
  if (!steering && lines.some(line => /^\s*• (?:Messages to be submitted|Queued messages|Rejected messages|Pending questions)/u.test(line.text))) return 'unavailable'
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
  // Native Fast mode adds its tier immediately after the reasoning effort.
  // It changes the status label, while the same complete composer owns input.
  if (!footer || !/^(?:\? for shortcuts|\S+ (?:none|minimal|low|medium|high|xhigh|max|default)(?: fast)?(?: ·|$)|\d+% context left)/u.test(footer)) return 'unavailable'
  // A custom status line leaves the native shortcut hint on the next row.
  // The last-row warning badge can share a non-dim shortcut label or stand alone.
  // Recognize only its complete, aligned layout; other hints retain the dim check.
  const hintLine = lines[footerRow + 1]
  const hint = hintLine?.text.trim() ?? ''
  const nativeWarnings = Boolean(!footer.startsWith('?') && hintLine && !hintLine.wrapped && footerRow + 1 === rows - 1 &&
    hintLine.text.trimEnd().length === cols - 1 &&
    (hintLine.text.search(/\S/u) === markerColumn + 2 && /^\? for shortcuts {2,}⚠ [1-9]\d* warnings? · f2 to view$/u.test(hint) ||
      /^⚠ [1-9]\d* warnings? · f2 to view$/u.test(hint)) &&
    hintLine.cells.every(cell => !cell.chars.trim() || !cell.dim))
  // Native transcript reading adds one complete local history hint. Its dim
  // history/"latest" labels and non-dim keys belong to the main composer, not a
  // transcript line. Only native-steer may use this shape; Escape preparation
  // keeps its separate target requirements.
  const historyHeader = 'New activity · Earlier messages available.'
  const historyKeyColumn = markerColumn + 2 + historyHeader.length + 2
  const historyLatestColumn = historyKeyColumn + 'enter/esc'.length + 1
  const nativeHistory = Boolean(steering && !footer.startsWith('?') && hintLine && !hintLine.wrapped &&
    footerRow + 1 === rows - 1 && hintLine.text.search(/\S/u) === markerColumn + 2 &&
    /^New activity · Earlier messages available\. {2}enter\/esc latest · \? shortcuts(?: {2,}⚠ [1-9]\d* warnings? · f2 to view)?$/u.test(hint) &&
    (!hint.includes('⚠') || hintLine.text.trimEnd().length === cols - 1) &&
    hintLine.cells.slice(markerColumn + 2, historyKeyColumn - 2).every(cell => !cell.chars.trim() || cell.dim) &&
    hintLine.cells.slice(historyKeyColumn, historyLatestColumn - 1).every(cell => !cell.chars.trim() || !cell.dim) &&
    hintLine.cells.slice(historyLatestColumn, historyLatestColumn + 'latest'.length).every(cell => !cell.chars.trim() || cell.dim) &&
    hintLine.cells.slice(historyLatestColumn + 'latest'.length).every(cell => !cell.chars.trim() || !cell.dim))
  if (hint && !nativeWarnings && !nativeHistory) {
    if (footer.startsWith('?') || hintLine?.wrapped ||
        !/^(?:tab to queue(?: message)?|\? for shortcuts)$/u.test(hint)) return 'unavailable'
    const labelColumn = hintLine!.text.search(/\S/u) + (hint.startsWith('tab') ? 3 : 1)
    if (hintLine!.cells.slice(labelColumn).some(cell => cell.chars.trim() && !cell.dim)) return 'unavailable'
  }
  if (lines.slice(footerRow + 2).some(line => line.text.trim())) return 'unavailable'
  if (steering) {
    // Enter contributes to the native regular turn. It neither interrupts nor
    // drains native queued inputs, so their preview and spare rows are not an
    // authorization requirement. The complete footer still identifies the main
    // composer; an active modal/draft cannot impersonate it.
    let currentRow = cursor.row - 1
    const skipSpace = () => { while (currentRow >= 0 && !lines[currentRow]?.text.trim()) currentRow-- }
    const dimBody = (row: number) => lines[row]?.cells.every(cell => !cell.chars.trim() || cell.dim)
    skipSpace()
    // Only the contiguous native preview immediately above this composer is
    // skipped. Its dim entries and exact header belong to one local group; a
    // Working line elsewhere in the transcript never authorizes this input.
    if (/^    \S.* edit last queued message$/u.test(lines[currentRow]?.text ?? '') && dimBody(currentRow)) currentRow--
    let preview = false
    for (let section = 0; section < 3; section++) {
      skipSpace()
      if (!/^ {2}↳ |^ {4}\S/u.test(lines[currentRow]?.text ?? '')) break
      let entries = 0
      while (currentRow >= 0 && /^ {2}↳ |^ {4}\S/u.test(lines[currentRow]?.text ?? '')) {
        if (!dimBody(currentRow)) return 'unavailable'
        if (/^ {2}↳ /u.test(lines[currentRow]!.text)) entries++
        currentRow--
      }
      if (!entries) return 'unavailable'
      let continuation = ''
      while (/^  (?!↳)\S/u.test(lines[currentRow]?.text ?? '')) {
        continuation = lines[currentRow]!.text.trim() + ' ' + continuation
        currentRow--
      }
      const header = lines[currentRow]
      const group = ((header?.text.trim() ?? '') + ' ' + continuation).trim()
      if (header?.cells.find(cell => cell.chars === '•')?.dim !== true ||
          !/^• (?:Messages to be submitted after next tool call(?: \(press .+ to interrupt and send immediately\))?|Queued follow-up inputs)$/u.test(group)) return 'unavailable'
      preview = true
      currentRow--
    }
    skipSpace()
    const detail = lines[currentRow]
    const nativeTip = Boolean(detail && !detail.wrapped && /^  └ Tip: \S/u.test(detail.text) &&
      detail.text.search(/\S/u) === markerColumn + 2 && detail.cells[markerColumn + 2]?.dim &&
      detail.cells.slice(markerColumn + 4).every(cell => !cell.chars.trim() || !cell.dim))
    if (nativeTip) currentRow--
    // Compaction owns one adjacent detail row, followed by the optional native Tip.
    // Historical text, a popup or a draft cannot reach this point: the complete
    // ordinary composer/footer and cursor were already checked above.
    const compactDetail = lines[currentRow]
    const makingRoom = Boolean(compactDetail && !compactDetail.wrapped &&
      /^  └ Making room to continue\.$/u.test(compactDetail.text))
    if (makingRoom) currentRow--
    const statusLine = lines[currentRow]
    const status = statusLine?.text.trim() ?? ''
    if (statusLine?.wrapped) return 'unavailable'
    const adjacent = !preview && cursor.row - currentRow === (nativeTip ? 4 : 3) + (makingRoom ? 1 : 0)
    if (adjacent && /^• Compacting context(?: \(.*\))?$/u.test(status)) return 'context-compaction'
    if (adjacent && !makingRoom && /^• (?:Running|Waiting for) hooks?(?: \(.*\))?$/u.test(status)) return 'native-busy'
    if (makingRoom) return 'unavailable'
    if (/^• (?:Working|Running)\b/u.test(status) &&
        /\b(?:esc|escape|f\d+) to (?:interrupt|cancel)\)/iu.test(status) &&
        !/\b(?:review|compact(?:ing)?|hook)\b/iu.test(status) &&
        (preview || cursor.row - currentRow === (nativeTip ? 4 : 3))) return 'interruptible'
    // Completed child names are output, not a current control state. This only
    // excludes their contents from the veto; the composer/footer guards still hold.
    const completed = /^• Completed `.+`$/u.test(status)
    if (preview || nativeTip || hint.startsWith('tab to queue') ||
        !completed && /to interrupt|pending|queued|↳|approval|question|hook|review|compact(?:ing)?|^\d+[.)] /iu.test(status)) return 'unavailable'
    return 'idle'
  }
  let statusRow = cursor.row - 1
  while (statusRow >= 0 && !lines[statusRow]?.text.trim()) statusRow--
  // The native busy indicator can append one Tip row below its header. This
  // subordinate row is not an idle boundary. Keep the complete adjacent group;
  // never scan transcript text for an earlier Working line to authorize Escape.
  const detail = lines[statusRow]
  if (detail?.wrapped) return 'unavailable'
  const nativeTip = Boolean(detail && !detail.wrapped && cursor.row - statusRow === 3 &&
    /^  └ Tip: \S/u.test(detail.text) && detail.text.search(/\S/u) === markerColumn + 2 &&
    detail.cells[markerColumn + 2]?.dim &&
    detail.cells.slice(markerColumn + 4).every(cell => !cell.chars.trim() || !cell.dim))
  if (nativeTip) statusRow--
  if (lines[statusRow]?.wrapped) return 'unavailable'
  const status = lines[statusRow]?.text.trim() ?? ''
  // Pending native inputs are rendered between the active status and composer.
  // Requiring that exact adjacent group and at least eight spare rows rejects a
  // preview whose requested height consumed/clipped the available viewport.
  if (/\besc to interrupt\)/u.test(status) && !/\b(?:review|hook)\b/iu.test(status) &&
      statusRow >= 8 && cursor.row - statusRow === (nativeTip ? 4 : 3)) return 'interruptible'
  // A malformed or detached native detail cannot turn a busy frame into idle.
  if (nativeTip || /^\s*└/u.test(detail?.text ?? '')) return 'unavailable'
  // Idle requires an ordinary shortcut footer; absence of a busy string alone does
  // not establish idle. Core also checks the native end/initial readiness evidence.
  if (!/to interrupt/u.test(status) && !/pending|queued|↳|approval|question|hook/iu.test(status)) return 'idle'
  return 'unavailable'
}

/** Input eligibility remains strict; temporary states explain the refusal only. */
export function inspectCodexPromptExecution(screen: AgentTerminalScreenSnapshot, strategy: NonNullable<AgentCapabilities['promptExecution']>['immediate'] = 'interrupt-before-input'): AgentPromptExecutionContext {
  const context = inspectCodexPromptPane(screen, strategy)
  return context === 'context-compaction' || context === 'native-busy' ? 'unavailable' : context
}

export function inspectCodexPromptPreparationWait(screen: AgentTerminalScreenSnapshot, strategy: NonNullable<AgentCapabilities['promptExecution']>['immediate'] = 'interrupt-before-input'): AgentPromptPreparationWaitReason | undefined {
  const context = inspectCodexPromptPane(screen, strategy)
  return context === 'context-compaction' || context === 'native-busy' ? context : undefined
}
