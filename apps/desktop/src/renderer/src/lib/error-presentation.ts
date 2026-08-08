/**
 * The one place a caught error becomes text for a user (#197 / #296).
 *
 * The leak this closes is a *class*, not an instance. Roughly a dozen panels caught an `unknown` and
 * did `cause instanceof Error ? cause.message : String(cause)` inline — and the store did the same
 * behind a private `message()` that additionally stripped Electron's IPC transport framing. Those two
 * presentations had already drifted: the store stripped `Error invoking remote method '<channel>': …`,
 * the panels did not, so a user deleting a Browser Profile saw the literal
 * `Error invoking remote method 'browser:deleteProfile': Error: The default Browser Profile cannot be
 * deleted`. Same concept, two implementations, divergent on the half that matters — the exact
 * near-duplicate-drift shape this repo has paid for before. This module is that presentation, once.
 *
 * ## Why this is NOT a code→sentence table
 *
 * A humanizer that maps an unknown code to a generic "Something went wrong" is a DOWNGRADE: it destroys
 * the one diagnosable fact the user could have relayed. Three facts (surveyed for #197) rule a blanket
 * table out here:
 *   1. There is no repo-wide error-code union. `AgentMuxError.code` (packages/core `errors.ts`) is a bare
 *      `string`; only the control subset (`AGENTMUX_CONTROL_ERROR_CODES`) is a real union. So a table's
 *      key set could not be forced ⊇ the code union by the type system — the enforcement this repo
 *      demands — because there is no union to be ⊇ of.
 *   2. Several codes carry DIFFERENT meanings at different throw sites (e.g. `AMBIGUOUS_REGION_TARGET`
 *      means both "the server's own region list is corrupt" and "your selector matched more than one";
 *      `AGENT_PROMPT_READINESS_CONFLICT` spans a submission-time CAS rejection AND a background
 *      readiness-persist race). One sentence for such a code is confidently wrong — worse than the raw
 *      detail. Domain humanizers that CAN distinguish meaning (git remote, PR eligibility, control
 *      addressing, prompt-readiness) already live next door and stay; this module never overrides them.
 *   3. Electron's `ipcRenderer.invoke` drops the error's `.code` and `.detail`, delivering only a
 *      reframed `.message`. So on the `invoke` path there is usually no code left to key on anyway; the
 *      honest job is to hand back the message the main process actually raised, cleaned of transport
 *      noise, with nothing thrown away.
 *
 * ## The contract: raw is reachable by construction, never swallowed
 *
 * {@link describeError} returns BOTH the cleaned user sentence (`message`) and the untouched original
 * (`raw`), plus `code`/`detail` when this side can still see them (a structured error object, not an
 * `invoke` rejection). `raw` is the promise "we did not destroy the diagnosable text" made structural:
 * a test asserts `raw` equals the original verbatim, so deleting the line that carries it reds. Callers
 * that only need the banner string use {@link presentError}; anything that wants to log or disclose the
 * unabridged failure reads `describeError(cause).raw`.
 */

// Electron wraps every rejection crossing `ipcRenderer.invoke` as
// `Error invoking remote method '<channel>': <ErrorName>: <message>` and drops the original error's
// custom fields (see the preload bridge and store.ts's own note). That framing is transport noise to a
// user — strip it back to the message the main process actually raised.
//
// The wrapper carries the thrown error's own constructor name (`Error:`, `AgentMuxError:`, `TypeError:`,
// …) between the channel and the message; #197's worst offender (browser:deleteProfile) surfaces as a
// plain `Error:`. So the wrapper regex consumes that trailing `<Ident>:` token as PART of the wrapper —
// it is only stripped when it directly follows the `invoke` framing, so a message that legitimately
// begins `Foo: …` on its own is never touched. `AGENTMUX_ERROR_NAME_PREFIX` additionally handles our
// own error class surfacing WITHOUT the invoke wrapper (thrown and caught in-renderer), where the
// `AgentMuxError:` name is the only framing present.
const IPC_INVOKE_PREFIX = /^Error invoking remote method '[^']*':\s*(?:[A-Za-z_$][\w$]*:\s*)?/u
const AGENTMUX_ERROR_NAME_PREFIX = /^AgentMuxError:\s*/u

/** The unabridged text of a caught value, before any framing is stripped. Never lossy. */
function rawText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** A string field off a caught value, only when it is actually a non-empty string. */
function stringField(cause: unknown, key: 'code' | 'detail'): string | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined
  const value = (cause as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export type PresentedError = {
  /** The sentence to show a user: the raised message with transport framing removed. */
  message: string
  /**
   * The original text, untouched. This is the anti-swallow guarantee — the diagnosable detail a user
   * could paste into a bug report survives here even when `message` trims a wrapper. Kept verbatim on
   * purpose; a test pins that it equals the original so this line cannot be quietly dropped.
   */
  raw: string
  /** The stable code, if this side can still see it (structured error object; gone across `invoke`). */
  code?: string
  /** Any diagnostic detail the error carried, if reachable on this side. */
  detail?: string
}

/**
 * Describe a caught value for display without discarding anything.
 *
 * `message` is `raw` with the IPC/AgentMuxError framing stripped; `raw` is the original, preserved so
 * the failure stays diagnosable. `code`/`detail` are populated only when the value is a structured
 * error object that still carries them (they do not survive an `ipcRenderer.invoke` rejection).
 */
export function describeError(cause: unknown): PresentedError {
  const raw = rawText(cause)
  const message = raw.replace(IPC_INVOKE_PREFIX, '').replace(AGENTMUX_ERROR_NAME_PREFIX, '')
  const code = stringField(cause, 'code')
  const detail = stringField(cause, 'detail')
  return {
    // raw is carried unchanged: this is the promise that the diagnosable original is not swallowed.
    raw,
    message,
    ...(code ? { code } : {}),
    ...(detail ? { detail } : {})
  }
}

/**
 * The caught-error → banner string used by every renderer error sink.
 *
 * This is the sanctioned terminus: the humanization detector (test/error-sink-humanization.test.ts)
 * requires that any display string derived from a caught (`unknown`/`Error`) value reach an error sink
 * only through this call. It deliberately does NOT invent copy for unknown codes — it returns the real
 * (de-framed) message, so the diagnosable detail always reaches the user. Domain-specific humanizers
 * (git remote, control addressing, PR eligibility) run BEFORE this and pass their curated strings to the
 * sink directly; this is the floor for everything they do not recognize.
 */
export function presentError(cause: unknown): string {
  return describeError(cause).message
}
