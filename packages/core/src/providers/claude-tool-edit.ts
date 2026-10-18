import type { ConversationToolEdit } from '../conversation-tool-edit.js'

/** Claude's original edit parameters. Missing or partial input does not describe a complete edit. */
export function claudeToolEdit(name: string, raw: string): ConversationToolEdit | null {
  let input: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    input = value as Record<string, unknown>
  } catch { return null }
  const path = typeof input.file_path === 'string' ? { filePath: input.file_path } : {}
  if (name === 'Write') return typeof input.content === 'string' ? { ...path, edits: [{ after: input.content }] } : null
  if (name !== 'Edit' && name !== 'MultiEdit') return null
  const edits = name === 'Edit' ? [input] : input.edits
  if (!Array.isArray(edits) || !edits.length) return null
  const result: { before: string; after: string }[] = []
  for (const edit of edits) {
    if (!edit || typeof edit !== 'object' || typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string') return null
    result.push({ before: edit.old_string, after: edit.new_string })
  }
  return { ...path, edits: result }
}
