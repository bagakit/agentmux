import { useEffect, useState, type MouseEvent } from 'react'
import { mintObjectId } from '@agentmux/core/object-id'
import { assertBrowserTaskControlTarget, parseBrowserTaskParallelContinuationReceipt } from '@agentmux/core/control'
import type { AgentMuxBrowserTaskInspection, BrowserTaskInvocationCalls, BrowserTaskParallelSummary, BrowserTaskParallelTargetProgress, BrowserTaskParallelContinuationInput, BrowserTaskParallelContinuationReceipt } from '@agentmux/core/control'
import { TextInput } from '@agentmux/client-ui/input'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { BrowserTaskAsset } from '../../../shared/browser-task-assets'
import { browserTaskStepParameterKeys } from '../../../shared/browser-task-assets'
import { browserTaskSegment } from '../../../shared/browser-task-path'
import { BrowserTaskSubflowFields, browserTaskSubflowInputs, clearBrowserTaskSubflowValues } from './BrowserTaskSubflows'

export type ParallelContinueRequest = { browserId: string; operationId: string; targetId: string; input: BrowserTaskParallelContinuationInput }
export type ParallelContinueIntent = { browserId: string; operationId: string; targetId: string; runId: string; version: number; id: string; expectedRevision: string; phase: 'dispatching' | 'unknown' | 'refused' | 'confirmed'; warning?: string }
export type ParallelContinueReview = { group: BrowserTaskParallelSummary; target: BrowserTaskParallelTargetProgress; original: AgentMuxBrowserTaskInspection; pageAfter?: string | null }
/** Fresh continuation values are disposable; every schema and item comes from the original run. */
export function BrowserTaskParallelContinue({ review, assets, intent, onContinue, onIntent, onCheck, onRefresh, onClose }: {
  review: ParallelContinueReview; assets: BrowserTaskAsset[]; intent?: ParallelContinueIntent | undefined
  onContinue(request: ParallelContinueRequest, event: MouseEvent<HTMLButtonElement>): Promise<BrowserTaskParallelContinuationReceipt>
  onIntent(value: ParallelContinueIntent): void; onCheck(intent: ParallelContinueIntent): void; onRefresh(): void; onClose(): void
}) {
  const { group, target, original } = review
  const root = original.runs.find(run => run.id === target.run?.id)
  const definitions = assets.filter(asset => asset.browserId === group.browserId)
  const version = definitions.find(asset => asset.id === group.assetId)?.versions.find(version => version.version === group.version)
  const [parameters, setParameters] = useState<Record<string, string>>({}), [calls, setCalls] = useState<BrowserTaskInvocationCalls>({})
  const manifestKey = JSON.stringify(original.runs.map(run => [run.id, run.calls]))
  const versionKey = JSON.stringify(definitions.map(asset => [asset.id, asset.versions.map(version => version.version)]))
  useEffect(() => { if (version && root) setCalls(previous => browserTaskSubflowInputs(version, definitions, root, original.runs, previous)) }, [group.assetId, group.version, root?.id, manifestKey, versionKey])
  const required = new Set(version ? browserTaskSegment(version.steps, root?.nextStep ?? 0).flatMap(browserTaskStepParameterKeys) : [])
  const fields = version?.parameters.filter(parameter => required.has(parameter.key)) ?? []
  const locked = intent?.phase === 'dispatching' || intent?.phase === 'unknown' || intent?.phase === 'confirmed' && intent.expectedRevision === target.continuationRevision
  const valid = Boolean(version && root && target.continuationRevision && !locked && fields.every(field => parameters[field.key]))
  async function submit(event: MouseEvent<HTMLButtonElement>) {
    if (!version || !root || !target.continuationRevision || locked) return
    const id = mintObjectId(), next: ParallelContinueIntent = { id, browserId: group.browserId, operationId: group.operationId, targetId: target.id, runId: root.id, version: version.version, expectedRevision: target.continuationRevision, phase: 'dispatching' }
    const input: BrowserTaskParallelContinuationInput = { continuationId: id, expectedRevision: next.expectedRevision, parameters: Object.fromEntries(fields.map(field => [field.key, parameters[field.key] ?? ''])), ...(Object.keys(calls).length ? { calls: structuredClone(calls) } : {}) }
    onIntent(next)
    let clear = true
    try {
      const receipt = parseBrowserTaskParallelContinuationReceipt(await onContinue({ browserId: group.browserId, operationId: group.operationId, targetId: target.id, input }, event))
      assertBrowserTaskControlTarget({ operation: 'browser.task.parallel-continue', browserId: group.browserId, operationId: group.operationId, targetId: target.id, input }, { operation: 'browser.task.parallel-continue', ...receipt })
      if (receipt.run.assetId !== group.assetId || receipt.run.version !== group.version) throw new Error('The continuation receipt changed the original immutable task definition. Keep the original continuation ID.')
      clear = receipt.continuation.admission !== 'refused'
      onIntent({ ...next, phase: receipt.continuation.admission, ...(receipt.continuation.warning ? { warning: receipt.continuation.warning } : {}) })
    } catch (cause) { onIntent({ ...next, phase: 'unknown', warning: presentError(cause) }) }
    finally { if (clear) { setParameters({}); setCalls(previous => clearBrowserTaskSubflowValues(previous)) } }
  }
  return <section className="browser-task-parallel__continue" aria-label="Continue original parallel target" data-continue-target={target.id}>
    <header><strong>Continue original target · v{group.version}</strong><small>Operation {group.operationId} · Target {target.id}</small><small>Browser {target.browserId} · Profile {target.profileId} · Run {target.run?.id}</small></header>
    <p>Review this original Browser, then return control. Completed steps and call items stay completed; each unfinished call needs fresh values.</p>
    {!version || !root ? <p role="status">The original immutable version or run is unavailable. Read the original run again; the current editor version will not be substituted.</p> : <>
      {fields.map(field => <label className="browser-task-asset__field" key={field.key}><span>{field.label}{field.secret ? ' · fresh' : ''}</span><TextInput aria-label={`Continue ${target.id} parameter ${field.label}`} type={field.secret ? 'password' : 'text'} autoComplete="off" maxLength={16_384} disabled={locked} value={parameters[field.key] ?? ''} onChange={event => setParameters(previous => ({ ...previous, [field.key]: event.target.value }))} /></label>)}
      <BrowserTaskSubflowFields version={version} assets={definitions} run={root} runs={original.runs} calls={calls} busy={Boolean(locked)} prefix={`Continue ${target.id} / `} onChange={setCalls} />
    </>}
    {!target.continuationRevision ? <p role="status">The original continuation cursor is unavailable. Refresh its progress before submitting this target.</p> : null}
    {intent ? <aside className="browser-task-parallel__original" role="status" data-original-continuation-id={intent.id}><strong>{intent.phase === 'dispatching' ? 'Submitting original continuation' : intent.phase === 'unknown' ? 'Original continuation is unconfirmed' : intent.phase === 'refused' ? 'Continuation was not admitted' : 'Continue request recorded'}</strong><small>Continuation {intent.id} · original run {intent.runId} · v{intent.version}</small>{intent.warning ? <p>{intent.warning}</p> : null}{intent.phase === 'unknown' ? <><p>Dispatched fresh values were cleared. Check this original continuation; it will not be replayed.</p><button type="button" className="browser-rsi-button browser-rsi-button--primary" onClick={() => onCheck(intent)}>Check original continuation</button></> : intent.phase === 'refused' ? <p>Your inputs remain available to correct and explicitly submit a new continuation.</p> : intent.phase === 'confirmed' ? <p>The original request is recorded. This does not confirm that its steps completed.</p> : null}</aside> : null}
    <footer className="browser-task-parallel__pagination"><button type="button" className="browser-rsi-button browser-rsi-button--quiet" onClick={onClose}>Close review</button><button type="button" className="browser-rsi-button browser-rsi-button--quiet" onClick={onRefresh}>Read original cursor</button><button type="button" className="browser-rsi-button browser-rsi-button--primary" disabled={!valid} onClick={event => void submit(event)}>Return control and continue target</button></footer>
  </section>
}
