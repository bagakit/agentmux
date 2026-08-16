import { afterEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AgentMuxError } from '@agentmux/core'
import { describeError, errorIdentity, presentError } from '../src/renderer/src/lib/error-presentation'
import { useAppStore } from '../src/renderer/src/store'

const initialStore = useAppStore.getState()

afterEach(() => useAppStore.setState(initialStore, true))

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

describe('transient error lifecycle', () => {
  it('dismisses only the surface and can reopen the latest message', () => {
    useAppStore.getState().reportError(new Error('Readiness observation is still pending'))
    expect(useAppStore.getState()).toMatchObject({
      error: 'Readiness observation is still pending',
      lastError: 'Readiness observation is still pending',
      errorDismissed: false
    })

    useAppStore.getState().dismissError()
    expect(useAppStore.getState()).toMatchObject({
      error: 'Readiness observation is still pending',
      lastError: 'Readiness observation is still pending',
      errorDismissed: true
    })

    useAppStore.getState().reopenError()
    expect(useAppStore.getState()).toMatchObject({
      error: 'Readiness observation is still pending',
      errorDismissed: false
    })
  })

  // The case above feeds a CONSTANT message, so it is blind to the defect users actually hit: it never
  // constructs "same cause, diagnostic changed", which is the only input whole-string dedup fails on.
  // These three do. The field report (2026-09-19) is verbatim: the readiness refusal below differs
  // between reports ONLY in `latestOutputBytes`, which grows with every byte the Agent prints.
  const readinessRefusal = (latestOutputBytes: number) =>
    new Error(
      "Error invoking remote method 'agents:sendPrompt': AgentMuxError: The prompt was not sent because"
      + ' this Run has no consumable composer readiness yet. The Agent Run is still running; wait for the'
      + ' Stop/screen readiness observation to finish, then send again.'
      + ' Diagnostic: runId=f652d14b readinessId=none readinessSource=none readyThroughByte=pending'
      + ` latestOutputBytes=${latestOutputBytes} reason=epoch-missing`
    )

  it('keeps a dismissal when the same failure re-reports with a grown diagnostic cursor', () => {
    useAppStore.getState().reportError(readinessRefusal(549373))
    useAppStore.getState().dismissError()

    // Same refusal, Agent printed more output meanwhile. The user dismissed THIS FAILURE; the only thing
    // that changed is a byte counter in the machine detail. Reverting reportError to whole-string equality
    // makes `errorDismissed` flip back to false here — that is the mutation criterion for this test.
    useAppStore.getState().reportError(readinessRefusal(549512))
    expect(useAppStore.getState().errorDismissed, '关掉的错又回来了：去重键把易变诊断算进了身份').toBe(true)

    // Dismissal suppresses the banner but must not rewrite history: reopen still yields a diagnostic the
    // user can paste. Probed rather than assumed — it is the FIRST report's cursor (549373, not 549512),
    // because a suppressed report writes nothing. That is deliberate: refreshing the remembered text would
    // mean a store write per replayed event, and the stale part is only the byte counter — runId,
    // readinessId and `reason=epoch-missing` are identical across the two, so nothing diagnosable is lost.
    // The exact number is pinned rather than `toContain('latestOutputBytes=')`, which passed under BOTH
    // behaviours and so recorded nothing.
    useAppStore.getState().reopenError()
    expect(useAppStore.getState().error).toContain('latestOutputBytes=549373')
  })

  it('still surfaces a genuinely different failure after a dismissal', () => {
    useAppStore.getState().reportError(readinessRefusal(549373))
    useAppStore.getState().dismissError()

    // The other half of the ratchet. Stripping the diagnostic must not collapse distinct failures into
    // one — over-dedup would silently swallow a NEW problem, which is worse than showing one twice.
    // Mutation: make errorIdentity return a constant and this reds.
    useAppStore.getState().reportError(new Error('The workspace folder is no longer readable'))
    expect(useAppStore.getState()).toMatchObject({
      error: 'The workspace folder is no longer readable',
      errorDismissed: false
    })
  })

  it('suppresses a repeat only while it is dismissed, not after the user reopens it', () => {
    useAppStore.getState().reportError(readinessRefusal(1))
    useAppStore.getState().dismissError()
    useAppStore.getState().reopenError()

    // Reopening is the user asking to watch this failure again; a later report of it must update the
    // shown text rather than be swallowed by the identity check.
    useAppStore.getState().reportError(readinessRefusal(2))
    expect(useAppStore.getState().error).toContain('latestOutputBytes=2')
    expect(useAppStore.getState().errorDismissed).toBe(false)
  })
})

// Fixing the one dedup site is not enough on its own, but the guard has to state a property that is
// actually TRUE, and my first attempt did not. I tried "every label appended after a complete message
// must be stripped from identity" — and the scan refuted it: `${primary.message} Cleanup failed:
// ${presentError(cleanupError)}` (store.ts) appends a *cause*, and two different cleanup failures are
// genuinely two failures. Stripping that would OVER-dedup, silently swallowing a new problem. Source text
// cannot tell `${diagnostic}` (a volatile cursor) from `${presentError(e)}` (a stable cause) apart.
//
// So the guard is the narrow thing that can actually break in silence: the label is authored in the MAIN
// process and stripped in the RENDERER, two files with no shared constant between them. Rename it on one
// side and today nothing reds — the dismissed banner just starts resurrecting again.
describe('the machine-detail label main appends is the one the renderer strips', () => {
  it('reads the label out of its construction site and proves errorIdentity removes it', () => {
    const site = fileURLToPath(new URL('../src/main/prompt-readiness-diagnostics.ts', import.meta.url))
    const source = readFileSync(site, 'utf8')
    // Both ends proven present: an empty read, or a regex that no longer recognizes the current writing,
    // would make every assertion below vacuously true (this repo's 扫到空内容 false-green family).
    expect(source.length, '读到空文件——路径写错了，下面的断言会恒真').toBeGreaterThan(500)
    const appended = source.match(/\$\{message\}\s+([A-Z][A-Za-z ]*):\s*\$\{/u)
    expect(appended, `${site} 里没扫到「消息后面追加机器细节」的写法——写法变了，本守卫已失明`).not.toBeNull()

    // The property: two reports differing ONLY inside that appended segment are the same failure.
    const label = appended![1]
    const message = 'The prompt was not sent because this Run has no consumable composer readiness yet.'
    expect(
      errorIdentity(`${message} ${label}: latestOutputBytes=549373 reason=epoch-missing`),
      `main 追加的是 "${label}:"，而 errorIdentity 不剥它——按它去重的错误会在游标一变时复活`
    ).toBe(errorIdentity(`${message} ${label}: latestOutputBytes=549512 reason=epoch-missing`))
    // …and identity still keeps the sentence, so it has not collapsed to a constant.
    expect(errorIdentity(`${message} ${label}: x=1`)).toBe(message)
  })
})
