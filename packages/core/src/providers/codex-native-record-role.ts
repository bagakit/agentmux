/** 0.162 TUI start/fork contributes ThreadSource::User; origin is a separate enum.
 * Older CLI records without this role retain their explicit cli contract. A role
 * conflict, child or unknown never inherits main authority from an originator label. */
export function codexMainNativeRecord(payload: Readonly<Record<string, unknown>>): boolean {
  if (!Object.hasOwn(payload, 'thread_source')) return payload.source === 'cli'
  return payload.thread_source === 'user' && (payload.source === 'cli' || payload.source === 'vscode')
}
