import { parseConnectionRequestTrace, type ConnectionEnrollmentDiagnostic, type ConnectionEnrollmentView, type ConnectionRequestTraceEntry, type ConnectionSetupView } from '@agentmux/core/connections'
import type { MoteConnectionOperation } from '@agentmux/core/mote-connections'
import { sameMotePreferencesTarget, type MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import type { DesktopLoadedIdentity } from '../../../shared/client-observation'
import { api } from './api'
import type { ConnectionHostingTarget } from '../../../shared/contracts'

export type ConnectionDiagnosisTarget = { kind: 'enrollment' | 'setup'; operationId: string } | { kind: 'mote'; operationId: string; sourceTarget: MotePreferencesTarget | null; action?: 'create' | 'sync'; phase?: 'not-dispatched' | 'may-have-dispatched' }
type Facts = Record<string, unknown>
type Observation = { kind: 'mote' | 'enrollment' | 'setup'; operationId: string; status: 'recorded' | 'not-recorded' | 'unavailable' | 'conflicting-target'; facts?: Facts }
type Trace = { kind: 'enrollment' | 'setup'; operationId: string; status: 'complete' | 'unavailable'; entries: ConnectionRequestTraceEntry[] }

function diagnostic(d: ConnectionEnrollmentDiagnostic | ConnectionRequestTraceEntry['diagnostic']) {
  if (!d) return undefined
  return { ...('stage' in d ? { stage: d.stage } : {}), ...(d.code === undefined ? {} : { code: d.code }),
    ...('step' in d && d.step !== undefined ? { step: d.step } : {}), ...('failure' in d && d.failure !== undefined ? { failure: d.failure } : {}),
    ...('boundary' in d && d.boundary !== undefined ? { boundary: d.boundary } : {}), ...('redirectReason' in d && d.redirectReason !== undefined ? { redirectReason: d.redirectReason } : {}),
    ...('httpStatus' in d && d.httpStatus !== undefined ? { httpStatus: d.httpStatus } : {}), ...('nativeCode' in d && d.nativeCode !== undefined ? { nativeCode: d.nativeCode } : {}) }
}
/** The T008 whitelist remains a click-selected observation, never a historical receipt or authority. */
export function setupObservation(source: { kind: string; operationId: string } | null, view?: ConnectionSetupView | null) {
  if (source?.kind !== 'setup' || !view?.operation || view.operation.operationId !== source.operationId) return null
  const progress = view.profileUpdate, configuration = view.applicationConfiguration
  const publication = configuration?.effect === 'create-application-version' || configuration?.effect === 'submit-application-version' ? configuration : null
  return {
    scope: 'single-view-observation', operationId: view.operation.operationId, revision: view.operation.revision,
    profileUpdate: progress ? { stage: progress.stage, state: progress.state, ...(progress.versionId === undefined ? {} : { versionId: progress.versionId }), actionKinds: progress.actions.map(action => action.kind) } : null,
    publication: publication ? { capability: publication.capability, reason: publication.reason ?? null,
      review: publication.review ? { issues: [...publication.review.issues] } : null,
      sources: Object.values(publication.sources).flatMap(receipt => receipt ? [{ subject: receipt.subject, request: receipt.request, secureStorage: receipt.secureStorage }] : []) } : null
  }
}
function enrollmentFacts(view: ConnectionEnrollmentView): Facts {
  const o = view.operation!
  return { revision: o.revision, authorization: o.authorization, credential: o.credential, configuration: o.configuration,
    ...(o.application ? { application: { domain: o.application.domain, appId: o.application.appId } } : {}),
    ...(o.authentication ? { authentication: { attemptId: o.authentication.attemptId, stage: o.authentication.stage } } : {}),
    ...(o.creation ? { creation: { upload: o.creation.upload, create: o.creation.create } } : {}), reason: o.reason ?? null,
    diagnostic: diagnostic(o.diagnostic) ?? 'not-recorded', actionKinds: view.actions.map(a => a.kind),
    ...(view.receipt ? { receipt: { stepId: view.receipt.stepId, kind: view.receipt.kind, state: view.receipt.state } } : {}),
    ...(o.initialSetup ? { initialSetup: { operationId: o.initialSetup.operationId, progress: o.initialSetup.progress ? { stage: o.initialSetup.progress.stage, state: o.initialSetup.progress.state, ...(o.initialSetup.progress.versionId ? { versionId: o.initialSetup.progress.versionId } : {}) } : null } } : {}) }
}
function setupFacts(view: ConnectionSetupView): Facts {
  const o = view.operation!, a = o.authentication, initial = view.initialSetup
  return { revision: o.revision, application: { domain: o.application.domain, appId: o.application.appId }, request: o.request.state, secureStorage: o.secureStorage,
    reason: view.reason ?? o.reason ?? null,
    ...(a ? { authentication: { attemptId: a.attemptId, stepId: a.stepId, stage: a.stage, request: a.request, secureStorage: a.secureStorage } } : {}),
    authenticationActionKinds: view.continuation?.actions.map(a => a.kind) ?? [],
    ...(initial ? { initialSetup: { stage: initial.stage, state: initial.state, ...(initial.versionId ? { versionId: initial.versionId } : {}) } } : {}),
    ...(view.receipt ? { receipt: { stepId: view.receipt.stepId, state: view.receipt.state } } : {}),
    setupObservation: setupObservation({ kind: 'setup', operationId: o.operationId }, view) }
}
function identityFacts(value: DesktopLoadedIdentity): DesktopLoadedIdentity {
  const p = value.package, r = value.renderer
  return { package: p ? { schema: p.schema, sourceCommit: p.sourceCommit, sourceTree: p.sourceTree, appVersion: p.appVersion, platform: p.platform, arch: p.arch } : null,
    renderer: r ? { kind: r.kind, id: r.id, identity: { shell: r.identity.shell, ctxmux: r.identity.ctxmux } } : null }
}

/** Each read is local and exact. A missing section never fabricates a cause or blocks other sections. */
export async function collectConnectionDiagnosis(target: ConnectionDiagnosisTarget, options: { setupView?: ConnectionSetupView | null | undefined; enrollmentView?: ConnectionEnrollmentView | null | undefined; hostingTarget?: ConnectionHostingTarget | null | undefined; current(): boolean }) {
  const displayedSetup = target.kind !== 'enrollment' && options.setupView?.operation && (target.kind === 'mote' || options.setupView.operation.operationId === target.operationId) ? { operationId: options.setupView.operation.operationId, facts: setupFacts(options.setupView) } : null
  const displayedEnrollment = target.kind !== 'setup' && options.enrollmentView?.operation ? { operationId: options.enrollmentView.operation.operationId, facts: enrollmentFacts(options.enrollmentView) } : null
  const observations: Observation[] = [], traces: Trace[] = [], visited = new Set<string>()
  const report = { target: { kind: target.kind, operationId: target.operationId, hostingTarget: options.hostingTarget ?? null }, observations, traces, loadedIdentity: { package: null, renderer: null } as DesktopLoadedIdentity, complete: true }
  const originalHost = () => { if (!options.hostingTarget) throw new Error('The original hosting owner is unconfirmed'); return options.hostingTarget }
  const observe = (o: Observation) => { observations.push(o); if (o.status !== 'recorded') report.complete = false }
  async function trace(kind: Trace['kind'], operationId: string) {
    const entries: Trace['entries'] = []; let cursor: string | undefined
    try {
      do {
        if (!options.current()) return
        const selector = { limit: cursor ? 100 : 25, ...(cursor ? { cursor } : {}) }
        const value = kind === 'enrollment'
          ? await api.connections.call('connection.enrollment.inspect', { operationId, requestTrace: selector }, originalHost())
          : await api.connections.call('connection.setup.inspect', { operationId, requestTrace: selector }, originalHost())
        const page = parseConnectionRequestTrace(value.requestTrace, operationId, selector)
        entries.push(...page.entries); cursor = page.next ?? undefined
      } while (cursor)
      traces.push({ kind, operationId, status: 'complete', entries })
    } catch { report.complete = false; traces.push({ kind, operationId, status: 'unavailable', entries: [] }) }
  }
  async function setup(operationId: string, parent?: { enrollmentId?: string; connectionId?: string; appId?: string; domain?: string }) {
    if (!options.current() || visited.has('setup:' + operationId)) return
    visited.add('setup:' + operationId)
    try {
      const v = await api.connections.call('connection.setup.inspect', { operationId }, originalHost()), o = v.operation
      if (!o) { observe({ kind: 'setup', operationId, status: 'not-recorded' }); return }
      if (o.operationId !== operationId || parent?.enrollmentId && (o.source?.kind !== 'enrollment' || o.source.operationId !== parent.enrollmentId) || parent?.connectionId && o.connectionId !== parent.connectionId || parent?.appId && o.application.appId !== parent.appId || parent?.domain && o.application.domain !== parent.domain) { observe({ kind: 'setup', operationId, status: 'conflicting-target' }); return }
      observe({ kind: 'setup', operationId, status: 'recorded', facts: displayedSetup?.operationId === operationId ? displayedSetup.facts : setupFacts(v) })
    } catch { observe({ kind: 'setup', operationId, status: 'unavailable' }) }
    await trace('setup', operationId)
  }
  async function enrollment(operationId: string, parent?: MoteConnectionOperation) {
    if (!options.current() || visited.has('enrollment:' + operationId)) return
    visited.add('enrollment:' + operationId)
    let setupId: string | undefined, connectionId: string | undefined, appId: string | undefined, domain: string | undefined
    try {
      const v = await api.connections.call('connection.enrollment.inspect', { operationId }, originalHost()), o = v.operation
      if (!o) { observe({ kind: 'enrollment', operationId, status: 'not-recorded' }); return }
      if (o.operationId !== operationId || parent?.enrollmentOperationId !== undefined && parent.enrollmentOperationId !== operationId || parent?.connection && (o.connectionId !== parent.connection.connectionId || o.application && (o.application.appId !== parent.connection.application.appId || o.application.domain !== parent.connection.application.domain))) { observe({ kind: 'enrollment', operationId, status: 'conflicting-target' }); return }
      observe({ kind: 'enrollment', operationId, status: 'recorded', facts: displayedEnrollment?.operationId === operationId ? displayedEnrollment.facts : enrollmentFacts(v) })
      setupId = o.initialSetup?.operationId; connectionId = o.connectionId; appId = o.application?.appId; domain = o.application?.domain
    } catch { observe({ kind: 'enrollment', operationId, status: 'unavailable' }); setupId = parent?.enrollment?.initialSetup?.operationId }
    await trace('enrollment', operationId)
    if (setupId) await setup(setupId, { enrollmentId: operationId, ...(connectionId ? { connectionId } : {}), ...(appId ? { appId } : {}), ...(domain ? { domain } : {}) })
  }
  if (target.kind === 'mote') {
    try {
      const p = (await api.moteConnections.call('space.mote.connection.inspect', { operationId: target.operationId }, originalHost())).operation
      if (!p) observe({ kind: 'mote', operationId: target.operationId, status: 'not-recorded', facts: { ...(target.action ? { action: target.action } : {}), clientPhase: target.phase ?? 'unknown', cause: 'not-recorded' } })
      else if (p.operationId !== target.operationId || !target.sourceTarget || !sameMotePreferencesTarget(p.source.target, target.sourceTarget)) observe({ kind: 'mote', operationId: target.operationId, status: 'conflicting-target' })
      else {
        observe({ kind: 'mote', operationId: p.operationId, status: 'recorded', facts: { action: p.action, clientPhase: target.phase ?? 'unknown', issue: p.issue, defaultLink: p.defaultLink.state, enrollmentOperationId: p.enrollmentOperationId, setupOperationId: p.setupOperationId ?? null, ...(p.connection ? { application: { domain: p.connection.application.domain, appId: p.connection.application.appId } } : {}) } })
        if (p.enrollmentOperationId) await enrollment(p.enrollmentOperationId, p)
        if (p.setupOperationId) await setup(p.setupOperationId, p.connection ? { connectionId: p.connection.connectionId, appId: p.connection.application.appId, domain: p.connection.application.domain } : undefined)
      }
    } catch { observe({ kind: 'mote', operationId: target.operationId, status: 'unavailable' }) }
  } else if (target.kind === 'enrollment') await enrollment(target.operationId)
  else await setup(target.operationId)
  if (options.current()) try { report.loadedIdentity = identityFacts(await api.ui.readLoadedIdentity()) } catch { /* Report the missing loaded identity without raw exception text. */ }
  if (!report.loadedIdentity.package || !report.loadedIdentity.renderer) report.complete = false
  return report
}

export function formatConnectionDiagnosis(report: Awaited<ReturnType<typeof collectConnectionDiagnosis>>): string {
  const setup = report.observations.filter(o => o.kind === 'setup' && o.facts).at(-1), enrollment = report.observations.find(o => o.kind === 'enrollment' && o.facts)
  const snapshot = setup?.facts?.setupObservation as ReturnType<typeof setupObservation>, progress = snapshot?.profileUpdate ?? setup?.facts?.initialSetup as { stage: string; state: string } | undefined
  const creation = enrollment?.facts?.creation as { upload: string; create: string } | undefined
  const outcome = progress ? `${progress.stage} / ${progress.state} (owner observation)` : creation ? `creation upload ${creation.upload}; create ${creation.create}; application save ${enrollment!.facts!.configuration}` : 'Original result is not confirmed; inspect the same task.'
  const reasons: string[] = [], actions: string[] = []
  for (const o of report.observations) {
    if (o.status !== 'recorded') reasons.push(`${o.kind}: ${o.status}`)
    for (const field of ['issue', 'reason']) if (typeof o.facts?.[field] === 'string') reasons.push(`${o.kind}: ${o.facts[field]}`)
    const d = o.facts?.diagnostic
    if (d && typeof d === 'object') reasons.push(`${o.kind}: ${JSON.stringify(d)}`)
    for (const field of ['actionKinds', 'authenticationActionKinds']) if (Array.isArray(o.facts?.[field])) actions.push(...(o.facts[field] as string[]).map(a => `${o.kind}: ${a}`))
  }
  if (snapshot?.publication?.reason) reasons.push(`publication: ${snapshot.publication.reason}`)
  reasons.push(...(snapshot?.publication?.review?.issues ?? []))
  actions.push(...(snapshot?.profileUpdate?.actionKinds ?? []).map(a => `setup: ${a}`))
  const lines = ['AgentMux bot diagnosis', `Hosting: ${report.target.hostingTarget ? report.target.hostingTarget.hostId + ' / ' + report.target.hostingTarget.runtimeId : 'not recorded; original owner unconfirmed'}`, `Outcome: ${outcome}`, `Attention: ${reasons.length ? [...new Set(reasons)].join('; ') : 'none recorded'}`, `Offered actions: ${actions.length ? [...new Set(actions)].join('; ') : 'none in these observations'}`, `Report: ${report.complete ? 'complete' : 'incomplete'}`, 'Scope: owner observations and journal pages were read separately; this is not an atomic historical snapshot.', 'Journal settled means recorded, not success. HTTP request details were not recorded.', '']
  for (const o of report.observations) {
    lines.push(`${o.kind} ${o.operationId} — ${o.status}`)
    for (const [key, value] of Object.entries(o.facts ?? {})) lines.push(`  ${key}: ${JSON.stringify(value)}`)
    lines.push('')
  }
  lines.push('Loaded application')
  for (const [key, value] of Object.entries(report.loadedIdentity)) lines.push(`  ${key}: ${value === null ? 'unavailable' : JSON.stringify(value)}`)
  lines.push('Renderer ctxmux is its artifact pairing, not a serving Runtime observation.', '')
  for (const t of report.traces) {
    lines.push(`Trace ${t.kind} ${t.operationId} — ${t.status}`, 'sequence | step | kind | action | subject/effect | request | storage | diagnostic')
    for (const e of t.entries) lines.push([e.sequence, e.stepId, e.kind, e.action, e.subject ?? e.effect ?? '-', e.request, e.secureStorage ?? '-', JSON.stringify(diagnostic(e.diagnostic) ?? null)].join(' | '))
    if (!t.entries.length) lines.push(t.status === 'complete' ? '(no recorded steps)' : '(trace unavailable; no partial trace is presented as complete)')
    lines.push('')
  }
  return lines.join('\n')
}
