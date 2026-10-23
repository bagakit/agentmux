import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { mintObjectId } from '@agentmux/core/object-id'
import { useEffect, useRef, useState } from 'react'
import { parseFileReadResult } from '@agentmux/core/files'
import { parseMoteAvatarWriteResult } from '@agentmux/core/mote-avatar-write'
import {
  parseMoteConnectionResult,
  type MoteConnectionOperation,
  type MoteConnectionSource
} from '@agentmux/core/mote-connections'
import { sameMotePreferencesTarget, type MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import type {
  ConnectionRecord,
  ConnectionEnrollmentCapability,
  ConnectionEnrollmentView,
  ConnectionEnrollmentAction
} from '@agentmux/core/connections'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { topicPublicCopy } from '../../../shared/scratch-topics'
import { api } from './api'
import { retainMoteBotRequest, retireMoteBotRequest, setBotTaskSelection, useAppStore } from '../store'
import type { MoteBotRequest } from './mote-bot-request'
import { botTaskSelectionKey, readBotTaskLocator } from './bot-task-selection'
import { initialBotPublication } from './bot-creation-preset'

export type SavedMoteBotProfile = {
  name: string
  description: string | null
  image: string | null
  source: MoteConnectionSource
  avatarIssue: string | null
}
/** Reads the saved public source. This preview never creates or synchronizes a bot. */
export async function readSavedMoteBotProfile(
  target: MotePreferencesTarget,
  topicId: string
): Promise<SavedMoteBotProfile> {
  const input = { ...target, path: 'topic.md' }
  const saved = parseFileReadResult(await api.files.readPublic(input), input)
  if (saved.result.status !== 'read')
    throw new Error('The saved public profile could not be read. Your files and bot choice are kept.')
  const copy = topicPublicCopy(saved.result.document.content)
  if (!copy.title)
    throw new Error('Save a name in this Mote’s topic.md before creating or synchronizing its bot.')
  let image: string | null = null,
    revision: string | null = null,
    avatarIssue: string | null = null
  try {
    const input = {
      target: { workspaceId: target.expectedResource.workspaceId, topicId, objectKey: target.spaceId }
    }
    const saved = parseMoteAvatarWriteResult(
      'space.mote.avatar.read',
      await api.moteAvatars.read(input),
      input
    )
    image = saved.image?.dataUrl ?? null
    revision = saved.revision
    if (!image) avatarIssue = saved.issues.join(' ') || 'The current Mote avatar could not be read. Refresh this profile to try again.'
  } catch (error) {
    avatarIssue = 'The current Mote avatar could not be read. Refresh this profile to try again. ' + presentError(error)
  }
  return {
    name: copy.title,
    description: copy.summary || null,
    image,
    avatarIssue,
    source: {
      target,
      preparedFrom: { topicRevision: saved.result.document.revision, avatarRevision: revision }
    }
  }
}

/** A bounded UI reading window. Main owns the original operation and every child receipt. */
export function useMoteBotSetup(target: MotePreferencesTarget | null, topicId: string, newHostingTarget?: ConnectionHostingTarget | null) {
  const retainedSelection = () => target ? readBotTaskLocator(useAppStore.getState().botTaskSelections[botTaskSelectionKey({ kind: 'mote', target })]) : null
  const identity = JSON.stringify(target),
    historySource = JSON.stringify([identity, topicId, newHostingTarget]),
    lifetime = useRef(0),
    enrollmentRead = useRef(0),
    occurrences = useRef(new Map<string, number>())
  const writing = useRef(new Set<string>()),
    draft = useRef(0),
    creating = useRef<number | null>(null)
  const [operations, setOperations] = useState<Array<MoteConnectionOperation & { hostingTarget: ConnectionHostingTarget }>>([]),
    [selectedId, setSelected] = useState<string | null>(() => retainedSelection()?.operationId ?? null)
  const [checkingId, setChecking] = useState<string | null>(selectedId)
  const [profile, setProfile] = useState<SavedMoteBotProfile | null>(null),
    [capabilities, setCapabilities] = useState<ConnectionEnrollmentCapability[]>([])
  const [message, setMessage] = useState<{ kind: 'issue' | 'notice' | 'owner-unconfirmed'; text: string }>({ kind: 'issue', text: '' })
  const setIssue = (text: string) => setMessage({ kind: 'issue', text })
  const [busy, setBusy] = useState<string[]>([]),
    [next, setNext] = useState<{ cursor: string; hostingTarget: ConnectionHostingTarget } | null>(null)
  const [loading, setLoading] = useState(false),
    [historyRead, setHistoryRead] = useState<string | null>(null),
    [driving, setDriving] = useState(false)
  const [progressIssue, setProgressIssue] = useState<{ id: string; text: string } | null>(null)
  const [enrollmentView, setEnrollmentView] = useState<{
    parentId: string
    value: ConnectionEnrollmentView
  } | null>(null)
  const selection = useRef<string | null>(selectedId),
    feedback = useRef(0),
    sourceRead = useRef(0),
    listRead = useRef(0)
  const ownerFor = (id: string) => {
    const retained = useAppStore.getState().moteBotRequests[id]
    if (retained) return retained.hostingTarget ?? null
    const locator = retainedSelection()
    if (locator?.operationId === id) return locator.hostingTarget
    return operations.find(operation => operation.operationId === id)?.hostingTarget ?? null
  }
  const pick = (id: string | null, hostingTarget = id ? ownerFor(id) : null) => {
    setDriving(false)
    selection.current = id
    feedback.current++
    setSelected(id)
    if (target) setBotTaskSelection({ kind: 'mote', target }, id && hostingTarget ? { operationId: id, hostingTarget } : id)
  }
  const raw = useAppStore((state) => state.moteBotRequests)
  const requests = Object.values(raw).filter(
    (row) => target && sameMotePreferencesTarget(row.input.source.target, target)
  )
  const occurrence = (id: string) => {
    const next = (occurrences.current.get(id) ?? 0) + 1
    occurrences.current.set(id, next)
    return next
  }
  const accept = (value: MoteConnectionOperation, hostingTarget: ConnectionHostingTarget) => {
    const known = ownerFor(value.operationId)
    if ((useAppStore.getState().moteBotRequests[value.operationId] || retainedSelection()?.operationId === value.operationId) && !known)
      throw new Error('The original bot hosting owner is unconfirmed. Its request and task are kept.')
    if (known && JSON.stringify(known) !== JSON.stringify(hostingTarget)) throw new Error('This reading belongs to another bot hosting owner. The original task is kept.')
    if (!target || !sameMotePreferencesTarget(value.source.target, target)) return
    const retained = useAppStore.getState().moteBotRequests[value.operationId]
    if (retained && !retained.inspectOnly) {
      if (retained.action === 'create') parseMoteConnectionResult('space.mote.connection.create', value, retained.input)
      else parseMoteConnectionResult('space.mote.connection.sync', value, retained.input)
    }
    setOperations((previous) =>
      previous.some((item) => item.operationId === value.operationId)
        ? previous.map((item) => (item.operationId === value.operationId ? { ...value, hostingTarget } : item))
        : [{ ...value, hostingTarget }, ...previous]
    )
  }
  const acceptEnrollment = (parentId: string, value: ConnectionEnrollmentView) => {
    setEnrollmentView(current => current?.parentId === parentId && current.value.operation && value.operation
      && current.value.operation.operationId === value.operation.operationId && current.value.operation.revision > value.operation.revision
      ? current : { parentId, value })
  }
  async function newOwner(): Promise<ConnectionHostingTarget> {
    if (newHostingTarget === null) throw new Error('The bot hosting owner for this new action is unconfirmed. Existing tasks and requests are kept.')
    return newHostingTarget ? structuredClone(newHostingTarget) : await api.connections.hostingTarget()
  }
  async function list(cursor?: string) {
    if (!target) return
    const token = lifetime.current,
      before = new Map(occurrences.current),
      request = ++listRead.current,
      message = feedback.current
    if (!cursor) setHistoryRead(null)
    try {
      if (cursor && cursor !== next?.cursor) throw new Error('Reopen the original bot setup page before reading its next page.')
      const hostingTarget = cursor && next ? next.hostingTarget : await newOwner()
      if (token !== lifetime.current || request !== listRead.current) return
      const result = await api.moteConnections.call('space.mote.connection.ls', {
        target,
        limit: 25,
        ...(cursor ? { cursor } : {})
      }, hostingTarget)
      if (token !== lifetime.current || request !== listRead.current) return
      for (const operation of result.operations)
        if (before.get(operation.operationId) === occurrences.current.get(operation.operationId)) {
          try { accept(operation, hostingTarget) }
          catch (error) { if (message === feedback.current) setIssue(presentError(error)) }
        }
      setNext(result.next ? { cursor: result.next, hostingTarget } : null)
      if (!cursor) setHistoryRead(historySource)
    } catch (error) {
      if (token === lifetime.current && request === listRead.current && !cursor)
        setHistoryRead(null)
      if (token === lifetime.current && message === feedback.current) setIssue(presentError(error))
    }
  }
  async function refreshSource() {
    if (!target) return
    const token = lifetime.current,
      request = ++sourceRead.current,
      message = feedback.current
    setLoading(true)
    try {
      const value = await readSavedMoteBotProfile(target, topicId)
      if (token === lifetime.current && request === sourceRead.current) {
        setProfile(value)
        if (message === feedback.current) setIssue('')
      }
    } catch (error) {
      if (token === lifetime.current && request === sourceRead.current) {
        setProfile(null)
        if (message === feedback.current) setIssue(presentError(error))
      }
    } finally {
      if (token === lifetime.current && request === sourceRead.current) setLoading(false)
    }
  }
  useEffect(() => {
    lifetime.current++
    const token = lifetime.current
    setOperations([])
    setHistoryRead(null)
    setEnrollmentView(null)
    const retained = retainedSelection()
    pick(retained?.operationId ?? null, retained?.hostingTarget ?? null)
    setProfile(null)
    setIssue('')
    setNext(null)
    draft.current++
    void refreshSource()
    void list()
    if (retained) void check(retained.operationId)
    setCapabilities([])
    void newOwner().then(hostingTarget => api.connections.call('connection.enrollment.ls', { limit: 1 }, hostingTarget))
      .then((value) => {
        if (token === lifetime.current) setCapabilities(value.capabilities)
      })
      .catch(() => {})
    return () => {
      lifetime.current++
    }
  }, [identity, topicId, JSON.stringify(newHostingTarget)])
  const pending = (id: string, value: boolean) => {
    if (value) writing.current.add(id)
    else writing.current.delete(id)
    setBusy([...writing.current])
  }
  async function send(input: MoteBotRequest) {
    const request = structuredClone(input)
    const id = request.input.operationId
    if (!request.hostingTarget) {
      setMessage({ kind: 'owner-unconfirmed', text: 'The original bot hosting owner is unconfirmed. The original request is kept without contacting another Host.' })
      return
    }
    if (request.inspectOnly) {
      setIssue('This historical request is retained for checking only. Start an explicit new action to publish prepared profile data.')
      return
    }
    if (writing.current.has(id)) return
    const token = lifetime.current,
      order = occurrence(id)
    let dispatched = false
    pending(id, true)
    try {
      pick(id, request.hostingTarget)
      setIssue('')
      const saved = await retainMoteBotRequest({ ...request, phase: 'not-dispatched' })
      if (!saved.localStorageWritten)
        throw new Error('The original request could not be retained. Nothing was sent.')
      const dispatch = await retainMoteBotRequest({ ...request, phase: 'may-have-dispatched' })
      if (!dispatch.localStorageWritten) {
        await retainMoteBotRequest({ ...request, phase: 'not-dispatched' })
        throw new Error('The dispatch request could not be retained. Nothing was sent.')
      }
      dispatched = true
      const result =
        request.action === 'create'
          ? parseMoteConnectionResult(
              'space.mote.connection.create',
              await api.moteConnections.call('space.mote.connection.create', request.input, request.hostingTarget),
              request.input
            )
          : parseMoteConnectionResult(
              'space.mote.connection.sync',
              await api.moteConnections.call('space.mote.connection.sync', request.input, request.hostingTarget),
              request.input
            )
      const retired = await retireMoteBotRequest(request, result)
      const retentionIssue = retired && !retired.localStorageWritten ? 'The original Host accepted this request. Its local saved view could not be retained; check the same operation.' : ''
      if (token === lifetime.current && order === occurrences.current.get(id)) {
        accept(result, request.hostingTarget)
        if (result.enrollmentOperationId) {
          const observation = ++enrollmentRead.current
          const view = await api.connections.call('connection.enrollment.inspect', {
            operationId: result.enrollmentOperationId
          }, request.hostingTarget)
          if (token === lifetime.current && order === occurrences.current.get(id) && selection.current === id) {
            if (observation === enrollmentRead.current) acceptEnrollment(id, view)
            setDriving(request.action === 'create' && result.issue !== 'child-unconfirmed' &&
              view.actions.some(action => action.kind === 'continue-authentication'))
          }
        }
        if (result.setupOperationId && token === lifetime.current && selection.current === id) setDriving(true)
        if (token === lifetime.current && order === occurrences.current.get(id) && selection.current === id)
          setMessage({ kind: retentionIssue ? 'issue' : 'notice', text: retentionIssue })
      }
    } catch (error) {
      if (!dispatched) {
        try {
          await retainMoteBotRequest({ ...request, phase: 'not-dispatched' })
        } catch {
          /* The local request remains visible; its persistence failure is reported below. */
        }
      }
      if (token === lifetime.current && order === occurrences.current.get(id) && selection.current === id)
        setIssue(
          `${dispatched ? 'This setup is not confirmed. Its original request is kept; check the same result.' : 'No request was sent. Keep this request and continue after local storage is available.'} ${presentError(error)}`
        )
    } finally {
      pending(id, false)
    }
  }
  async function begin(capability: ConnectionEnrollmentCapability, includeAvatar: boolean, name?: string) {
    if (!profile || creating.current === draft.current) return
    if (!includeAvatar || !profile.image) {
      setIssue(
        'Creating a bot requires the saved PNG avatar. Existing bot choices and profile synchronization remain available.'
      )
      return
    }
    const original = draft.current
    creating.current = original
    try {
      const request: MoteBotRequest = {
        action: 'create',
        phase: 'not-dispatched',
        input: {
          operationId: mintObjectId(),
          source: profile.source,
          desired: { name: name === undefined ? profile.name : name.trim(), description: profile.description ?? '', avatar: { pngDataUrl: profile.image } },
          adapterId: capability.adapterId,
          domain: capability.domain,
          initialPublication: initialBotPublication
        }
      }
      const hostingTarget = await newOwner()
      if (draft.current === original) await send({ ...structuredClone(request), hostingTarget })
    } catch (error) {
      if (draft.current === original) setIssue(presentError(error))
    } finally {
      if (creating.current === original) creating.current = null
    }
  }
  async function sync(record: ConnectionRecord, includeAvatar: boolean) {
    if (!profile || creating.current === draft.current) return
    const original = draft.current
    creating.current = original
    try {
      const request: MoteBotRequest = {
        action: 'sync',
        phase: 'not-dispatched',
        input: {
          operationId: mintObjectId(),
          source: profile.source,
          desired: { name: profile.name, description: profile.description ?? '', ...(includeAvatar && profile.image ? { avatar: { pngDataUrl: profile.image } } : {}) },
          connection: { connectionId: record.config.connectionId, application: record.config.application },
          expectedConnectionRevision: record.revision
        }
      }
      const hostingTarget = await newOwner()
      if (draft.current === original) await send({ ...structuredClone(request), hostingTarget })
    } catch (error) {
      if (draft.current === original) setIssue(presentError(error))
    } finally {
      if (creating.current === original) creating.current = null
    }
  }
  async function check(id: string, advance = false, action?: ConnectionEnrollmentAction, automatic = false) {
    if (advance && writing.current.has(id)) return
    const hostingTarget = ownerFor(id)
    if (!hostingTarget) {
      setChecking(current => current === id ? null : current)
      setMessage({ kind: 'owner-unconfirmed', text: 'The original bot hosting owner is unconfirmed. The original task and request are kept without contacting another Host.' })
      return
    }
    const token = lifetime.current,
      order = occurrence(id)
    pick(id)
    setChecking(advance ? null : id)
    if (!automatic)
      setMessage({ kind: 'notice', text: advance ? 'Checking this setup…' : 'Reading the original result…' })
    if (advance) pending(id, true)
    let retentionIssue = ''
    try {
      const child = enrollmentView?.parentId === id ? enrollmentView.value.operation : null
      if (action && !child) throw new Error('Read the original account view before choosing its action.')
      const operation = advance
        ? await api.moteConnections.call('space.mote.connection.advance', {
            operationId: id,
            ...(action && child
              ? {
                  enrollment: {
                    operationId: child.operationId,
                    ownRevision: action.ownRevision,
                    decision: { actionId: action.actionId, kind: action.kind }
                  }
                }
              : {})
          }, hostingTarget)
        : (await api.moteConnections.call('space.mote.connection.inspect', { operationId: id }, hostingTarget)).operation
      if (token === lifetime.current && order === occurrences.current.get(id)) {
        if (operation && (!target || !sameMotePreferencesTarget(operation.source.target, target)))
          throw new Error('This original request belongs to another Mote. Its identifier is kept; choose this Mote’s original task.')
        if (operation) {
          const retained = useAppStore.getState().moteBotRequests[id]
          if (retained && !retained.inspectOnly) {
            const retired = await retireMoteBotRequest(retained, operation)
            if (retired && !retired.localStorageWritten) retentionIssue = 'The original Host receipt is available. Its local saved view could not be retained.'
          }
          if (token !== lifetime.current || order !== occurrences.current.get(id)) return
          accept(operation, hostingTarget)
        }
        if (operation?.enrollmentOperationId) {
          const observation = ++enrollmentRead.current
          const view = await api.connections.call('connection.enrollment.inspect', {
            operationId: operation.enrollmentOperationId
          }, hostingTarget)
          if (token === lifetime.current && order === occurrences.current.get(id) && selection.current === id) {
            if (observation === enrollmentRead.current) acceptEnrollment(id, view)
            setDriving(advance && !!action && ['continue-authentication', 'renew-authentication'].includes(action.kind) &&
              operation.issue !== 'child-unconfirmed' &&
              view.actions.some(item => item.kind === 'continue-authentication'))
          }
        }
        if (!automatic && token === lifetime.current && order === occurrences.current.get(id) && selection.current === id)
          setMessage(operation
            ? { kind: retentionIssue ? 'issue' : 'notice', text: retentionIssue || 'Saved progress checked.' }
            : { kind: 'issue', text: 'No recorded result was found. Keep the original request; this does not confirm that nothing happened.' }
          )
      }
    } catch (error) {
      if (token === lifetime.current && order === occurrences.current.get(id) && selection.current === id)
        setIssue(presentError(error))
    } finally {
      if (token === lifetime.current && order === occurrences.current.get(id) && selection.current === id) setChecking(null)
      if (advance) pending(id, false)
    }
  }
  useEffect(() => {
    if (!driving || !selectedId || busy.includes(selectedId) || enrollmentView?.parentId !== selectedId) return
    const view = enrollmentView.value,
      action = view.actions.find(item => item.kind === 'continue-authentication')
    if (!action) return
    const id = selectedId, token = lifetime.current, chosen = feedback.current
    const timer = setTimeout(() => {
      if (token === lifetime.current && selection.current === id && chosen === feedback.current)
        void check(id, true, action, true)
    }, view.challenge ? Math.max(0, view.challenge.nextPollAt - Date.now()) : 0)
    return () => clearTimeout(timer)
  }, [driving, selectedId, busy, enrollmentView])
  const selectedOperation = operations.find(item => item.operationId === selectedId) ?? null
  const observing = !!selectedId && busy.includes(selectedId) && selectedOperation?.enrollment?.authentication?.stage === 'confirmed', childId = selectedOperation?.enrollmentOperationId
  useEffect(() => {
    if (!observing || !selectedId || !childId) { setProgressIssue(null); return }
    let current = true, timer: ReturnType<typeof setTimeout>
    const token = lifetime.current, parentId = selectedId, hostingTarget = ownerFor(parentId)
    if (!hostingTarget) return
    const originalOwner = hostingTarget
    async function observe() {
      try {
        const observation = enrollmentRead.current
        const value = await api.connections.call('connection.enrollment.inspect', { operationId: childId! }, originalOwner)
        if (observation === enrollmentRead.current && current && token === lifetime.current && selection.current === parentId && writing.current.has(parentId)) { acceptEnrollment(parentId, value); setProgressIssue(null) }
      } catch {
        if (current && token === lifetime.current && selection.current === parentId && writing.current.has(parentId)) setProgressIssue({ id: parentId, text: 'The request is still pending here. Its latest progress could not be read; earlier results are kept.' })
      }
      if (current) timer = setTimeout(() => void observe(), 1000)
    }
    void observe()
    return () => { current = false; clearTimeout(timer) }
  }, [observing, selectedId, childId])
  return {
    profile,
    capabilities,
    operations,
    requests,
    selectedId,
    checking: checkingId === selectedId && selectedId !== null,
    enrollmentView: enrollmentView?.parentId === selectedId ? enrollmentView.value : null,
    operation: selectedOperation,
    issue: message.text,
    issueKind: message.kind,
    busy,
    loading,
    historyReady: historyRead === historySource,
    driving,
    progressIssue: progressIssue?.id === selectedId ? progressIssue.text : '',
    next: next?.cursor ?? null,
    list,
    refreshSource,
    begin,
    sync,
    acceptOperation: (value: MoteConnectionOperation) => {
      const hostingTarget = ownerFor(value.operationId)
      if (!hostingTarget) throw new Error('The original bot hosting owner is unconfirmed. Its task is kept.')
      accept(value, hostingTarget)
    },
    hostingTarget: selectedId ? ownerFor(selectedId) : null,
    check,
    send,
    select(id: string) {
      pick(id)
      setIssue('')
    },
    newIntent() {
      draft.current++
      pick(null)
      setIssue('')
    }
  }
}
