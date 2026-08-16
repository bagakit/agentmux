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

// A zod schema rejection — config-store's `superRefine` (unique workspace path, host ids, known
// Provider) and every other `z.parse` in the main process — surfaces as its `.message`, which zod
// serialises as the JSON array of `{ code, path, message }` issues. Across `ipcRenderer.invoke` that
// array IS the reframed message: there is no `ZodError` instance left on this side to call
// `.flatten()` on, only the text. So a user re-picking an already-registered folder saw the literal
// `[ { "code": "custom", "path": [ "workspaces", 32, "path" ], "message": "Workspace path must be
// unique on local: …" } ]` — the schema's internals verbatim.
//
// This lifts the issues' OWN authored messages out of that envelope. It is deliberately NOT the
// code→sentence table the header rules out, and it satisfies all three of that argument's facts: it
// invents no copy and keys on no code (the human sentence is the one zod already wrote), and it works
// on the message-only `invoke` path precisely because the array arrives AS the message. It is the same
// class of move as stripping the IPC wrapper above — removing framing, never content — so `raw` still
// carries the untouched array and the failure stays diagnosable.
//
// Two shapes need more than reading each issue's top-level `.message`:
//
//  1. A `z.union` / `z.discriminatedUnion` rejection with sub-branch failures serialises as ONE outer
//     issue `{ code:'invalid_union', errors:[[…sub-issues…]], message:'Invalid input' }`, and a
//     `z.record` whose KEY schema rejects serialises as `{ code:'invalid_key', issues:[…], message:
//     'Invalid key in record' }`. Both outer messages are generic and name no field; the real reason
//     lives in the nested sub-issues (`.errors` is an array-of-branches, each an array of sub-issues;
//     `.issues` is a flat array). config-store's host schema is a `z.discriminatedUnion('kind', …)` and
//     its executors are a `z.record(<regex id>, …)`, so a malformed host or executor id hits exactly
//     this. We descend both containers (sub-issue `.path` is RELATIVE to the node) and surface the real
//     leaves; a leaf-only issue has neither container and is read directly.
//  2. A zod built-in message names no field ("Invalid input: expected string, received undefined").
//     The field IS in the issue `.path`, so such a leaf is prefixed with its dotted path
//     (`hosts.0.hostname`) — dotted, not `[0]`, so no `[` bracket re-enters the cleaned message. A
//     `custom` issue is the exception: its message is author-written (config-store's refinements say
//     "Workspace path must be unique on local: …" and already name the field), so it is surfaced
//     verbatim — a machine path prefix there is redundant noise and would leak a meaningless index.
//
// Dedup counts rather than drops: three workspaces colliding on one location are three issues whose
// distinct paths make three lines; genuinely identical leaves (e.g. one `unrecognized_keys` repeated
// across union branches) collapse to `… (×N)` so the count is never hidden. Output is bounded — before
// this the join had no cap and a rejection with hundreds of issues ran to thousands of chars; now it
// shows the first few lines and an `and N more` tail. The char budget is spent on WHOLE lines with room
// held back for that tail, so the count the dedup exists to show is never the part truncated away.

// Our own schemas nest a union at most a couple of levels; this only stops a pathological input from
// driving unbounded recursion. Past it, the union's own outer message ("Invalid input") is the floor.
const MAX_UNION_DEPTH = 4
// Distinct lines shown, and a hard char cap as backstop; the rest becomes "and N more".
const MAX_ISSUE_LINES = 8
const MAX_TOTAL_CHARS = 500

/** A zod issue `.path` as a dotted field label. `['hosts',0,'hostname']` → `hosts.0.hostname`; `[]` → ''. */
function formatIssuePath(path: unknown): string {
  if (!Array.isArray(path)) return ''
  return path.filter((segment) => typeof segment === 'string' || typeof segment === 'number').join('.')
}

/**
 * Flatten one zod issue into its user-facing leaf line(s), appending to `out`.
 *
 * `basePath` is the absolute path to this issue; sub-issue paths under a container are relative, so
 * they are appended to it. Two containers hide their real reason behind a generic outer message and are
 * descended: `invalid_union` (`.errors`, an array-of-branches — each branch an array of sub-issues) and
 * `invalid_key` (`.issues`, a flat array — a record whose key schema rejected). Falls back to the
 * issue's own message when it has no sub-issues (a plain leaf, e.g. a discriminator mismatch whose
 * message IS meaningful), when descending yields nothing usable, or at the depth ceiling.
 */
function collectIssueLeaves(
  issue: Record<string, unknown>,
  basePath: unknown[],
  depth: number,
  out: string[]
): void {
  const issuePath = Array.isArray(issue.path) ? issue.path : []
  const path = [...basePath, ...issuePath]
  // `invalid_union` nests one array per branch; `invalid_key` nests a flat array. Flatten to sub-issues.
  const nested =
    issue.code === 'invalid_union' && Array.isArray(issue.errors)
      ? issue.errors.flat()
      : issue.code === 'invalid_key' && Array.isArray(issue.issues)
        ? issue.issues
        : undefined
  if (nested && nested.length > 0 && depth < MAX_UNION_DEPTH) {
    const before = out.length
    for (const sub of nested) {
      if (typeof sub === 'object' && sub !== null) {
        collectIssueLeaves(sub as Record<string, unknown>, path, depth + 1, out)
      }
    }
    // Descending produced real leaves — done. Otherwise fall through to the outer message as the floor.
    if (out.length > before) return
  }
  const message = typeof issue.message === 'string' ? issue.message : ''
  if (message.length === 0) return
  // A `custom` issue's message is author-written and already self-describing (config-store's
  // refinements name the field); everything else is a zod built-in template that names no field, so we
  // prefix its dotted path. The root (`path: []`) has no label to add regardless.
  const label = issue.code === 'custom' ? '' : formatIssuePath(path)
  out.push(label ? `${label}: ${message}` : message)
}

/**
 * Order-preserving dedup that counts (never drops) collisions, then bounds the output.
 *
 * The budget is spent on WHOLE lines, and the `and N more` tail is reserved for FIRST — never appended
 * and then sliced off. Otherwise a handful of long lines (real filesystem paths) would eat the budget
 * and truncate away the very count this dedup exists to surface (finding: 6 long collisions hit the cap
 * and lost the tail). A single line longer than the whole budget is still truncated with an ellipsis so
 * one pathological message cannot blow the banner.
 */
function joinIssueLeaves(leaves: string[]): string {
  const counts = new Map<string, number>()
  const order: string[] = []
  for (const leaf of leaves) {
    if (!counts.has(leaf)) order.push(leaf)
    counts.set(leaf, (counts.get(leaf) ?? 0) + 1)
  }
  const lines = order.map((leaf) => {
    const count = counts.get(leaf) ?? 1
    return count > 1 ? `${leaf} (×${count})` : leaf
  })
  const shown: string[] = []
  for (const line of lines) {
    if (shown.length >= MAX_ISSUE_LINES) break
    const withLine = [...shown, line].join('; ')
    const remaining = lines.length - shown.length - 1
    // Reserve room for the tail this line would force, so it is never the part that gets cut.
    const tail = remaining > 0 ? `; and ${remaining} more` : ''
    if (shown.length > 0 && withLine.length + tail.length > MAX_TOTAL_CHARS) break
    shown.push(line)
  }
  const hidden = order.length - shown.length
  if (hidden > 0) shown.push(`and ${hidden} more`)
  const result = shown.join('; ')
  // Backstop: a single leaf wider than the whole budget still gets clipped.
  return result.length > MAX_TOTAL_CHARS ? `${result.slice(0, MAX_TOTAL_CHARS - 1)}…` : result
}

function unwrapZodIssueMessages(message: string): string | undefined {
  if (message.trimStart()[0] !== '[') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(message)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined
  for (const issue of parsed) {
    // Every top-level element must be a zod issue carrying a non-empty string `.message`. One that is
    // not means this array is not a zod error — a real message that merely begins with `[` — so leave
    // it entirely untouched rather than half-rewrite something we do not understand.
    if (typeof issue !== 'object' || issue === null) return undefined
    const text = (issue as { message?: unknown }).message
    if (typeof text !== 'string' || text.length === 0) return undefined
  }
  const leaves: string[] = []
  for (const issue of parsed) collectIssueLeaves(issue as Record<string, unknown>, [], 0, leaves)
  if (leaves.length === 0) return undefined
  return joinIssueLeaves(leaves)
}

// `main/prompt-readiness-diagnostics.ts` is the ONE place that appends a machine detail to a
// user-facing sentence (`${message} Diagnostic: ${detail}` — grep `Diagnostic: ` across src, it is a
// single construction site). What it appends is deliberately volatile: `promptReadinessDetail`
// (packages/core `prompt-submission.ts:42`) prints `latestOutputBytes=<run.latestOutputBytes>`, an
// output cursor that grows with every byte the Agent prints.
const DIAGNOSTIC_SUFFIX = /\s*Diagnostic:\s[\s\S]*$/u

/**
 * The stable identity of a presented error: which failure this is, with the volatile diagnostic
 * context removed.
 *
 * This exists because a user dismisses a *cause*, not a string. `reportError` deduped on whole-message
 * equality, and the readiness refusal carries `latestOutputBytes` in its `Diagnostic:` tail — so a
 * still-generating Agent made every re-report a *different* string, the equality never matched, and the
 * dismissed banner came back over and over (field report 2026-09-19; the diagnostic is the only part
 * that changed between them).
 *
 * Identity strips presentation context and keeps the sentence, so two reports of the same refusal
 * collapse while two different refusals stay distinct. It is NOT keyed on `AgentMuxError.code`: this
 * module's header documents that several codes carry different meanings at different throw sites
 * (`AGENT_PROMPT_READINESS_CONFLICT` spans two unrelated failures), so a code key would over-dedup —
 * suppressing a genuinely new failure is worse than showing one twice. Codes also do not survive
 * `ipcRenderer.invoke`, which is the path this defect was reported on.
 *
 * Apply it to BOTH sides of a comparison — never store an identity next to the message it came from and
 * compare those, or the two keys drift apart the moment one write site forgets.
 */
export function errorIdentity(message: string): string {
  return message.replace(DIAGNOSTIC_SUFFIX, '').trimEnd()
}

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
  const deframed = raw.replace(IPC_INVOKE_PREFIX, '').replace(AGENTMUX_ERROR_NAME_PREFIX, '')
  // A schema rejection arrives as the JSON issue array; surface the issues' own messages instead of the
  // envelope. Runs after wrapper-stripping because a rejection thrown across `invoke` reaches us as
  // `Error invoking remote method '<channel>': <the array>`, so the array is only bare once the wrapper
  // is gone. Falls back to the de-framed text when this is not a zod issue array.
  const message = unwrapZodIssueMessages(deframed) ?? deframed
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
