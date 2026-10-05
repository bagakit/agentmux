import { useCallback, useEffect, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { BrowserTaskReliability as Reliability, BrowserTaskReliabilityResult } from '../../../shared/browser-task-reliability'
import type { BrowserOutcomeEvaluation } from '../../../shared/browser-outcome-criteria'

const ThemeStatusLoadingIcon = semanticIconComponent('status.loading')
const ThemeStatusWarningIcon = semanticIconComponent('status.warning')


const LABELS: Record<BrowserTaskReliabilityResult, string> = {
  passed: 'Outcome passed', 'not-met': 'Not satisfied', unavailable: 'Evidence unavailable', unknown: 'Outcome unknown',
  failed: 'Execution failed', stopped: 'Stopped', interrupted: 'Interrupted'
}
export type BrowserTaskReliabilityRequest = { browserId: string; assetId: string; version: number }

/** Only a completed, exact version verification invalidates that version's public read. */
export function useBrowserTaskReliabilityRefresh(browserId: string) {
  const [revisions, setRevisions] = useState<Record<string, number>>({})
  useEffect(() => setRevisions({}), [browserId])
  const markVerified = useCallback((evaluation: BrowserOutcomeEvaluation) => {
    if (evaluation.context.browserId !== browserId || !evaluation.assetRun) return
    const key = JSON.stringify([browserId, evaluation.assetRun.assetId, evaluation.assetRun.version])
    setRevisions(current => ({ ...current, [key]: (current[key] ?? 0) + 1 }))
  }, [browserId])
  return { markVerified, revisionFor: (assetId: string, version: number) => revisions[JSON.stringify([browserId, assetId, version])] ?? 0 }
}

function sampleTime(value: number | null): string {
  if (value === null) return 'unavailable'
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : 'unavailable'
}

/** The same public Main read supplies UI and CLI; this component never reconstructs outcome authority. */
export function BrowserTaskReliability({ browserId, assetId, version, refreshKey, load }: BrowserTaskReliabilityRequest & {
  refreshKey: string
  load: (input: BrowserTaskReliabilityRequest) => Promise<Reliability>
}) {
  const [state, setState] = useState<{ key: string; result?: Reliability; error?: string }>({ key: '' })
  const key = JSON.stringify([browserId, assetId, version, refreshKey])
  useEffect(() => {
    let current = true
    void load({ browserId, assetId, version }).then(result => {
      if (!current) return
      if (result.browserId !== browserId || result.assetId !== assetId || result.version !== version) {
        setState({ key, error: 'The exact version read is unavailable. Original work remains.' }); return
      }
      setState({ key, result })
    }, () => { if (current) setState({ key, error: 'Reliability could not be read. Original Browser work remains.' }) })
    return () => { current = false }
  }, [browserId, assetId, version, key, load])
  const current = state.key === key ? state : undefined
  const result = current?.result
  return <div className="browser-task-reliability" aria-label={`Reliability of saved version ${version}`} data-reliability-version={version}>
    {!current ? <small role="status"><ThemeStatusLoadingIcon size={11} aria-hidden="true" />Reading v{version} outcomes…</small>
      : current.error ? <p role="status"><ThemeStatusWarningIcon size={11} aria-hidden="true" />{current.error}</p>
        : result ? <>
          <span>v{version} · {result.population.terminalRuns === 0 ? 'No terminal samples' :
            `${result.counts.passed}/${result.population.terminalRuns} outcomes passed`}
            {result.passRate === null ? '' : ` · ${Math.round(result.passRate * 100)}%`}</span>
          <details><summary>Retained version results · {result.population.retainedRuns} runs</summary>
            <p>Passed outcomes / all retained terminal runs of this version. {result.population.pendingRuns} pending runs are excluded.
              {' '}{result.scriptCompleted} scripts completed; completion alone is not an outcome.
              {' '}{result.humanInterventions} recorded human confirmations.</p>
            <p>Sample window: {result.population.firstStartedAt === null ? 'empty' :
              `${sampleTime(result.population.firstStartedAt)} – ${sampleTime(result.population.lastUpdatedAt)}`}</p>
            {result.samples.length ? <ul>{result.samples.map(sample => <li key={sample.runId} data-outcome-result={sample.result}>
              {LABELS[sample.result]} · <span title={sample.runId}>{sample.runId.slice(0, 8)}</span><small>{sample.reason}</small>
            </li>)}</ul> : null}
            {result.selectedRunId ? <p>Owner-selected run: {result.selectedRunId.slice(0, 8)} · {result.selectedRunStatus}</p> : null}
          </details>
          {result.warning ? <p role="status"><ThemeStatusWarningIcon size={11} aria-hidden="true" />{result.warning}</p> : null}
        </> : null}
  </div>
}
