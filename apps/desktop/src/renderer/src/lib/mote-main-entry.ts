import { useCallback, useEffect, useRef, useState } from 'react'
import { parseMoteDialogueResult, sameMoteMainEntrySource, unconfirmedMoteMainEntryOperation, type MoteDialogueRecoveryRequest } from '@agentmux/core/mote-dialogue'
import { useMoteDialogueView } from './mote-dialogue-view'
import type { MoteWorkfaceScope } from './mote-workface'
import { useAppStore } from '../store'
import { api } from './api'
import { agentSessionPresentationIndex } from './session-presentation'
import { currentUnconfirmedResumeOperation } from './continuity-presentation'

/** `unavailable` is Core's own result that this Main has nothing to resume; a new round is the way forward. */
type EntryState = { status:'idle'|'reading'|'recovering'|'unconfirmed'|'unavailable'|'settled'; issue:string|null }
/** Core's reason that the exact Main cannot be resumed, in words that name the way forward. */
export function moteMainUnavailableIssue(reason: string): string {
  switch (reason) {
    case 'native-conversation-absent': return '主 Agent 已退出，AgentMux 没有它可接续的原生对话。原对话和草稿都在；可开始新一轮，由新的主 Agent 接上。'
    case 'native-handle-unavailable': return '主 Agent 已退出，AgentMux 尚未确认可接续原会话的 ID。原对话和草稿仍可查看，也可以明确开始新一轮。'
    case 'provider-resume-unsupported': return '这个主 Agent 的 Provider 不支持恢复原对话。原对话和草稿都在；可开始新一轮，由新的主 Agent 接上。'
    case 'provider-unavailable': return '这台 Host 上找不到主 Agent 的 Provider。装好后可再次打开以恢复；原对话和草稿都在。'
    case 'unknown-session': return 'Core 已不认识这个主 Agent 的 Session。原对话和草稿都在；可开始新一轮，由新的主 Agent 接上。'
    default: return `主 Agent 无法恢复（${reason}）。原对话和草稿都在；可开始新一轮，由新的主 Agent 接上。`
  }
}
/** One explicit UI entry consumes the original Core owner. This token grants no Core authority. */
export function useMoteMainEntry({ scope, entryToken, active }: { scope:MoteWorkfaceScope|null; entryToken?:string|undefined; active:boolean }) {
  const dialogue = useMoteDialogueView(), main = dialogue?.page?.main, target = dialogue?.target
  const current = main?.current
  const session = useAppStore(state => {
    const matches = current ? agentSessionPresentationIndex(state.sessions).get(current.sessionId)?.filter(item =>
      item.control.hostId === current.hostId && item.control.agentSessionId === current.sessionId) : undefined
    return matches?.length === 1 ? matches[0] : undefined
  })
  // Canonical Core facts remain visible even when no automatic entry was admitted.
  // An old role or Run cannot explain a healthy/current replacement.
  const original = session?.continuity
  const currentOriginal = active && main?.status === 'ready' && current && target && main.roleRevision && session?.processState !== 'running' &&
    original?.agentSessionId === current.sessionId && original.previousRun.runId === session?.control.run.runId &&
    (!original.moteMainEntry || sameMoteMainEntrySource(original.moteMainEntry, { target, expectedRoleRevision:main.roleRevision, reference:current })) ? original : null
  const canonicalUnavailable = currentOriginal?.kind === 'unavailable'
  const canonicalUnknown = session && currentOriginal && currentUnconfirmedResumeOperation(session)
  const [state, setState] = useState<EntryState & { key:string|null }>({ key:null, status:'idle', issue:null })
  const retained = useRef<{ key:string; request:MoteDialogueRecoveryRequest } | null>(null)
  const entryKey = active && scope && target && entryToken ? JSON.stringify([target,entryToken]) : null
  const sourceKey = JSON.stringify([main?.current,main?.roleRevision,session?.control.run])
  const key = entryKey ? JSON.stringify([entryKey,sourceKey]) : null
  const latest = useRef(key); latest.current = key
  const admission = useRef<{ key:string; cancelled:boolean; started:boolean; source?:string } | null>(null)
  useEffect(() => {
    if (!entryKey) return
    if (admission.current?.key !== entryKey) admission.current = { key:entryKey, cancelled:false, started:false }
    const events = ['pointerdown','keydown','input'] as const
    const detach = () => { for (const event of events) document.removeEventListener(event,cancel,true) }
    const cancel = () => {
      const original = admission.current
      if (original?.key !== entryKey || original.started) return
      // The first interaction is the whole answer. Staying attached would render this owner again
      // from a capture listener on every later keystroke, before React handles that keystroke, and
      // that render writes a controlled field's old value back over the character just typed.
      original.cancelled = true; detach()
      setState({ key, status:'settled', issue:null })
    }
    for (const event of events) document.addEventListener(event,cancel,true)
    return detach
  }, [entryKey])
  const observe = useCallback(async (key:string, request:MoteDialogueRecoveryRequest, inspect:boolean) => {
    if (latest.current !== key || !inspect && admission.current?.cancelled) return
    setState({ key, status:'recovering', issue:null })
    try {
      // A lost ensure ACK or a second client first reads the exact original
      // deterministic key; only an authoritative absent receipt admits Start.
      let result = parseMoteDialogueResult('space.mote.dialogue.recovery.inspect', await api.moteDialogue.inspectRecovery(request), request)
      if (!inspect && !result.operation) {
        if (latest.current !== key || admission.current?.cancelled) return
        if (admission.current) admission.current.started = true
        result = parseMoteDialogueResult('space.mote.dialogue.recovery.ensure', await api.moteDialogue.ensureRecovery(request), request)
      }
      const op = result.operation
      if (latest.current !== key) return
      if (op) retained.current = { key, request:{ ...request, ...op.moteMainEntry, expectedRun:op.previousRun, operationId:op.operationId } }
      const settled = op && (op.kind === 'resumed' || op.kind === 'reattachable')
      setState(settled ? { key, status:'settled', issue:null }
        : op?.kind === 'unavailable' ? { key, status:'unavailable', issue:moteMainUnavailableIssue(op.reason) }
        : { key, status:'unconfirmed', issue:op
          ? `原恢复操作 ${op.operationId} 尚未确认（${op.reason}）；保留原对话，可核对同一操作。`
          : '原恢复操作尚未读到；保留原对话和输入，不重复启动。' })
      if (settled) await useAppStore.getState().refreshSession(request.reference.sessionId)
    } catch (error) {
      if (latest.current === key) setState({ key, status:'unconfirmed', issue:error instanceof Error ? error.message : String(error) })
    }
  }, [])
  useEffect(() => {
    if (!key) { setState({ key, status:'idle', issue:null }); return }
    if (!main || dialogue?.loading && !dialogue.page) {
      setState(dialogue?.issue ? { key, status:'unconfirmed', issue:dialogue.issue } : { key, status:'reading', issue:null }); return
    }
    if (main.status !== 'ready') { setState({ key, status:'unconfirmed', issue:main.issue ?? '原主角色尚未确认；保留原工作面。' }); return }
    if (!main.current || !main.roleRevision || !target) { setState({ key, status:'settled', issue:null }); return }
    if (retained.current?.key === key || admission.current?.cancelled) return
    if (session?.kind !== 'agent') { setState({ key, status:'unconfirmed', issue:'原主 Agent 的执行引用尚未读到；保留原对话与原工作面。' }); return }
    const admitted = admission.current
    if (admitted?.source && admitted.source !== sourceKey) return
    if (admitted) admitted.source = sourceKey
    const source = { target, expectedRoleRevision:main.roleRevision, reference:main.current }, expectedRun = { ...session.control.run }
    const original = session.continuity
    if (original && original.previousRun.runId === expectedRun.runId && unconfirmedMoteMainEntryOperation(original) && sameMoteMainEntrySource(original.moteMainEntry, source)) {
      const request = { ...source, ...original.moteMainEntry, expectedRun, operationId:original.operationId }
      retained.current = { key, request }; void observe(key,request,true); return
    }
    // The original continuity map owns this key across remounts and clients.
    const t = source.target, r = source.reference
    const frozen = JSON.stringify([entryToken,t.spaceId,t.zoneId,t.expectedResource.hostId,t.expectedResource.workspaceId,t.expectedResource.workspacePath,
      source.expectedRoleRevision,r.hostId,r.sessionId,r.displayWorkspaceId,r.groupId,r.tabId,r.regionId,expectedRun.runId])
    retained.current = { key, request:{ ...source,expectedRun,operationId:'' } }
    void crypto.subtle.digest('SHA-256',new TextEncoder().encode(frozen)).then(hash => {
      if (latest.current !== key || admission.current?.cancelled) return
      const operationId = 'mote-entry-' + Array.from(new Uint8Array(hash),byte => byte.toString(16).padStart(2,'0')).join('')
      const request = { ...source,expectedRun,operationId }; retained.current = { key, request }
      void observe(key,request,false)
    }).catch(error => {
      if (latest.current === key) setState({ key, status:'unconfirmed', issue:error instanceof Error ? error.message : String(error) })
    })
  }, [key,main,dialogue?.loading,dialogue?.issue,session?.kind === 'agent' ? session.control.run.runId : null,target,observe,canonicalUnavailable])
  const inspect = useCallback(() => {
    const held = retained.current
    if (held?.request.operationId && held.key === latest.current) void observe(held.key,held.request,true)
    else if (session) void useAppStore.getState().refreshSession(session.id).catch(error => {
      if (latest.current === key) setState({ key, status:'unconfirmed', issue:error instanceof Error ? error.message : String(error) })
    })
  }, [observe,session,key])
  return { ...(canonicalUnavailable ? { status:'unavailable' as const, issue:moteMainUnavailableIssue(currentOriginal.reason) }
    : canonicalUnknown ? { status:'unconfirmed' as const, issue:'原主 Agent 的恢复结果尚未确认，原对话和未确认的消息都在。可核对原恢复，或明确开始新一轮。' } : state.key === key && !(state.status === 'unavailable' && session?.processState === 'running') ? state : { status:'idle' as const, issue:null }), inspect }
}
