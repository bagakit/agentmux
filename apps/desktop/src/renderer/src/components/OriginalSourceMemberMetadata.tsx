import type { MountedSessionFact } from '../lib/space-mount-sessions'

/** Original Source metadata only; this never grants a local Session or Run. */
export function OriginalSourceMemberMetadata({ current, last, stale, error }: { current?: MountedSessionFact | undefined; last?: MountedSessionFact | undefined; stale?: boolean | undefined; error?: string | undefined }) {
  const state = current?.state, confirmed = state?.status === 'observed' && !stale ? state : last?.state.status === 'observed' ? last.state : undefined
  const currentObserved = state?.status === 'observed' && !stale
  const issue = error ?? (state?.status === 'unknown' || state?.status === 'unavailable' ? state.issue.message : undefined)
  return <div className="mounted-session-metadata" role="status">
    {!currentObserved ? <strong>{confirmed ? 'Last confirmed Session metadata' : state?.status === 'missing' ? 'Original Session not returned by its Core' : 'Original Session metadata unconfirmed'}</strong> : null}
    {confirmed ? <span>{confirmed.session.providerId} · {confirmed.session.semanticStatus?.state ?? 'Semantic state not observed'}</span> : null}
    {issue ? <p>{issue}</p> : null}
    {confirmed ? <details><summary>Session observation</summary><dl><div><dt>Original Core</dt><dd><code>{confirmed.authority.runtimeId}</code></dd></div><div><dt>Original Run</dt><dd><code>{confirmed.session.run.runId}</code></dd></div></dl></details> : null}
  </div>
}
