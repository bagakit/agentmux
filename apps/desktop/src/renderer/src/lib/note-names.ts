/**
 * Naming for a new note.
 *
 * The store writes notes through the same `files:create` seam a file-tree "New File" uses, and that
 * seam opens with `O_CREAT | O_EXCL` (see `workspace-files.ts`) — it **fails** on an existing path
 * rather than truncating it. That is the property this module is built around: a name collision must
 * become "try the next name", never "overwrite the note the user already had".
 *
 * So the caller cannot pick one name and hope. It asks for a sequence and walks it, letting the
 * filesystem be the arbiter of what already exists. Deciding from a directory listing instead would
 * be a check-then-act race: two notes created in the same tick would agree on the same free name and
 * the second `create` would fail with a raw EEXIST.
 */

/** Notes are markdown so the editor opens them with the syntax the user expects. */
export const NOTE_FILE_EXTENSION = '.md'

/**
 * How many names to offer before giving up.
 *
 * A bound is required: the sequence is walked against a filesystem that may be failing for a reason
 * other than collision (permissions, a full disk), and an unbounded walk would spin instead of
 * reporting it. The number only has to exceed the notes a person plausibly creates in one day —
 * beyond that, the honest outcome is an error the user can read.
 */
export const NOTE_NAME_ATTEMPTS = 100

/**
 * The stem for a day's notes, as `note-YYYY-MM-DD`.
 *
 * Date-stamped rather than `untitled`: notes here are scratch by nature and accumulate, so the name
 * is the one piece of context available for free at creation time. It is derived from the caller's
 * clock — passed in, never read here — so the sequence is a pure function of its inputs and a test
 * can pin a specific day.
 *
 * Local calendar date, not UTC: the name is read by a person, and a note taken at 9pm should carry
 * the date it felt like, not tomorrow's.
 */
export function noteStemForDate(now: Date): string {
  const year = now.getFullYear()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `note-${year}-${month}-${day}`
}

/**
 * The candidate names for a new note on `now`'s date, in the order they should be tried.
 *
 * The first is unsuffixed and every later one carries `-N` starting at 2, so the common case (the
 * day's first note) gets a clean name and the suffix only appears when it means something.
 */
export function noteNameCandidates(now: Date, attempts = NOTE_NAME_ATTEMPTS): string[] {
  const stem = noteStemForDate(now)
  return Array.from({ length: Math.max(1, attempts) }, (_unused, index) =>
    index === 0 ? `${stem}${NOTE_FILE_EXTENSION}` : `${stem}-${index + 1}${NOTE_FILE_EXTENSION}`
  )
}

/**
 * Walk the candidates and return the first one `create` accepts.
 *
 * `create` is passed in rather than imported so this stays a pure decision over an injected effect:
 * the caller supplies the real IPC in production and a fake in tests. It must reject when the path
 * exists — which the `O_EXCL` seam does — and this function treats **every** rejection as "that name
 * was unavailable" while it still has candidates left.
 *
 * That last point is a deliberate trade with a bounded cost. A permission error is not a collision,
 * and retrying it 99 times is pointless work; but a rejection carries no reliably-typed reason
 * across the IPC boundary, and guessing which errors mean "collision" would make a new note fail
 * outright the moment an unfamiliar error appeared. So the walk is generous and the **last** failure
 * is what surfaces: if every candidate failed for a non-collision reason, the user sees that reason
 * rather than a name-exhaustion message that would send them looking in the wrong place.
 */
export async function createNoteWithAvailableName(
  now: Date,
  create: (name: string) => Promise<void>,
  attempts = NOTE_NAME_ATTEMPTS
): Promise<string> {
  const candidates = noteNameCandidates(now, attempts)
  let lastFailure: unknown = null
  for (const candidate of candidates) {
    try {
      await create(candidate)
      return candidate
    } catch (failure) {
      lastFailure = failure
    }
  }
  throw lastFailure instanceof Error
    ? lastFailure
    : new Error(`Could not create a note: ${candidates.length} name(s) were unavailable.`)
}
