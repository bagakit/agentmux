import { describe, expect, it } from 'vitest'
import { AgentMuxError } from '@agentmux/core'
import { describeError, presentError } from '../src/renderer/src/lib/error-presentation'

// The presenter's whole reason to exist is #197: a caught error becomes user text in exactly one place,
// transport framing removed, and the diagnosable original NEVER thrown away. These assertions pin both
// halves — the cleaning and the anti-swallow guarantee — so that neither can silently regress.

describe('presentError strips transport framing', () => {
  it('removes the Electron ipcRenderer.invoke wrapper', () => {
    const framed = new Error(
      "Error invoking remote method 'browser:deleteProfile': Error: The default Browser Profile cannot be deleted"
    )
    // Before #197 the panels showed this wrapper verbatim; the store stripped it and they did not.
    expect(presentError(framed)).toBe('The default Browser Profile cannot be deleted')
  })

  it('removes the AgentMuxError name prefix left inside the reframed message', () => {
    const framed = new Error(
      "Error invoking remote method 'workspaces:add': AgentMuxError: Workspace path is not a regular file"
    )
    expect(presentError(framed)).toBe('Workspace path is not a regular file')
  })

  it('leaves an unframed message untouched, including a legitimate colon', () => {
    expect(presentError(new Error('Unknown Browser Profile: abc-123'))).toBe('Unknown Browser Profile: abc-123')
  })

  it('does not strip a name-like prefix that is the message itself, not invoke framing', () => {
    // The `<Ident>:` strip is scoped to the invoke wrapper. A message that merely happens to start with
    // a capitalized word and colon, with NO wrapper, must survive intact — over-stripping here would
    // delete real content (this is the failure mode a bare `^Word:` strip would cause).
    expect(presentError(new Error('Warning: disk almost full'))).toBe('Warning: disk almost full')
  })

  it('renders a non-Error rejection through String() rather than dropping it', () => {
    expect(presentError('bare string reason')).toBe('bare string reason')
    expect(presentError(42)).toBe('42')
  })
})

describe('describeError never swallows the diagnosable original', () => {
  it('keeps raw verbatim even when message trims a wrapper', () => {
    const original =
      "Error invoking remote method 'browser:deleteProfile': Error: The default Browser Profile cannot be deleted"
    const described = describeError(new Error(original))
    // This is the anti-swallow contract made structural. If the implementation stops carrying the
    // untouched original — the failure this module exists to prevent (a humanizer that destroys the one
    // piece of diagnosable detail the user could relay) — this equality reds. Deleting the `raw` line in
    // describeError makes `raw` undefined and fails here; substituting `message` for it fails here too,
    // because the wrapper would then be gone from raw as well.
    expect(described.raw).toBe(original)
    expect(described.message).toBe('The default Browser Profile cannot be deleted')
    // And the two are genuinely different for a framed error — proving raw is not just an alias of the
    // cleaned message (which would also swallow the wrapper).
    expect(described.raw).not.toBe(described.message)
  })

  it('surfaces code and detail when the error object still carries them (structured, not via invoke)', () => {
    const described = describeError(new AgentMuxError('boom', 'SOME_CODE', 'diagnostic detail'))
    expect(described.code).toBe('SOME_CODE')
    expect(described.detail).toBe('diagnostic detail')
    expect(described.raw).toBe('boom')
  })

  it('omits code and detail when the caught value cannot carry them (the invoke path)', () => {
    // Across ipcRenderer.invoke, Electron delivers only a reframed message; code/detail are gone. The
    // presenter must not fabricate them. A plain Error models exactly that post-IPC value.
    const described = describeError(new Error('plain post-IPC message'))
    expect(described.code).toBeUndefined()
    expect(described.detail).toBeUndefined()
  })

  it('ignores empty-string code/detail rather than reporting them as present', () => {
    const described = describeError(Object.assign(new Error('x'), { code: '', detail: '' }))
    expect(described.code).toBeUndefined()
    expect(described.detail).toBeUndefined()
  })
})
