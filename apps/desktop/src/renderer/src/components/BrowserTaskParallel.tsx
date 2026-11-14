import { useEffect, useState, type MouseEvent } from 'react'
import { mintObjectId } from '@agentmux/core/object-id'
import { assertBrowserTaskControlTarget, parseBrowserTaskParallelInspection, parseBrowserTaskParallelList, parseBrowserTaskParallelSummary } from '@agentmux/core/control'
import type { AgentMuxBrowserTarget, AgentMuxBrowserTargetsResult } from '@agentmux/core'
import type { AgentMuxBrowserTaskInspection, BrowserTaskInvocationCalls, BrowserTaskParallelInput, BrowserTaskParallelInspection, BrowserTaskParallelList, BrowserTaskParallelSummary } from '@agentmux/core/control'
import { TextInput } from '@agentmux/client-ui/input'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { BrowserTaskAsset, BrowserTaskVersion } from '../../../shared/browser-task-assets'
import { browserTaskStepParameterKeys } from '../../../shared/browser-task-assets'
import { browserTaskSegment } from '../../../shared/browser-task-path'
import { api } from '../lib/api'
import { BrowserTaskSubflowFields, BrowserTaskSubflowProgress, browserTaskSubflowInputs, clearBrowserTaskSubflowValues } from './BrowserTaskSubflows'

type Choice = { id: string; browserId: string; profileId: string; title: string; profileLabel: string; parameters: Record<string, string>; calls: BrowserTaskInvocationCalls }
type Start = { browserId: string; assetId: string; version: number; input: BrowserTaskParallelInput }
type Original = Omit<Start, 'input'> & { operationId: string; phase: 'dispatching' | 'unknown'; warning?: string }
const terminal = (status: string) => ['completed', 'interrupted', 'failed', 'stopped'].includes(status)
const statusLabel = (status: string) => status === 'completed' ? 'steps completed' : status === 'waiting-human' ? 'waiting for you' : status
const countLabels = { queued: 'queued', preparing: 'preparing', running: 'running', waitingHuman: 'waiting for you', ready: 'ready', completed: 'steps completed', interrupted: 'interrupted', failed: 'failed', stopped: 'stopped' } as const

/** Invocation values are local and disposable. All progress and history are projections of the original owner. */
export function BrowserTaskParallel({ asset, version, assets, current, active: observing = true, onStart }: {
  asset: BrowserTaskAsset; version: BrowserTaskVersion; assets: BrowserTaskAsset[]; current?: BrowserTaskParallelSummary | null
  active?: boolean
  onStart(request: Start, event: MouseEvent<HTMLButtonElement>): Promise<BrowserTaskParallelSummary>
}) {
  const [open, setOpen] = useState(false)
  const [discovery, setDiscovery] = useState<AgentMuxBrowserTargetsResult | null>(null)
  const [discoveryError, setDiscoveryError] = useState<string>()
  const [choices, setChoices] = useState<Choice[]>([])
  const [concurrency, setConcurrency] = useState('2')
  const [pending, setPending] = useState<Original | null>(null)
  const [query, setQuery] = useState<{ browserId: string; operationId?: string }>({ browserId: asset.browserId, ...(current ? { operationId: current.operationId } : {}) })
  const [after, setAfter] = useState<string>()
  const [inspection, setInspection] = useState<BrowserTaskParallelInspection | null>(null)
  const [inspectionError, setInspectionError] = useState<string>()
  const [history, setHistory] = useState<BrowserTaskParallelList | null>(null)
  const [before, setBefore] = useState<string>()
  const [historyError, setHistoryError] = useState<string>()
  const [refresh, setRefresh] = useState(0)
  const [originalRun, setOriginalRun] = useState<AgentMuxBrowserTaskInspection | null>(null)
  const [runError, setRunError] = useState<string>()
  const definitions = assets.filter(value => value.browserId === asset.browserId)
  const definitionKey = JSON.stringify(definitions.map(value => [value.id, value.versions.map(version => version.version)]))
  useEffect(() => {
    setChoices(previous => previous.map(choice => ({ ...choice, parameters: {}, calls: browserTaskSubflowInputs(version, definitions, null, []) })))
  }, [asset.id, version.version])
  useEffect(() => {
    setChoices(previous => previous.map(choice => ({ ...choice, calls: browserTaskSubflowInputs(version, definitions, null, [], choice.calls) })))
  }, [definitionKey, asset.id, version.version])
  useEffect(() => {
    if (current && !query.operationId && !pending) setQuery({ browserId: current.browserId, operationId: current.operationId })
  }, [current?.operationId, query.operationId, pending?.operationId])
  useEffect(() => {
    if (!open || !observing) return
    let active = true, sequence = 0
    const read = async () => {
      const attempt = ++sequence
      try { const result = await api.browser.listTargets(); if (active && attempt === sequence) { setDiscovery(result); setDiscoveryError(undefined) } }
      catch (cause) { if (active && attempt === sequence) setDiscoveryError(presentError(cause)) }
    }
    void read()
    const release = api.browser.onTargetsChanged(() => { void read() })
    return () => { active = false; release() }
  }, [open, observing, refresh])
  useEffect(() => {
    if (!open || !observing) return
    let active = true
    void api.browser.listTaskParallel(asset.browserId, { ...(before ? { before } : {}), limit: 16 }).then(raw => {
      if (!active) return
      const result = parseBrowserTaskParallelList(raw)
      assertBrowserTaskControlTarget({ operation: 'browser.task.parallel-list', browserId: asset.browserId, ...(before ? { before } : {}), limit: 16 }, { operation: 'browser.task.parallel-list', history: result })
      setHistory(result); setHistoryError(undefined)
    }).catch(cause => { if (active) setHistoryError(presentError(cause)) })
    return () => { active = false }
  }, [open, observing, asset.browserId, before, refresh])
  useEffect(() => {
    if (!open || !observing) return
    let active = true, timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      try {
        const raw = await api.browser.inspectTaskParallel(query.browserId, { ...(query.operationId ? { operationId: query.operationId } : {}), ...(after ? { after } : {}), limit: 16 })
        if (!active) return
        const result = raw === null ? null : parseBrowserTaskParallelInspection(raw)
        assertBrowserTaskControlTarget({ operation: 'browser.task.parallel-inspect', ...query, ...(after ? { after } : {}), limit: 16 }, { operation: 'browser.task.parallel-inspect', inspection: result })
        setInspection(result); setInspectionError(undefined)
        if (result) {
          if (!query.operationId) setQuery({ browserId: query.browserId, operationId: result.run.operationId })
          if (result.run.admission === 'confirmed') setPending(previous => previous?.operationId === result.run.operationId && previous.browserId === result.run.browserId ? null : previous)
          if (!terminal(result.run.status)) timer = setTimeout(() => { void read() }, 2000)
        }
      } catch (cause) { if (active) setInspectionError(presentError(cause)) }
    }
    void read()
    return () => { active = false; if (timer) clearTimeout(timer) }
  }, [open, observing, query.browserId, query.operationId, after, refresh])
  const selectOperation = (browserId: string, operationId: string) => {
    setQuery({ browserId, operationId }); setAfter(undefined); setInspection(null); setInspectionError(undefined); setOriginalRun(null); setRunError(undefined); setRefresh(value => value + 1)
  }
  const choose = (target: AgentMuxBrowserTarget, checked: boolean) => {
    if (!checked) { setChoices(previous => previous.filter(choice => choice.browserId !== target.id)); return }
    if (!target.profile) return
    const profile = target.profile
    setChoices(previous => [...previous, { id: mintObjectId(), browserId: target.id, profileId: profile.id, title: target.title || target.id,
      profileLabel: profile.label, parameters: {}, calls: browserTaskSubflowInputs(version, definitions, null, []) }])
  }
  const changeChoice = (id: string, patch: Partial<Pick<Choice, 'parameters' | 'calls'>>) => setChoices(previous => previous.map(choice => choice.id === id ? { ...choice, ...patch } : choice))
  const required = new Set(browserTaskSegment(version.steps, 0).flatMap(browserTaskStepParameterKeys))
  const parallelism = Number(concurrency)
  const canStart = !pending && choices.length > 0 && Number.isSafeInteger(parallelism) && parallelism > 0 && choices.every(choice => version.parameters.filter(parameter => required.has(parameter.key)).every(parameter => Boolean(choice.parameters[parameter.key])))
  async function start(event: MouseEvent<HTMLButtonElement>) {
    const operationId = mintObjectId(), original: Original = { operationId, browserId: asset.browserId, assetId: asset.id, version: version.version, phase: 'dispatching' }
    setPending(original)
    const input: BrowserTaskParallelInput = { operationId, concurrency: parallelism, targets: choices.map(choice => ({ id: choice.id, browserId: choice.browserId, profileId: choice.profileId,
      parameters: { ...choice.parameters }, ...(Object.keys(choice.calls).length ? { calls: structuredClone(choice.calls) } : {}) })) }
    try {
      const result = parseBrowserTaskParallelSummary(await onStart({ browserId: original.browserId, assetId: original.assetId, version: original.version, input }, event))
      assertBrowserTaskControlTarget({ operation: 'browser.task.parallel', browserId: original.browserId, assetId: original.assetId, version: original.version, input }, { operation: 'browser.task.parallel', run: result })
      if (result.admission === 'unknown') setPending({ ...original, phase: 'unknown', warning: result.warning ?? 'Admission remains unconfirmed. Check this original action; no new operation was sent.' })
      else { setPending(null); selectOperation(original.browserId, operationId); setBefore(undefined) }
    } catch (cause) { setPending({ ...original, phase: 'unknown', warning: presentError(cause) }) }
    finally { setChoices(previous => previous.map(choice => ({ ...choice, parameters: {}, calls: clearBrowserTaskSubflowValues(choice.calls) }))) }
  }
  async function inspectRun(browserId: string, runId: string) {
    try {
      const result = await api.browser.controlTask({ operation: 'browser.task.inspect', browserId, runId })
      if (result.operation !== 'browser.task.inspect' || !result.inspection || !result.inspection.runs.some(run => run.id === runId && run.browserId === browserId)) throw new Error('The original target run could not be read. Its binding is kept; no run was started.')
      setOriginalRun(result.inspection); setRunError(undefined)
    } catch (cause) { setRunError(presentError(cause)) }
  }
  return <details className="browser-task-parallel" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Parallel Browsers · saved v{version.version}</summary>
    <p>Run this exact saved version across an explicit set of Browsers. Each target keeps its own Profile and fresh inputs.</p>
    <label className="browser-task-asset__field"><span>Concurrent targets</span><TextInput aria-label="Parallel task concurrency" type="number" min={1} step={1} value={concurrency} disabled={Boolean(pending)} onChange={event => setConcurrency(event.target.value)} /></label>
    <fieldset className="browser-task-parallel__choices"><legend>Choose exact Browsers and Profiles</legend>
      {discoveryError ? <p role="status">Target discovery is unavailable. Existing selections are kept. {discoveryError}</p> : null}
      {discovery?.coverage === 'partial' ? <p role="status">Target discovery is partial. {discovery.warning ?? 'Other Browsers may be unavailable to this query.'}</p> : null}
      {!discovery ? <small>Reading Browser targets…</small> : !discovery.targets.length ? <small>No Browser targets were returned.</small> : null}
      {discovery?.targets.map(target => <label className="browser-task-parallel__choice" key={target.id}>
        <input type="checkbox" aria-label={`Select Browser ${target.id}`} disabled={!target.profile || Boolean(pending)} checked={choices.some(choice => choice.browserId === target.id)} onChange={event => choose(target, event.target.checked)} />
        <span><strong>{target.title || target.id}</strong><small>{target.profile ? `${target.profile.label} · ${target.status}` : 'Profile ownership unavailable'} · Browser {target.id}</small></span>
      </label>)}
      <button type="button" className="browser-rsi-button browser-rsi-button--quiet" onClick={() => setRefresh(value => value + 1)}>Refresh targets and progress</button>
    </fieldset>
    {choices.map(choice => <section className="browser-task-parallel__target-input" key={choice.id} data-parallel-target-input={choice.id}>
      <header><strong>{choice.title}</strong><small>{choice.profileLabel} · Browser {choice.browserId} · Profile {choice.profileId}</small></header>
      <button type="button" className="browser-rsi-button browser-rsi-button--quiet" disabled={Boolean(pending)} onClick={() => setChoices(previous => previous.filter(item => item.id !== choice.id))}>Remove target {choice.title}</button>
      {version.parameters.map(parameter => <label className="browser-task-asset__field" key={parameter.key}><span>{parameter.label}{parameter.secret ? ' · fresh' : ''}</span>
        <TextInput aria-label={`${choice.browserId} parameter ${parameter.label}`} type={parameter.secret ? 'password' : 'text'} autoComplete="off" disabled={Boolean(pending)} maxLength={16_384} value={choice.parameters[parameter.key] ?? ''} onChange={event => changeChoice(choice.id, { parameters: { ...choice.parameters, [parameter.key]: event.target.value } })} /></label>)}
      <BrowserTaskSubflowFields version={version} assets={definitions} run={null} runs={[]} calls={choice.calls} busy={Boolean(pending)} prefix={`${choice.title} / `} onChange={calls => changeChoice(choice.id, { calls })} />
    </section>)}
    <button type="button" className="browser-rsi-button browser-rsi-button--primary" disabled={!canStart} onClick={event => void start(event)}>Start new parallel run · {choices.length} target{choices.length === 1 ? '' : 's'}</button>
    {pending ? <aside className="browser-task-parallel__original" role="status" data-original-parallel-id={pending.operationId}>
      <strong>{pending.phase === 'dispatching' ? 'Submitting original parallel run' : 'Original start is unconfirmed'}</strong>
      <small>Operation {pending.operationId} · Asset {pending.assetId} · v{pending.version}</small>
      {pending.warning ? <p>{pending.warning}</p> : null}
      {pending.phase === 'unknown' ? <><p>Fresh values were cleared. Check this original operation; a new ID will not be sent.</p><button type="button" className="browser-rsi-button browser-rsi-button--primary" onClick={() => selectOperation(pending.browserId, pending.operationId)}>Check original parallel run</button></> : null}
    </aside> : null}
    {inspectionError ? <p className="browser-rsi-timeline__warning" role="status">Progress read is unavailable. Last confirmed facts remain. {inspectionError}</p> : null}
    {query.operationId && !inspection && !inspectionError ? <p role="status">No confirmed record read for {query.operationId}. Keep this original ID before considering another action.</p> : null}
    {inspection ? <section className="browser-task-parallel__progress" aria-label="Original parallel task progress" data-parallel-operation={inspection.run.operationId}>
      <small>{pending && pending.operationId !== inspection.run.operationId ? inspection.run.admission === 'confirmed' ? 'Previous confirmed run' : 'Previously viewed run' : 'Original parallel run'}</small>
      <header><strong>{statusLabel(inspection.run.status)} · v{inspection.run.version}</strong><small>Operation {inspection.run.operationId}</small></header>
      <p>{inspection.run.targetCount} targets · concurrency {inspection.run.concurrency} / requested {inspection.run.requestedConcurrency} · admission {inspection.run.admission}</p>
      <p>{Object.entries(inspection.run.counts).filter(([, count]) => count > 0).map(([key, count]) => `${count} ${countLabels[key as keyof typeof countLabels]}`).join(' · ')}</p>
      {inspection.run.warning ? <p role="status">{inspection.run.warning}</p> : null}
      <ol>{inspection.targets.map(target => <li key={target.id} data-parallel-target={target.id}>
        <strong>{discovery?.targets.find(candidate => candidate.id === target.browserId)?.title || target.browserId}</strong>
        <small>Browser {target.browserId} · Profile {target.profileId}</small><span>{target.run ? statusLabel(target.run.status) : target.phase}</span>
        {target.waitingForProfile ? <small>Waiting for original Profile owner · {target.waitingForProfile.operationId} / {target.waitingForProfile.targetId}</small> : null}
        {target.error ? <p role="status">{target.error.message}</p> : null}
        {target.run ? <button type="button" className="browser-rsi-button browser-rsi-button--quiet" onClick={() => void inspectRun(target.browserId, target.run!.id)}>Inspect original run {target.run.id}</button> : null}
      </li>)}</ol>
      <div className="browser-task-parallel__pagination">{after ? <button type="button" className="browser-rsi-button browser-rsi-button--quiet" onClick={() => setAfter(undefined)}>First targets</button> : null}{inspection.page.nextAfter ? <button type="button" className="browser-rsi-button browser-rsi-button--quiet" onClick={() => { setAfter(inspection.page.nextAfter!); setOriginalRun(null) }}>More targets</button> : null}</div>
    </section> : null}
    {runError ? <p role="status">{runError}</p> : null}
    {originalRun ? <details className="browser-task-parallel__original-run" open><summary>Original run {originalRun.rootRunId}</summary>
      {originalRun.runs.map(run => <div key={run.id}><small>Browser {run.browserId} · Run {run.id} · {statusLabel(run.status)} · next step {run.nextStep + 1}</small>{run.warning ? <p>{run.warning}</p> : null}</div>)}
      {originalRun.runs.find(run => run.id === originalRun.rootRunId) ? <BrowserTaskSubflowProgress run={originalRun.runs.find(run => run.id === originalRun.rootRunId)!} assets={definitions} runs={originalRun.runs} /> : null}
    </details> : null}
    <details className="browser-task-parallel__history"><summary>Parallel run history</summary>
      {historyError ? <p role="status">History read is unavailable. {historyError}</p> : null}
      {history?.runs.length === 0 ? <p>No retained parallel runs.</p> : null}
      <ol>{history?.runs.map(run => <li key={run.operationId}><button type="button" className="browser-rsi-button browser-rsi-button--quiet" onClick={() => selectOperation(run.browserId, run.operationId)}>{assets.find(asset => asset.id === run.assetId)?.versions.find(version => version.version === run.version)?.name || run.assetId} · v{run.version} · {statusLabel(run.status)}</button><small>{run.operationId} · {run.targetCount} targets</small></li>)}</ol>
      <div className="browser-task-parallel__pagination">{before ? <button type="button" className="browser-rsi-button browser-rsi-button--quiet" onClick={() => setBefore(undefined)}>Latest history</button> : null}{history?.page.nextBefore ? <button type="button" className="browser-rsi-button browser-rsi-button--quiet" onClick={() => setBefore(history.page.nextBefore!)}>Older runs</button> : null}</div>
    </details>
  </details>
}
