import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { describeError, presentError } from '../src/renderer/src/lib/error-presentation'

// A union rejection must name the field that failed, and dedup must not hide how many rows conflict.
//
// The audit that found this ran against zod 4.4.3. The two behaviours pinned here:
//
//  1. A `z.union` / `z.discriminatedUnion` rejection serialises as ONE outer issue
//     `{ code:'invalid_union', errors:[[…sub-issues…]], message:'Invalid input' }`. Reading only the
//     outer `.message` gives the user the literal words "Invalid input" — no field, WORSE than the raw
//     envelope for diagnosis. config-store's host schema is a `z.discriminatedUnion('kind', …)`.
//  2. Set-dedup collapsed N identical messages to one line, so three workspaces colliding on one
//     location read as a single conflict.
//
// Every fixture below is REAL zod output: an actual schema rejects an actual bad value and we serialise
// the `.message` zod really produced (`fromZod`), then wrap it the way Electron reframes a main-process
// throw across `ipcRenderer.invoke`. A hand-written "what zod probably emits" fixture would prove
// nothing — it would be the presenter certifying itself.

/** The exact text a zod rejection becomes on the renderer side: the invoke wrapper, then zod's */
/** serialised issue array as the reframed message. Mirrors error-presentation-zod-leak.test.ts. */
function fromZod(schema: z.ZodType, badValue: unknown): Error {
  let issueArray = ''
  try {
    schema.parse(badValue)
    throw new Error('schema unexpectedly accepted the value — fixture is not exercising a rejection')
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error
    issueArray = error.message
  }
  return new Error(`Error invoking remote method 'workspaces:chooseLocalFolder': ${issueArray}`)
}

// The real config-store host schema (apps/desktop/src/main/config-store.ts:19), copied so this test
// exercises the exact construct — a discriminatedUnion on 'kind' — that produces the collapse.
const hostSchema = z.discriminatedUnion('kind', [
  z.object({ id: z.literal('local'), kind: z.literal('local'), label: z.string().min(1) }).strict(),
  z
    .object({
      id: z.string().min(1),
      kind: z.literal('ssh'),
      label: z.string().min(1),
      hostname: z.string().min(1)
    })
    .strict()
])
const configSchema = z.object({ hosts: z.array(hostSchema) }).strict()

describe('a union rejection names the failing field instead of collapsing to "Invalid input"', () => {
  it('surfaces the discriminator error and its field path, not the bare outer message', () => {
    // A host with an unknown `kind`. Real zod emits an invalid_union issue whose OWN message is the
    // descriptive "Invalid discriminator value…" (errors: []). The pre-fix unwrapper already returned
    // that message — but stripped the path, so the user never learned WHICH host. Now the path leads.
    const seen = fromZod(configSchema, { hosts: [{ id: 'x', kind: 'telnet', label: 'y' }] })
    const message = presentError(seen)
    expect(message).toContain("Invalid discriminator value. Expected 'local' | 'ssh'")
    expect(message).toContain('hosts.0.kind')
    expect(message).not.toContain('[')
  })

  it('descends a plain z.union collapse and names the fields, never showing bare "Invalid input"', () => {
    // This is the pure defect: a z.union where no branch matches. Real zod emits
    // { code:'invalid_union', message:'Invalid input', errors:[[…],[…]] }. The pre-fix unwrapper read
    // only that outer message and showed the user "Invalid input" with no field named.
    const union = z.union([z.object({ a: z.string() }).strict(), z.object({ b: z.number() }).strict()])
    const seen = fromZod(z.object({ node: union }).strict(), { node: { c: true } })
    const message = presentError(seen)
    // The real branch leaves reach the user, each carrying its field path…
    expect(message).toContain('node.a')
    expect(message).toContain('node.b')
    // …and the useless bare collapse word is not the whole message.
    expect(message).not.toBe('Invalid input')
    expect(message).not.toContain('[')
  })

  it('names the field for a matched-branch field error too (valid discriminant, bad field)', () => {
    // ssh branch matches on kind but hostname is missing. Real zod reports invalid_type at the field;
    // its message ("Invalid input: expected string, received undefined") names nothing on its own.
    const seen = fromZod(configSchema, { hosts: [{ id: 'x', kind: 'ssh', label: 'y' }] })
    expect(presentError(seen)).toContain('hosts.0.hostname')
  })

  it('reconstructs the absolute path for a union nested inside a matched branch', () => {
    // discriminatedUnion whose matched branch holds a nested z.union that fails. Real zod nests the
    // collapse under the branch, and the sub-issue paths are RELATIVE to that inner union — so the outer
    // path must be prepended or the field name is wrong.
    const nested = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), payload: z.union([z.string(), z.number()]) }).strict()
    ])
    const seen = fromZod(z.object({ node: nested }).strict(), { node: { kind: 'a', payload: true } })
    const message = presentError(seen)
    expect(message).toContain('node.payload')
    // `toContain('node.payload')` alone is satisfied by the NON-descending world too: without the
    // descent the outer collapse still carries the absolute path and prints `node.payload: Invalid
    // input`. So the path assertion above proves the prepend, not the descent — the reason has to be
    // asserted separately or this case silently passes while showing the exact string this module exists
    // to eliminate.
    expect(message).toContain('expected string, received boolean')
    expect(message).not.toMatch(/:\s*Invalid input$/)
  })
})

describe('dedup counts colliding issues instead of hiding them', () => {
  // The real config-store collision refinement: three workspaces on one location add three `custom`
  // issues with the SAME authored message at different paths. Author-written messages already name the
  // field, so they are surfaced verbatim (no machine path prefix) — which makes the three identical, so
  // the count is what carries "three rows conflict".
  function collisions(...paths: number[]): Error {
    const schema = z.object({ workspaces: z.array(z.object({ path: z.string() })) }).superRefine((_c, context) => {
      for (const index of paths) {
        context.addIssue({
          code: 'custom',
          path: ['workspaces', index, 'path'],
          message: 'Workspace path must be unique on local: /same'
        })
      }
    })
    return fromZod(schema, { workspaces: [{ path: 'x' }] })
  }

  it('shows the count when three rows collide on one location', () => {
    const message = presentError(collisions(0, 1, 2))
    expect(message).toBe('Workspace path must be unique on local: /same (×3)')
  })

  it('does not annotate a single collision with a count', () => {
    expect(presentError(collisions(0))).toBe('Workspace path must be unique on local: /same')
  })
})

describe('output stays a banner under a flood of issues', () => {
  function manyDistinct(count: number): Error {
    const schema = z.object({ workspaces: z.array(z.object({ path: z.string() })) }).superRefine((_c, context) => {
      for (let index = 0; index < count; index += 1) {
        context.addIssue({ code: 'custom', path: ['workspaces', index, 'path'], message: `Problem ${index}` })
      }
    })
    return fromZod(schema, { workspaces: [{ path: 'x' }] })
  }

  it('caps the number of lines and appends an "and N more" tail', () => {
    const message = presentError(manyDistinct(200))
    expect(message).toContain('Problem 0')
    expect(message).toContain('and 192 more') // 200 issues − 8 shown
    expect(message).not.toContain('Problem 100')
  })

  it('bounds total length well under the raw array', () => {
    const seen = manyDistinct(200)
    expect(presentError(seen).length).toBeLessThan(600)
    // The raw envelope is still the full, untouched array — nothing swallowed.
    expect(describeError(seen).raw.length).toBeGreaterThan(3000)
  })

  it('keeps the count tail when a few long-path collisions would otherwise blow the char budget', () => {
    // The bug this guards: the char cap used to append "and N more" and THEN slice it off, so a run of
    // real-length messages truncated away the very count the dedup exists to show. The budget must be
    // spent on whole lines with room reserved for the tail. The fixture sits on the boundary where the
    // last line fits WITHOUT the tail but not WITH it — the exact case the reservation exists for: strip
    // the reservation and the join runs to the 500-char backstop and severs the tail with an ellipsis.
    const pad = 'p'.repeat(58)
    const schema = z.object({ workspaces: z.array(z.object({ path: z.string() })) }).superRefine((_c, context) => {
      for (let index = 0; index < 30; index += 1) {
        context.addIssue({ code: 'custom', path: ['workspaces', index, 'path'], message: `u${pad}${index}` })
      }
    })
    const message = presentError(fromZod(schema, { workspaces: [{ path: 'x' }] }))
    expect(message.length).toBeLessThanOrEqual(500)
    // The count reaches the user as an intact "and N more" tail, not a severed ellipsis.
    expect(message).toMatch(/and \d+ more$/)
    expect(message.endsWith('…')).toBe(false)
  })

  it('still clips a single leaf that is wider than the whole budget', () => {
    // One pathological message longer than the entire char budget cannot be shown whole; the ellipsis
    // backstop keeps even that a banner.
    const schema = z.object({ p: z.string() }).superRefine((_c, context) => {
      context.addIssue({ code: 'custom', path: ['p'], message: 'y'.repeat(900) })
    })
    const message = presentError(fromZod(schema, { p: 'x' }))
    expect(message.length).toBe(500)
    expect(message.endsWith('…')).toBe(true)
  })
})

describe('a record with a rejected key names the key and its real reason, not "Invalid key in record"', () => {
  it('descends invalid_key .issues so the executor-id regex reason survives', () => {
    // config-store's executors are z.record(<regex id>, …) (config-store.ts:95). A malformed executor id
    // serialises as { code:'invalid_key', message:'Invalid key in record', issues:[<the regex reason>] } —
    // the same generic-outer-message trap as a union collapse, but nested under `.issues`, not `.errors`.
    const executorIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)
    const schema = z
      .object({ executors: z.record(executorIdSchema, z.object({ providerId: z.string().min(1) }).strict()) })
      .strict()
    const message = presentError(fromZod(schema, { executors: { '!!bad': { providerId: 'p' } } }))
    // The key is named…
    expect(message).toContain('executors.!!bad')
    // …and the real reason (the regex it failed) reaches the user instead of the generic outer message.
    expect(message).toContain('must match pattern')
    expect(message).not.toBe('Invalid key in record')
    // The JSON envelope is gone — no issue-object keys leak. (Not `not.toContain('[')`: the regex reason
    // legitimately contains a `[…]` character class, which is real content, not envelope.)
    expect(message).not.toContain('"code"')
    expect(message).not.toContain('"issues"')
  })
})

describe('the anti-swallow guarantee survives the new unwrapping', () => {
  it('keeps raw verbatim for a union rejection while message names the field', () => {
    const seen = fromZod(configSchema, { hosts: [{ id: 'x', kind: 'telnet', label: 'y' }] })
    const described = describeError(seen)
    expect(described.raw).toBe(seen.message)
    expect(described.raw).toContain('"code"')
    expect(described.message).not.toContain('"code"')
    expect(described.message).toContain('hosts.0.kind')
  })
})
