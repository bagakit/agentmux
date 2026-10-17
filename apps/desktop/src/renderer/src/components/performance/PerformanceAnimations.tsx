import type { RendererAnimationsResult } from '@agentmux/core/control'

const milliseconds = (value: number | 'auto' | 'infinite' | null) => value === null ? 'Unknown'
  : typeof value === 'number' ? `${value.toFixed(1)} ms` : value

/** Native playback facts and element labels are observations, never CPU weights. */
export function AnimationInspectionResult({ result, sourceChanged, onExport }: {
  result: RendererAnimationsResult; sourceChanged: boolean; onExport(): void
}) {
  const snapshot = result.snapshot
  return <section className="performance-capture-result" aria-label="Animation inspection result">
    {sourceChanged ? <p className="performance-state">Showing the original inspected process. Current window readings changed; this result was not reassigned.</p> : null}
    <div className="performance-section-heading"><strong>Animation instances</strong><span>{result.status}</span></div>
    <p className="performance-note">PID {result.target.pid} · generation {result.target.generation} · source verified {String(result.sourceVerified.before)} / {String(result.sourceVerified.after)}</p>
    {result.status !== 'completed' ? <p className="performance-state" data-tone="warning">{result.status === 'unknown' ? 'The original query or its source is unconfirmed.' : 'The animation query did not complete.'} {result.issues.map(issue => `${issue.stage}: ${issue.message}`).join(' · ')}</p> : null}
    <p className="performance-note">This document only. Playback state and element labels do not measure CPU cost or visibility. Compare with the original timeline.</p>
    {snapshot ? <>
      <p className="performance-note">{snapshot.totalAnimations} observed · {snapshot.animations.length} returned · {snapshot.omittedAnimations} omitted</p>
      <div aria-label="Observed animation instances">
        {snapshot.animations.map((animation, index) => <details className="performance-disclosure" key={index}>
          <summary>{animation.name === null || animation.name === '' ? 'Unnamed animation' : animation.name} · {animation.playState}{animation.pending ? ' · pending' : ''}</summary>
          <dl className="performance-facts">
            <dt>Kind</dt><dd>{animation.kind}</dd>
            <dt>Current time</dt><dd>{milliseconds(animation.currentTime)}</dd>
            <dt>Duration</dt><dd>{milliseconds(animation.duration)}</dd>
            <dt>Iterations</dt><dd>{animation.iterations === null ? 'Unknown' : animation.iterations}</dd>
            <dt>Nearest elements</dt><dd>{animation.ancestry === null || animation.ancestry.length === 0 ? 'Element labels unavailable' : animation.ancestry.join(' ← ')}</dd>
          </dl>
          {animation.stringsTruncated || animation.targetTruncated ? <p className="performance-note">Some labels or element ancestry were shortened.</p> : null}
        </details>)}
      </div>
    </> : null}
    <div className="performance-capture-actions"><button type="button" onClick={onExport}>Export animation inspection</button></div>
    <details className="performance-disclosure"><summary>Inspection receipt</summary><pre className="performance-capture-receipt">{JSON.stringify(result, null, 2)}</pre></details>
  </section>
}
