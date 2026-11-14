import { mintObjectId } from '@agentmux/core/object-id'
import type { BrowserTaskInvocationCalls } from '@agentmux/core/control'
import { TextInput } from '@agentmux/client-ui/input'
import type { BrowserTaskAsset, BrowserTaskAssetRun, BrowserTaskStep, BrowserTaskVersion } from '../../../shared/browser-task-assets'

export function browserTaskSubflowVersion(step: BrowserTaskStep, assets: BrowserTaskAsset[]): BrowserTaskVersion | undefined {
  const target = step.subflow?.target
  return target?.kind === 'local' ? assets.find(asset => asset.id === target.assetId)?.versions.find(version => version.version === target.version) : undefined
}

/** Definition choices are retained versions of this Browser, never names or a moving latest version. */
export function BrowserTaskSubflowEditor({ step, index, assets, onChange }: {
  step: BrowserTaskStep; index: number; assets: BrowserTaskAsset[]; onChange: (step: BrowserTaskStep) => void
}) {
  const target = step.subflow!.target
  const choices = assets.flatMap(asset => asset.versions.map(version => ({ asset, version, value: JSON.stringify([asset.id, version.version]) })))
  const selected = target.kind === 'local' ? choices.find(choice => choice.asset.id === target.assetId && choice.version.version === target.version) : undefined
  return <span className="browser-task-subflow__definition">
    <label className="browser-task-asset__field"><span>Task version</span><select aria-label={`Subflow ${index + 1} task version`} value={selected?.value ?? ''}
      onChange={event => { const choice = choices.find(choice => choice.value === event.target.value); if (choice) onChange({ ...step, reviewed: false, subflow: { ...step.subflow!, target: { kind: 'local', assetId: choice.asset.id, version: choice.version.version } } }) }}>
      {!selected ? <option value="">{target.kind === 'imported' ? 'Choose a local version' : 'Version unavailable'}</option> : null}
      {choices.map(choice => <option key={choice.value} value={choice.value}>{choice.version.name} · v{choice.version.version}</option>)}
    </select></label>
    <label className="browser-task-asset__field"><span>Repeat</span><select aria-label={`Subflow ${index + 1} iteration`} value={step.subflow!.iteration}
      onChange={event => onChange({ ...step, reviewed: false, subflow: { ...step.subflow!, iteration: event.target.value === 'each' ? 'each' : 'once' } })}>
      <option value="once">Once · one item</option><option value="each">Each explicit item</option>
    </select></label>
    {target.kind === 'imported' ? <small>Imported reference · v{target.source.version}. Bind a local version and review before publishing.</small> : <small>This exact version stays fixed when its draft changes.</small>}
  </span>
}

/** Reconcile only original item/run identities. Fresh values live in this Renderer invocation. */
export function browserTaskSubflowInputs(version: BrowserTaskVersion, assets: BrowserTaskAsset[], run: BrowserTaskAssetRun | null,
  runs: BrowserTaskAssetRun[], previous: BrowserTaskInvocationCalls = {}, depth = 1): BrowserTaskInvocationCalls {
  if (depth >= 4) return {}
  return Object.fromEntries(version.steps.filter(step => step.kind === 'subflow').flatMap(step => {
    const definition = browserTaskSubflowVersion(step, assets)
    if (!definition) return []
    const manifest = run?.calls?.find(call => call.stepId === step.id)
    const old = previous[step.id]
    const items = manifest?.items ?? old?.items ?? [{ id: mintObjectId() }]
    return [[step.id, { parameters: old?.parameters ?? {}, items: items.map(item => {
      const current = old?.items.find(value => value.id === item.id)
      const retained = manifest?.items.find(value => value.id === item.id)
      const child = runs.find(value => value.id === retained?.runId) ?? null
      const calls = browserTaskSubflowInputs(definition, assets, child, runs, current?.calls, depth + 1)
      return { id: item.id, parameters: current?.parameters ?? {}, ...(Object.keys(calls).length ? { calls } : {}) }
    }) }]]
  }))
}

/** Clearing happens after every dispatch, including unknown replies; item identities stay inspectable. */
export function clearBrowserTaskSubflowValues(calls: BrowserTaskInvocationCalls): BrowserTaskInvocationCalls {
  return Object.fromEntries(Object.entries(calls).map(([key, call]) => [key, { parameters: {}, items: call.items.map(item => ({
    id: item.id, parameters: {}, ...(item.calls ? { calls: clearBrowserTaskSubflowValues(item.calls) } : {})
  })) }]))
}

const stateLabel = (status: BrowserTaskAssetRun['status']) => status === 'completed' ? 'steps completed' : status === 'waiting-human' ? 'waiting for you' : status

/** This is a view of original runs, not a second execution journal. */
export function BrowserTaskSubflowProgress({ run, assets, runs, depth = 1 }: {
  run: BrowserTaskAssetRun; assets: BrowserTaskAsset[]; runs: BrowserTaskAssetRun[]; depth?: number
}) {
  if (!run.calls?.length || depth >= 4) return null
  const version = assets.find(asset => asset.id === run.assetId)?.versions.find(version => version.version === run.version)
  return <div className="browser-task-subflow__progress">{run.calls.map(call => <div key={call.stepId} data-task-subflow-progress={call.stepId}>
    <strong>{version?.steps.find(step => step.id === call.stepId)?.label || 'Subflow'} · v{call.version}</strong>
    <ol>{call.items.map((item, index) => {
      const child = runs.find(child => child.id === item.runId)
      return <li key={item.id} data-task-subflow-item={item.id} data-run-id={item.runId} data-run-status={child?.status ?? 'unobserved'}>
        <span>Item {index + 1} · {child ? stateLabel(child.status) : item.runId ? 'run unavailable' : 'not started'}</span>
        {child ? <><small title={child.id}>Run {child.id.slice(0, 8)} · {child.operationIds.length} operation{child.operationIds.length === 1 ? '' : 's'}{child.status === 'waiting-human' ? ' · checkpoint' : child.status === 'completed' ? '' : ` · next step ${child.nextStep + 1}`}</small>
          {child.warning ? <small>{child.warning}</small> : null}
          <BrowserTaskSubflowProgress run={child} assets={assets} runs={runs} depth={depth + 1} /></> : null}
      </li>
    })}</ol>
  </div>)}</div>
}

/** Finite item forms use each exact callee's own parameter schema, including nested calls. */
export function BrowserTaskSubflowFields({ version, assets, run, runs, calls, onChange, busy, depth = 1, prefix = '' }: {
  version: BrowserTaskVersion; assets: BrowserTaskAsset[]; run: BrowserTaskAssetRun | null; runs: BrowserTaskAssetRun[]
  calls: BrowserTaskInvocationCalls; onChange: (calls: BrowserTaskInvocationCalls) => void; busy: boolean; depth?: number; prefix?: string
}) {
  if (depth >= 4) return null
  return <>{version.steps.filter(step => step.kind === 'subflow').map(step => {
    const definition = browserTaskSubflowVersion(step, assets), call = calls[step.id]
    const manifest = run?.calls?.find(call => call.stepId === step.id)
    const label = `${prefix}${step.label || definition?.name || 'Subflow'}`
    if (!definition || !call) return <p key={step.id} className="browser-rsi-timeline__warning" role="status">{label}: bind its exact local task version before running.</p>
    const update = (next: typeof call) => onChange({ ...calls, [step.id]: next })
    const remaining = call.items.some(item => runs.find(run => run.id === manifest?.items.find(value => value.id === item.id)?.runId)?.status !== 'completed')
    return <details key={step.id} className="browser-task-subflow__inputs" open={remaining}>
      <summary>{label} · v{definition.version} · {call.items.length} item{call.items.length === 1 ? '' : 's'}</summary>
      <small>Fresh values for this invocation. Completed items stay completed.</small>
      {(remaining ? definition.parameters.filter(parameter => parameter.secret) : []).map(parameter => <label key={parameter.key} className="browser-task-asset__field"><span>{parameter.label} · fresh</span>
        <TextInput aria-label={`${label} fresh ${parameter.label}`} type="password" autoComplete="off" maxLength={16_384} disabled={busy}
          value={call.parameters[parameter.key] ?? ''} onChange={event => update({ ...call, parameters: { ...call.parameters, [parameter.key]: event.target.value } })} /></label>)}
      {call.items.map((item, index) => {
        const retained = manifest?.items.find(value => value.id === item.id)
        const child = runs.find(value => value.id === retained?.runId) ?? null
        const completed = child?.status === 'completed'
        return <div key={item.id} className="browser-task-subflow__item" data-task-subflow-input={item.id}>
          <div><strong>Item {index + 1}{completed ? ' · steps completed' : ''}</strong>
            {!manifest && step.subflow?.iteration === 'each' ? <button type="button" className="browser-rsi-button browser-rsi-button--quiet" aria-label={`Remove ${label} item ${index + 1}`} disabled={busy || call.items.length <= 1} onClick={() => update({ ...call, items: call.items.filter(row => row.id !== item.id) })}>Remove</button> : null}</div>
          {!completed ? <>{definition.parameters.filter(parameter => !parameter.secret).map(parameter => <label key={parameter.key} className="browser-task-asset__field"><span>{parameter.label}</span>
            <TextInput aria-label={`${label} item ${index + 1} ${parameter.label}`} autoComplete="off" maxLength={16_384} disabled={busy}
              value={item.parameters[parameter.key] ?? ''} onChange={event => update({ ...call, items: call.items.map(row => row.id === item.id ? { ...row, parameters: { ...row.parameters, [parameter.key]: event.target.value } } : row) })} /></label>)}
            {item.calls ? <BrowserTaskSubflowFields version={definition} assets={assets} run={child} runs={runs} calls={item.calls} busy={busy} depth={depth + 1} prefix={`${label} / `}
              onChange={nested => update({ ...call, items: call.items.map(row => row.id === item.id ? { ...row, calls: nested } : row) })} /> : null}</> : null}
        </div>
      })}
      {!manifest && step.subflow?.iteration === 'each' ? <button type="button" className="browser-rsi-button browser-rsi-button--quiet" disabled={busy || call.items.length >= 16}
        onClick={() => { const nested = browserTaskSubflowInputs(definition, assets, null, runs, {}, depth + 1); update({ ...call, items: [...call.items, { id: mintObjectId(), parameters: {}, ...(Object.keys(nested).length ? { calls: nested } : {}) }] }) }}>Add {label} item</button> : null}
    </details>
  })}</>
}
