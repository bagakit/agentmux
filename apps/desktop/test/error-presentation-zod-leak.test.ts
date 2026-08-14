import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { describeError, presentError } from '../src/renderer/src/lib/error-presentation'

// A schema rejection must never reach a human as the JSON issue array. This is the leak the user hit:
// re-picking an already-registered folder surfaced the literal
// `[ { "code": "custom", "path": [ "workspaces", 32, "path" ], "message": "Workspace path must be
// unique on local: …" } ]`. The array IS the reframed message across `ipcRenderer.invoke` (there is no
// ZodError instance left on the renderer side), so the fix lives in the caught-value presenter, not in
// any handler. These pin that the issues' own messages are lifted out and the schema envelope never
// reaches the banner — while `raw` still carries the untouched array so the failure stays diagnosable.

/** The exact text a config-store refinement rejection becomes once it crosses `invoke`: the wrapper, */
/** then zod's serialised issue array as the reframed message. */
function refinementRejectionAsSeenByRenderer(...messages: string[]): Error {
  const schema = z
    .object({ workspaces: z.array(z.object({ path: z.string() })) })
    .superRefine((_config, context) => {
      for (const message of messages) {
        context.addIssue({ code: 'custom', path: ['workspaces', 32, 'path'], message })
      }
    })
  let issueArray = ''
  try {
    schema.parse({ workspaces: [{ path: 'x' }] })
  } catch (error) {
    issueArray = (error as Error).message
  }
  // Wrap it the way Electron reframes a main-process throw crossing ipcRenderer.invoke.
  return new Error(`Error invoking remote method 'workspaces:chooseLocalFolder': ${issueArray}`)
}

describe('a zod issue array never reaches the user as schema internals', () => {
  it('surfaces the issue message, not the JSON envelope, for the exact bug the user hit', () => {
    const seen = refinementRejectionAsSeenByRenderer(
      'Workspace path must be unique on local: /Users/bytedance/proj/github/deepseek-harness'
    )
    const message = presentError(seen)
    expect(message).toBe('Workspace path must be unique on local: /Users/bytedance/proj/github/deepseek-harness')
    // The envelope is gone: no bracket, no "code", no "path" key from the schema internals.
    expect(message).not.toContain('[')
    expect(message).not.toContain('"code"')
    expect(message).not.toContain('"path"')
  })

  it('joins multiple issues by their own messages rather than dumping the array', () => {
    const seen = refinementRejectionAsSeenByRenderer('First problem', 'Second problem')
    expect(presentError(seen)).toBe('First problem; Second problem')
  })

  it('keeps raw verbatim — the diagnosable original is not swallowed', () => {
    const seen = refinementRejectionAsSeenByRenderer('Workspace path must be unique on local: /x')
    const described = describeError(seen)
    // raw is the untouched original (wrapper + full JSON array); message is the lifted issue text.
    expect(described.raw).toBe(seen.message)
    expect(described.raw).toContain('"code"')
    expect(described.message).not.toContain('"code"')
    expect(described.message).toBe('Workspace path must be unique on local: /x')
  })

  it('leaves a real message that merely begins with "[" untouched', () => {
    // Not every string starting with `[` is a zod issue array. A genuine message must survive intact —
    // over-unwrapping here would be the same over-stripping failure the wrapper regex guards against.
    expect(presentError(new Error('[draft] could not be saved'))).toBe('[draft] could not be saved')
  })

  it('leaves a JSON array that is not zod issues untouched', () => {
    // A parseable array whose elements are not issue objects with string messages is not a schema error;
    // rewriting it would corrupt real content, so it is returned as-is.
    expect(presentError(new Error('[1, 2, 3]'))).toBe('[1, 2, 3]')
  })
})
