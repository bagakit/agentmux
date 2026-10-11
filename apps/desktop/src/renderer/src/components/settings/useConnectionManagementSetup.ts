import { useEffect, useRef, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { ConnectionRecord, ConnectionSetupAction, ConnectionSetupBegin, ConnectionSetupListing, ConnectionSetupOperation, ConnectionSetupView } from '@agentmux/core/connections'
import { connectionSetupDecisionForAction } from '@agentmux/core/connections'
import { api } from '../../lib/api'

type Source = typeof api.connections.call
type Submission = { key: string; source: Source; input: ConnectionSetupBegin }
type Catalog = { key: string; source: Source; value: ConnectionSetupListing | null; issue: string }
type Reading = { key: string; source: Source; id: string; value: ConnectionSetupView | null; issue: string; absent: boolean; pending: boolean }
const scope = (record: ConnectionRecord | null) => record ? JSON.stringify([record.config.connectionId, record.config.adapterId, record.config.application, record.revision]) : ''
const inputOf = (operation: ConnectionSetupOperation): ConnectionSetupBegin => ({ operationId: operation.operationId, connectionId: operation.connectionId, expectedConnectionRevision: operation.expectedConnectionRevision, goal: operation.goal })

/** The mounted Settings task retains safe submissions; private readings and timers are disposable. */
export function useConnectionManagementSetup(record: ConnectionRecord | null, active: boolean, opened: boolean) {
  const key = scope(record), source = api.connections.call
  const [catalog, setCatalog] = useState<Catalog | null>(null), [reading, setReading] = useState<Reading | null>(null)
  const [submissions, setSubmissions] = useState<Submission[]>([])
  const [listing, setListing] = useState(false), [driving, setDriving] = useState(false), [fresh, setFresh] = useState(false)
  const context = useRef({ key, source, active, opened }), mounted = useRef(false)
  const occurrence = useRef(0), listOccurrence = useRef(0), selection = useRef<string | null>(null)
  const submittedActions = useRef(new Set<string>()), draft = useRef<Submission | null>(null)
  context.current = { key, source, active, opened }
  const currentSource = () => mounted.current && context.current.active && context.current.key === key && context.current.source === source && api.connections.call === source
  const visibleCatalog = catalog?.key === key && catalog.source === source ? catalog : null
  const visible = active && opened && reading?.key === key && reading.source === source && reading.id === selection.current && api.connections.call === source ? reading : null
  const view = visible?.value ?? null, operation = view?.operation ?? null
  const supported = !!record && visibleCatalog?.value?.support?.connectionRevision === record.revision && visibleCatalog.value.support.capabilities.includes('management-authentication')
  const originals = visibleCatalog?.value?.operations ?? []
  const local = submissions.filter(item => item.input.connectionId === record?.config.connectionId && item.source === source)
  const choices = [...originals.map(operation => ({ input: inputOf(operation), operation })), ...local.filter(item => !originals.some(o => o.operationId === item.input.operationId)).map(item => ({ input: item.input, operation: null }))]
  const busy = visible?.pending ?? false
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

  function matches(operation: ConnectionSetupOperation) {
    return !!record && operation.connectionId === record.config.connectionId && operation.adapterId === record.config.adapterId &&
      operation.expectedConnectionRevision === record.revision && operation.application.domain === record.config.application.domain && operation.application.appId === record.config.application.appId &&
      operation.goal.kind === 'agent-conversation' && operation.goal.interaction === 'messages'
  }
  async function perform(id: string, work: () => Promise<ConnectionSetupView>, run: boolean) {
    if (!currentSource() || !context.current.opened) return
    const request = ++occurrence.current
    selection.current = id; setDriving(run)
    setReading(previous => previous?.key === key && previous.source === source && previous.id === id
      ? { ...previous, issue: '', absent: false, pending: true } : { key, source, id, value: null, issue: '', absent: false, pending: true })
    const accepts = () => currentSource() && context.current.opened && selection.current === id && request === occurrence.current
    try {
      const value = await work()
      if (!accepts()) return
      if (value.operation && (value.operation.operationId !== id || !matches(value.operation)) && !(value.reason === 'connection-revised' && !value.challenge && !value.continuation)) throw new Error('This result could not be matched to the saved application. The original request is kept.')
      setReading({ key, source, id, value, issue: '', absent: !value.operation, pending: false })
      if (value.operation) setCatalog(previous => previous?.key === key && previous.source === source && previous.value
        ? { ...previous, value: { ...previous.value, operations: [value.operation!, ...previous.value.operations.filter(o => o.operationId !== id)] } } : previous)
      if (!value.operation || value.reason || !value.continuation || !['waiting', 'scanned', 'handoff'].includes(value.continuation.stage)) setDriving(false)
    } catch (error) {
      if (accepts()) { setReading({ key, source, id, value: null, issue: presentError(error), absent: false, pending: false }); setDriving(false) }
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
    void perform(input.operationId, () => source('connection.setup.inspect', { operationId: input.operationId }), true)
  }
  function inspect() {
    if (visible) void perform(visible.id, () => source('connection.setup.inspect', { operationId: visible.id }), false)
  }
  function advance(action: ConnectionSetupAction) {
    if (!operation) return
    const input = { operationId: operation.operationId, expectedRevision: action.expectedRevision, decision: { actionId: action.actionId, value: connectionSetupDecisionForAction(action) } } as const
    submittedActions.current.add(action.actionId)
    void perform(input.operationId, () => source('connection.setup.advance', input), action.kind === 'continue' || action.kind === 'renew')
  }
  function continueOriginal() {
    const action = view?.continuation?.actions.find(action => action.kind === 'continue')
    if (action) { advance(action); return }
    const input = operation && matches(operation) ? inputOf(operation) : local.find(item => item.key === key && item.input.operationId === visible?.id)?.input
    if (input) void perform(input.operationId, () => source('connection.setup.begin', input), true)
  }
  function another() {
    occurrence.current++; selection.current = null; draft.current = null; submittedActions.current.clear()
    setReading(null); setDriving(false); setFresh(true)
  }

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; occurrence.current++; listOccurrence.current++ } }, [])
  useEffect(() => {
    occurrence.current++; listOccurrence.current++; selection.current = null; draft.current = null
    setReading(null); setDriving(false); setListing(false); setFresh(false); submittedActions.current.clear()
    if (active && record) void list()
  }, [key, source, active])
  useEffect(() => {
    occurrence.current++; selection.current = null; setReading(null); setDriving(false); setFresh(false); submittedActions.current.clear()
  }, [opened])

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

  return { supported, catalog: visibleCatalog, listing, choices, reading: visible, view, busy, driving, fresh, revised, list, start, choose, inspect, advance, continueOriginal, another }
}

export type ConnectionManagementModel = ReturnType<typeof useConnectionManagementSetup>
