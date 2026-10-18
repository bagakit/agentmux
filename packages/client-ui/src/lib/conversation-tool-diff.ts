import type { ConversationToolEdit } from '@agentmux/core/conversation'

/** Bounded visual diff; complete original parameters remain available beside it. */
export type DiffLineKind = 'added' | 'removed' | 'context' | 'hunk'

export type DiffLine = { kind: DiffLineKind; text: string }

export type ToolDiff = {
  lines: DiffLine[]
  truncated: boolean
  filePath?: string
}

export const MAX_DIFF_LINES = 200

export function parseUnifiedDiff(text: string): ToolDiff | null {
  const { body, fenced } = stripDiffFence(text)
  const rawLines = splitDiffBody(body)

  const lines: DiffLine[] = []
  let sawHunk = false

  for (const raw of rawLines) {
    if (raw.startsWith('@@')) {
      sawHunk = true
      lines.push({ kind: 'hunk', text: raw })
      continue
    }
    // `diff `/`index ` 这类文件头与内容行永不冲突（内容行以 +/-/空格 起头），可以无条件当结构行。
    // 见到新一段 `diff ` 说明进入了下一个文件的头部，重置 sawHunk 好让它的 `---`/`+++` 再被认作头。
    if (UNAMBIGUOUS_HEADER.test(raw)) {
      if (raw.startsWith('diff ')) sawHunk = false
      lines.push({ kind: 'hunk', text: raw })
      continue
    }
    // `--- `/`+++ ` 与删除/新增行同形，只有在还没进入 hunk 体（文件头区）时才当文件头。
    if (!sawHunk && (raw.startsWith('--- ') || raw.startsWith('+++ '))) {
      lines.push({ kind: 'hunk', text: raw })
      continue
    }

    const marker = raw[0]
    if (marker === '+') {
      lines.push({ kind: 'added', text: raw.slice(1) })
    } else if (marker === '-') {
      lines.push({ kind: 'removed', text: raw.slice(1) })
    } else if (marker === ' ') {
      lines.push({ kind: 'context', text: raw.slice(1) })
    } else if (marker === '\\') {
      // `\ No newline at end of file`——是注记不是内容，原样留作 context。
      lines.push({ kind: 'context', text: raw })
    } else if (fenced) {
      // 围栏内我们已经信了它是 diff，无前缀的行当作 context 收下。
      lines.push({ kind: 'context', text: raw })
    } else {
      // 无围栏、又出现了不带 diff 前缀的行——这不是一段 diff。
      return null
    }
  }

  const diffShaped = fenced || sawHunk
  if (!diffShaped || lines.length === 0) return null
  return capped(lines, undefined)
}

function* lineDiff(oldText: string | undefined, newText: string): Generator<DiffLine> {
  const newLines = splitLines(newText)
  if (oldText === undefined) {
    for (const text of newLines) yield { kind: 'added', text }
    return
  }
  const oldLines = splitLines(oldText)

  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start += 1
  }
  let oldEnd = oldLines.length
  let newEnd = newLines.length
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1
    newEnd -= 1
  }

  for (let i = 0; i < start; i += 1) yield { kind: 'context', text: oldLines[i]! }
  for (let i = start; i < oldEnd; i += 1) yield { kind: 'removed', text: oldLines[i]! }
  for (let i = start; i < newEnd; i += 1) yield { kind: 'added', text: newLines[i]! }
  for (let i = oldEnd; i < oldLines.length; i += 1) yield { kind: 'context', text: oldLines[i]! }
}

function capped(lines: DiffLine[], filePath: string | undefined): ToolDiff | null {
  if (lines.length === 0) return null
  const truncated = lines.length > MAX_DIFF_LINES
  const kept = truncated ? lines.slice(0, MAX_DIFF_LINES) : lines
  return { lines: kept, truncated, ...(filePath !== undefined ? { filePath } : {}) }
}

function splitLines(text: string): string[] {
  if (text === '') return []
  const parts = text.split('\n')
  if (parts[parts.length - 1] === '') parts.pop()
  return parts
}

const UNAMBIGUOUS_HEADER =
  /^(diff |index |new file mode|deleted file mode|old mode |new mode |similarity index |dissimilarity index |rename |copy |Binary files )/

function stripDiffFence(text: string): { body: string; fenced: boolean } {
  const fence = /^\s*(```+|~~~+)[ \t]*diff[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*\1[ \t]*\s*$/i
  const match = fence.exec(text)
  if (match) return { body: match[2] ?? '', fenced: true }
  return { body: text, fenced: false }
}

function splitDiffBody(body: string): string[] {
  const parts = body.split('\n')
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop()
  return parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

/** Provider semantics are already normalized; this module only arranges visual lines. */
export function toolEditDiff(edit: ConversationToolEdit | null): ToolDiff | null {
  if (!edit) return null
  const lines: DiffLine[] = []
  for (const [index, change] of edit.edits.entries()) {
    if (edit.edits.length > 1) {
      lines.push({ kind: 'hunk', text: `@@ edit ${index + 1} @@` })
      if (lines.length > MAX_DIFF_LINES) return capped(lines, edit.filePath)
    }
    for (const line of lineDiff(change.before, change.after)) {
      lines.push(line)
      if (lines.length > MAX_DIFF_LINES) return capped(lines, edit.filePath)
    }
  }
  return capped(lines, edit.filePath)
}
