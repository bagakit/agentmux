import { useEffect, useRef, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { ConnectionRecord, ConnectionSetupAction, ConnectionSetupPublicationDraft, ConnectionSetupPublicationEffect, ConnectionSetupAdvance, ConnectionSetupBegin, ConnectionSetupEnrollmentSource, ConnectionSetupInspect, ConnectionSetupConfigurationSelector, ConnectionSetupListing, ConnectionSetupOperation, ConnectionSetupView } from '@agentmux/core/connections'
import { connectionSetupDecisionForAction } from '@agentmux/core/connections'
import { connectionManagementTask } from './connection-management-task'
import { api } from '../../lib/api'

type Source = typeof api.connections.call
type Submission = { key: string; source: Source; input: ConnectionSetupBegin }
type Catalog = { key: string; source: Source; value: ConnectionSetupListing | null; issue: string }
type Reading = { key: string; source: Source; id: string; value: ConnectionSetupView | null; issue: string; absent: boolean; pending: boolean; actionKind?: ConnectionSetupAction['kind'] | undefined; configurationIssue?: string; intent?: ConnectionSetupConfigurationSelector | undefined }
type PublicationForm = { version: string; notes: string; reason: string; visibility: 'current' | 'creator-only'; desktop: string; mobile: string; versionId: string; fullRelease: boolean }
const emptyPublicationForm: PublicationForm = { version: '1.0.0', notes: '', reason: '', visibility: 'current', desktop: '', mobile: '', versionId: '', fullRelease: false }
const scope = (record: ConnectionRecord | null) => record ? JSON.stringify([record.config.connectionId, record.config.adapterId, record.config.application, record.revision]) : ''
const inputOf = (operation: ConnectionSetupOperation): ConnectionSetupBegin => {
  if (operation.goal.kind !== 'agent-conversation') throw new Error('This task belongs to the original profile update view.')
  return { operationId: operation.operationId, connectionId: operation.connectionId, expectedConnectionRevision: operation.expectedConnectionRevision, goal: operation.goal, ...(operation.source ? { source: operation.source } : {}) }
}

/** The mounted Settings task retains safe submissions; private readings and timers are disposable. */
export function useConnectionManagementSetup(record: ConnectionRecord | null, active: boolean, opened: boolean) {
  const key = scope(record), source = api.connections.call
  const [catalog, setCatalog] = useState<Catalog | null>(null), [reading, setReading] = useState<Reading | null>(null)
  const [publication, setPublication] = useState<{ key: string; source: Source; id: string; fields: PublicationForm } | null>(null)
  const [submissions, setSubmissions] = useState<Submission[]>([])
  const [guidedCheck, setGuidedCheck] = useState(false), checkOwner = useRef<object | null>(null)
  const [listing, setListing] = useState(false), [driving, setDriving] = useState(false), [fresh, setFresh] = useState(false)
  const context = useRef({ key, source, active, opened }), mounted = useRef(false)
  const occurrence = useRef(0), listOccurrence = useRef(0), selection = useRef<string | null>(null)
  const submittedActions = useRef(new Set<string>()), draft = useRef<Submission | null>(null)
  const requestedHandoff = useRef<Submission | null>(null)
  context.current = { key, source, active, opened }
  const currentSource = () => mounted.current && context.current.active && context.current.key === key && context.current.source === source && api.connections.call === source
  const visibleCatalog = catalog?.key === key && catalog.source === source ? catalog : null
  const visible = active && opened && reading?.key === key && reading.source === source && reading.id === selection.current && api.connections.call === source ? reading : null
  const observedView = visible?.value ?? null
  const view = visible?.issue ? null : observedView, operation = view?.operation ?? null
  const configurationEffect = view?.applicationConfiguration?.effect ?? 'enable-messaging'
  const configuration = view?.applicationConfiguration
  const configurationSelector: ConnectionSetupConfigurationSelector = !configuration && visible?.intent ? visible.intent : configuration?.effect === 'add-application-permissions' ? { effect: 'add-application-permissions', purpose: configuration.purpose }
    : configuration?.effect === 'create-application-version' ? { effect: configuration.effect, ...(configuration.draft?.kind === 'create-version' ? { draft: configuration.draft } : {}) }
    : configuration?.effect === 'submit-application-version' ? { effect: configuration.effect, ...(configuration.draft?.kind === 'submit-version' ? { draft: configuration.draft } : {}) }
    : { effect: configurationEffect as 'enable-messaging' | 'use-persistent-connection' | 'use-persistent-callback' | 'add-card-actions' | 'add-message-reception' }
  const supported = !!record && visibleCatalog?.value?.support?.connectionRevision === record.revision && visibleCatalog.value.support.capabilities.includes('management-authentication')
  const originals = (visibleCatalog?.value?.operations ?? []).filter(operation => operation.goal.kind === 'agent-conversation')
  const local = submissions.filter(item => item.input.connectionId === record?.config.connectionId && item.source === source)
  const choices = [...originals.map(operation => ({ input: inputOf(operation), operation })), ...local.filter(item => !originals.some(o => o.operationId === item.input.operationId)).map(item => ({ input: item.input, operation: null }))]
  const busy = (visible?.pending ?? false) || guidedCheck
  // User-authored fields survive an observation failure; no previous authority or private view does.
  const publicationForm = publication?.key === key && publication.source === source && publication.id === visible?.id ? publication.fields : emptyPublicationForm
  function editPublicationForm(change: Partial<PublicationForm>) {
    if (!visible || !currentSource()) return
    setPublication(previous => ({ key, source, id: visible.id, fields: { ...(previous?.key === key && previous.source === source && previous.id === visible.id ? previous.fields : emptyPublicationForm), ...change } }))
  }
  const chosenInput = operation ? inputOf(operation) : local.find(item => item.input.operationId === visible?.id)?.input
  const revised = view?.reason === 'connection-revised' || !!chosenInput && chosenInput.expectedConnectionRevision !== record?.revision

  async function list(cursor?: string) {
    if (!record) return
    const request = ++listOccurrence.current
    setListing(true)
    try {
      const value = await source('connection.setup.ls', { connectionId: record.config.connectionId, ...(cursor ? { cursor } : {}) })
      if (currentSource() && request === listOccurrence.current) setCatalog(previous => {
        const known = cursor && previous?.key === key && previous.source === source ? previous.value?.operations ?? [] : []
        return { key, source, value: { ...value, operations: [...known.filter(o => !value.operations.some(n => n.operationId === o.operationId)), ...value.operations] }, issue: '' }
      })
    } catch (error) {
      if (currentSource() && request === listOccurrence.current) setCatalog(previous => ({ key, source, value: previous?.key === key && previous.source === source ? previous.value : null, issue: presentError(error) }))
    } finally { if (currentSource() && request === listOccurrence.current) setListing(false) }
  }

  function sameApplication(operation: ConnectionSetupOperation) {
    return !!record && operation.connectionId === record.config.connectionId && operation.adapterId === record.config.adapterId &&
      operation.application.domain === record.config.application.domain && operation.application.appId === record.config.application.appId &&
      operation.goal.kind === 'agent-conversation' && operation.goal.interaction === 'messages'
  }
  function matches(operation: ConnectionSetupOperation) { return sameApplication(operation) && operation.expectedConnectionRevision === record?.revision }
  async function perform(id: string, work: () => Promise<ConnectionSetupView>, run: boolean, actionKind?: ConnectionSetupAction['kind'], requestedConfiguration?: ConnectionSetupConfigurationSelector) {
    if (!currentSource() || !context.current.opened) return
    const request = ++occurrence.current
    const intent = requestedConfiguration ?? (visible?.id === id && visible.value?.continuation?.stage === 'confirmed' ? configurationSelector : undefined)
    selection.current = id; setDriving(run)
    setReading(previous => previous?.key === key && previous.source === source && previous.id === id
      ? { ...previous, issue: '', absent: false, pending: true, actionKind, intent } : { key, source, id, value: null, issue: '', absent: false, pending: true, actionKind, intent })
    const accepts = () => currentSource() && context.current.opened && selection.current === id && request === occurrence.current
    try {
      let value = await work()
      const validate = (result: ConnectionSetupView) => {
        if (result.operation && (result.operation.operationId !== id || !matches(result.operation) && !(sameApplication(result.operation) && result.reason === 'connection-revised' && !result.challenge && !result.continuation))) throw new Error('This result could not be matched to the saved application. The original request is kept.')
      }
      if (!accepts()) return
      validate(value)
      // Discover offered actions locally. Account confirmation never reads or changes platform settings.
      let configurationIssue = ''
      if (value.operation && value.continuation?.stage === 'confirmed' && (!value.applicationInspection || !value.applicationConfiguration)) {
        try {
          const details = await source('connection.setup.inspect', {
            operationId: id,
            applicationInspection: value.applicationInspection?.selected ? { selectedStepId: value.applicationInspection.selected.stepId } : {},
            applicationConfiguration: { ...(requestedConfiguration ?? (value.applicationConfiguration?.effect === 'add-application-permissions' ? { effect: 'add-application-permissions', purpose: value.applicationConfiguration.purpose } : value.applicationConfiguration ? { effect: value.applicationConfiguration.effect } : actionKind === 'read-event-settings' ? { effect: 'use-persistent-connection' } : actionKind === 'read-bot-settings' ? { effect: 'enable-messaging' } : configurationSelector)), ...(value.applicationConfiguration?.selected ? { selectedStepId: value.applicationConfiguration.selected.stepId } : {}) }
          })
          if (!accepts()) return
          validate(details); value = details
        } catch (error) {
          if (!accepts()) return
          configurationIssue = presentError(error)
        }
      }
      setReading({ key, source, id, value, issue: '', absent: !value.operation, pending: false, configurationIssue, intent })
      if (value.operation) setCatalog(previous => previous?.key === key && previous.source === source && previous.value
        ? { ...previous, value: { ...previous.value, operations: [value.operation!, ...previous.value.operations.filter(o => o.operationId !== id)] } } : previous)
      if (!value.operation || value.reason || !value.continuation || !['waiting', 'scanned', 'handoff'].includes(value.continuation.stage)) setDriving(false)
      return value
    } catch (error) {
      if (accepts()) { setReading(previous => ({ key, source, id, value: previous?.key === key && previous.source === source && previous.id === id ? previous.value : null, issue: presentError(error), absent: false, pending: false, intent })); setDriving(false) }
    }
  }
  function start() {
    if (!record || !supported) return
    if (!draft.current || draft.current.key !== key || draft.current.source !== source) {
      draft.current = { key, source, input: { operationId: crypto.randomUUID(), connectionId: record.config.connectionId, expectedConnectionRevision: record.revision, goal: { kind: 'agent-conversation', interaction: 'messages' } } }
      const submission = draft.current
      setSubmissions(previous => [...previous, submission])
    }
    const input = draft.current.input
    void perform(input.operationId, () => source('connection.setup.begin', input), true)
  }
  function choose(input: ConnectionSetupBegin) {
    setFresh(false)
    submittedActions.current.clear()
    void perform(input.operationId, () => source('connection.setup.inspect', { operationId: input.operationId, applicationInspection: {}, applicationConfiguration: configurationSelector }), true)
  }
  function handoff(enrollment: ConnectionSetupEnrollmentSource) {
    if (!record || !currentSource() || !visibleCatalog?.value?.support?.capabilities.includes('enrollment-continuation')) return
    const original = submissions.find(item => item.key === key && item.source === source && JSON.stringify(item.input.source) === JSON.stringify(enrollment))
    const submission = original ?? { key, source, input: { operationId: crypto.randomUUID(), connectionId: record.config.connectionId, expectedConnectionRevision: record.revision, goal: { kind: 'agent-conversation', interaction: 'messages' }, source: enrollment } as ConnectionSetupBegin }
    if (!original) setSubmissions(previous => [...previous, submission])
    requestedHandoff.current = submission
  }
  function inspectOriginal(selectors: Omit<ConnectionSetupInspect, 'operationId'> = {}, originalOperationId?: string) {
    const id = originalOperationId ?? visible?.id
    const intent = selectors.applicationConfiguration ?? (view?.continuation?.stage === 'confirmed' || visible?.intent ? configurationSelector : undefined)
    if (id) void perform(id, () => source('connection.setup.inspect', {
      operationId: id, applicationInspection: {}, applicationConfiguration: configurationSelector, ...selectors
    }), false, undefined, intent)
  }
  function inspect() { inspectOriginal() }
  function advance(action: ConnectionSetupAction) {
    if (!operation) return
    const originalDraft = action.kind === 'recover-configuration-effect' ? configuration?.selected?.input.publicationDraft : action.kind === 'create-application-version' || action.kind === 'submit-application-version' ? (configuration && 'draft' in configuration ? configuration.draft ?? undefined : undefined) : undefined
    const versionId = action.kind === 'read-publication-version' ? action.versionId : action.kind === 'recover-application-inspection' ? view?.applicationInspection?.selected?.input.versionId : undefined
    const input: ConnectionSetupAdvance = { operationId: operation.operationId, expectedRevision: action.expectedRevision, decision: { actionId: action.actionId, value: connectionSetupDecisionForAction(action) }, ...(versionId ? { versionId } : {}), ...(originalDraft ? { publicationDraft: originalDraft } : {}) }
    submittedActions.current.add(action.actionId)
    void perform(input.operationId, () => source('connection.setup.advance', input), action.kind === 'continue' || action.kind === 'renew', action.kind, configuration && 'draft' in configuration ? configurationSelector : undefined)
  }
  async function reviewConfiguration(effect: 'add-application-permissions' | 'add-message-reception' | ConnectionSetupPublicationEffect, publicationDraft?: ConnectionSetupPublicationDraft) {
    if (!operation || busy) return
    const id = operation.operationId
    const selector: ConnectionSetupConfigurationSelector = effect === 'add-application-permissions'
      ? { effect, purpose: view?.applicationConfiguration?.effect === effect ? view.applicationConfiguration.purpose : 'agent-conversation' }
      : effect === 'create-application-version' ? { effect, ...(publicationDraft?.kind === 'create-version' ? { draft: publicationDraft } : {}) }
      : effect === 'submit-application-version' ? { effect, ...(publicationDraft?.kind === 'submit-version' ? { draft: publicationDraft } : {}) } : { effect }
    const accepted = async (work: () => Promise<ConnectionSetupView>, kind?: ConnectionSetupAction['kind']) => {
      const expected = occurrence.current + 1, result = await perform(id, work, false, kind, selector)
      return result && currentSource() && context.current.opened && selection.current === id && occurrence.current === expected ? result : null
    }
    let result = await accepted(() => source('connection.setup.inspect', { operationId: id, applicationInspection: selector.effect === 'submit-application-version' && selector.draft ? { versionId: selector.draft.versionId } : {}, applicationConfiguration: selector }))
    if (!result || result.applicationConfiguration?.effect !== effect) return
    const reread = !!result.applicationConfiguration.review || !!result.applicationConfiguration.selected
    const checked = new Set<string>()
    for (;;) {
      const current = result.applicationConfiguration
      const subjects = current && 'requiredSubjects' in current ? current.requiredSubjects : effect === 'add-application-permissions' ? ['permission-catalog', 'application-permissions'] as const : ['event-settings', 'event-catalog'] as const
      const subject = subjects.find(subject => !checked.has(subject))
      if (!subject) break
      checked.add(subject)
      if (subject === 'publication-version' && selector.effect === 'submit-application-version' && !selector.draft) continue
      const configuration = result.applicationConfiguration
      if (!configuration || configuration.effect !== effect || !('sources' in configuration) || selector.effect === 'add-application-permissions' && (configuration.effect !== selector.effect || configuration.purpose !== selector.purpose)) return
      const hasSource = Object.values(configuration.sources).some(source => source?.subject === subject)
      const recovery = result.applicationInspection?.selected?.subject === subject && result.applicationInspection.actions.find(a => a.kind === 'recover-application-inspection')
      const action = recovery || (reread || !hasSource ? result.applicationInspection?.actions.find(a => a.kind === 'read-' + subject) : null)
      if (!action) { if (hasSource) continue; return }
      const versionId = action.kind === 'read-publication-version' ? action.versionId : action.kind === 'recover-application-inspection' ? result.applicationInspection?.selected?.input.versionId : undefined
      const input = { operationId: id, expectedRevision: action.expectedRevision, decision: { actionId: action.actionId, value: connectionSetupDecisionForAction(action) }, ...(versionId ? { versionId } : {}) }
      result = await accepted(() => source('connection.setup.advance', input), action.kind)
      if (!result || result.applicationInspection?.selected?.request !== 'confirmed' || result.applicationInspection.selected.secureStorage !== 'stored') return
    }
  }
  const reviewPermissions = () => reviewConfiguration('add-application-permissions')
  const reviewMessageReception = () => reviewConfiguration('add-message-reception')
  const reviewPublication = (selector: Extract<ConnectionSetupConfigurationSelector, { effect: ConnectionSetupPublicationEffect }>) => reviewConfiguration(selector.effect, selector.draft)
  async function checkGuidedSettings() {
    if (!operation || busy) return
    const id = operation.operationId, owner = {}
    checkOwner.current = owner; setGuidedCheck(true)
    const checked = new Set<string>()
    const accepted = async (work: () => Promise<ConnectionSetupView>, selector: ConnectionSetupConfigurationSelector, kind?: ConnectionSetupAction['kind']) => {
      const expected = occurrence.current + 1, result = await perform(id, work, false, kind, selector)
      return result && currentSource() && context.current.opened && checkOwner.current === owner && selection.current === id && occurrence.current === expected ? result : null
    }
    const inspect = (selector: ConnectionSetupConfigurationSelector) => accepted(() => source('connection.setup.inspect', { operationId: id, applicationInspection: {}, applicationConfiguration: selector }), selector)
    try {
      // One explicit bounded check; writes are never part of this loop.
      for (const effect of ['enable-messaging', 'use-persistent-connection', 'add-application-permissions', 'add-message-reception', 'use-persistent-callback', 'add-card-actions'] as const) {
        const selector: ConnectionSetupConfigurationSelector = effect === 'add-application-permissions' ? { effect, purpose: 'agent-conversation' } : { effect }
        let result = await inspect(selector)
        if (!result || result.applicationConfiguration?.effect !== effect) return
        const task = connectionManagementTask(result)
        if (task.kind === 'original' || task.kind === 'console' || task.kind === 'action' && (task.action.kind === 'recover-configuration-effect' || task.action.kind === 'recover-application-inspection')) return
        const subjects = effect === 'enable-messaging' ? ['bot-settings'] as const : effect === 'use-persistent-connection' ? ['event-settings'] as const : effect === 'use-persistent-callback' || effect === 'add-card-actions' ? ['callback-settings'] as const : effect === 'add-application-permissions' ? ['permission-catalog', 'application-permissions'] as const : ['event-settings', 'event-catalog'] as const
        for (const subject of subjects) {
          const configuration = result.applicationConfiguration
          if (!configuration || configuration.effect !== effect) return
          const sources = 'source' in configuration ? [configuration.source] : 'sources' in configuration ? Object.values(configuration.sources) : []
          if (checked.has(subject) && sources.some(value => value?.subject === subject && value.request === 'confirmed' && value.secureStorage === 'stored')) continue
          const recovery = result.applicationInspection?.selected?.subject === subject && result.applicationInspection.actions.find(action => action.kind === 'recover-application-inspection')
          const action = recovery || result.applicationInspection?.actions.find(action => action.kind === 'read-' + subject)
          if (!action) return
          const input = { operationId: id, expectedRevision: action.expectedRevision, decision: { actionId: action.actionId, value: connectionSetupDecisionForAction(action) } }
          result = await accepted(() => source('connection.setup.advance', input), selector, action.kind)
          if (!result || result.applicationInspection?.selected?.subject !== subject || result.applicationInspection.selected.request !== 'confirmed' || result.applicationInspection.selected.secureStorage !== 'stored') return
          checked.add(subject)
        }
        if (result.applicationConfiguration?.capability !== 'enabled') return
      }
      // History identifies an original result; it never selects a different version by label or order.
      const submitted = await inspect({ effect: 'submit-application-version' })
      const selected = submitted?.applicationConfiguration?.selected
      if (!submitted || submitted.applicationConfiguration?.reason === 'original-effect-unconfirmed' || submitted.applicationConfiguration?.actions.some(action => action.kind === 'recover-configuration-effect')) return
      if (selected?.effect === 'submit-application-version' && selected.input.publicationDraft?.kind === 'submit-version') {
        await inspect({ effect: 'submit-application-version', draft: selected.input.publicationDraft, selectedStepId: selected.stepId })
      } else await inspect({ effect: 'create-application-version' })
    } finally { if (checkOwner.current === owner) { checkOwner.current = null; setGuidedCheck(false) } }
  }
  function inspectOriginalConfiguration() {
    const original = configuration?.unresolved, stepId = original?.stepId ?? configuration?.selected?.stepId
    inspectOriginal({ applicationInspection: {}, applicationConfiguration: { ...configurationSelector, ...(stepId ? { selectedStepId: stepId } : {}) } }, original?.operationId)
  }
  async function checkPublicationStatus() {
    const selected = configuration?.selected, draft = selected?.input.publicationDraft
    if (!operation || selected?.effect !== 'submit-application-version' || draft?.kind !== 'submit-version' || selected.versionId !== draft.versionId || busy) return
    const id = operation.operationId, selector = { effect: 'submit-application-version' as const, draft, selectedStepId: selected.stepId }
    const expected = occurrence.current + 1
    const offered = await perform(id, () => source('connection.setup.inspect', { operationId: id, applicationInspection: { versionId: draft.versionId }, applicationConfiguration: selector }), false, undefined, selector)
    if (!offered || !currentSource() || !context.current.opened || selection.current !== id || occurrence.current !== expected) return
    const action = offered.applicationInspection?.actions.find(action => action.kind === 'read-publication-version' && action.versionId === draft.versionId)
    if (!action) return
    const input: ConnectionSetupAdvance = { operationId: id, expectedRevision: action.expectedRevision, decision: { actionId: action.actionId, value: 'continue' }, versionId: draft.versionId }
    await perform(id, () => source('connection.setup.advance', input), false, action.kind, selector)
  }

  function returnToGuided() { inspectOriginal({ applicationInspection: {}, applicationConfiguration: { effect: 'enable-messaging' } }) }
  function continueOriginal() {
    const action = view?.continuation?.actions.find(action => action.kind === 'continue')
    if (action) { advance(action); return }
    const input = operation && matches(operation) ? inputOf(operation) : local.find(item => item.key === key && item.input.operationId === visible?.id)?.input
    if (input) void perform(input.operationId, () => source('connection.setup.begin', input), true)
  }
  function another() {
    checkOwner.current = null; setGuidedCheck(false)
    occurrence.current++; selection.current = null; draft.current = null; submittedActions.current.clear()
    setReading(null); setPublication(null); setDriving(false); setFresh(true)
  }

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; occurrence.current++; listOccurrence.current++ } }, [])
  useEffect(() => {
    checkOwner.current = null; setGuidedCheck(false)
    occurrence.current++; listOccurrence.current++; selection.current = null; draft.current = null
    if (!active || requestedHandoff.current?.key !== key || requestedHandoff.current?.source !== source) requestedHandoff.current = null
    setReading(null); setPublication(null); setDriving(false); setListing(false); setFresh(false); submittedActions.current.clear()
    if (active && record) void list()
  }, [key, source, active])
  useEffect(() => {
    checkOwner.current = null; setGuidedCheck(false)
    occurrence.current++; selection.current = null; setReading(null); setPublication(null); setDriving(false); setFresh(false); submittedActions.current.clear()
    if (!opened) requestedHandoff.current = null
  }, [opened])
  useEffect(() => {
    const submission = requestedHandoff.current
    if (!active || !opened || !submission || submission.key !== key || submission.source !== source) return
    requestedHandoff.current = null
    setFresh(false); submittedActions.current.clear()
    void perform(submission.input.operationId, () => source('connection.setup.begin', submission.input), false)
  }, [active, opened, key, source])

  useEffect(() => {
    if (!active || !opened || !driving || busy || !operation || !matches(operation) || view?.reason || visible?.issue) return
    const continuation = view?.continuation
    const action = continuation?.actions.find(action => action.kind === 'continue')
    if (!continuation || !['waiting', 'scanned', 'handoff'].includes(continuation.stage) || !action) return
    if (submittedActions.current.has(action.actionId)) { setDriving(false); return }
    let timer: ReturnType<typeof setTimeout>
    let cancelled = false
    const deadline = view?.challenge?.nextPollAt ?? Date.now()
    const next = () => {
      if (cancelled || !currentSource() || !context.current.opened) return
      const remaining = deadline - Date.now()
      if (remaining > 0) timer = setTimeout(next, Math.min(remaining, 2_147_483_647))
      else advance(action)
    }
    timer = setTimeout(next, Math.min(Math.max(0, deadline - Date.now()), 2_147_483_647))
    return () => { cancelled = true; clearTimeout(timer) }
  }, [active, opened, driving, busy, key, source, view])

  return { task: connectionManagementTask(view), guidedCheck, checkGuidedSettings, checkPublicationStatus, returnToGuided, inspectOriginalConfiguration, publicationForm, editPublicationForm, supported, catalog: visibleCatalog, listing, choices, reading: visible, view, observedView, busy, driving, fresh, revised, list, start, handoff, choose, inspect, inspectOriginal, advance, reviewPermissions, reviewMessageReception, reviewPublication, continueOriginal, another }
}

export type ConnectionManagementModel = ReturnType<typeof useConnectionManagementSetup>
