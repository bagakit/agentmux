import { claudeToolEdit } from './claude/tool-edit.js'

/** Select the decoder for a Provider identity already qualified by the caller. */
export function interpretRecordedToolEdit(providerId: string, toolName: string, input: string) {
  if (providerId === 'claude') return claudeToolEdit(toolName, input)
  return null
}
