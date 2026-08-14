// Suppresses ACCIDENTAL DUPLICATE SUBMITS: hitting Enter/Send twice with the same text in quick
// succession. It only answers "is this text a duplicate of the last RECORDED submit"; it never
// decides whether a send succeeded. The component records ONLY non-throwing submits, so a real
// failure (e.g. "readiness epoch already consumed") is never recorded and its retry is never
// suppressed — this guard cannot mask that bug.

export type LastSubmit = { text: string; at: number } | null

// A double-tap on Enter lands well under a second; a deliberate identical re-send is seconds apart.
export const RESUBMIT_WINDOW_MS = 800

// True iff `text` should be suppressed as an accidental duplicate: its trimmed form equals the
// trimmed text of the last recorded submit AND (now - last.at) < windowMs. last === null => never
// suppress. Comparison is on trimmed text (leading/trailing whitespace differences are still "the
// same message").
export function isDuplicateResubmit(last: LastSubmit, text: string, now: number, windowMs: number): boolean {
  if (last === null) return false
  return last.text.trim() === text.trim() && now - last.at < windowMs
}

// Build the record for a submit that WENT THROUGH (component calls this only after a non-throwing
// send/queue).
// ponytail: last-submit-only (window of 1), not a full de-dup set — a third distinct message between
// two identical ones defeats it, which is correct (they weren't a rapid double-tap).
export function recordSubmit(text: string, now: number): LastSubmit {
  return { text, at: now }
}
