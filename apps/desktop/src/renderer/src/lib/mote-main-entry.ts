import { useCallback, useEffect, useRef, useState } from 'react'
import { parseMoteDialogueResult, type MoteDialogueRecoveryRequest } from '@agentmux/core/mote-dialogue'
import { useMoteDialogueView } from './mote-dialogue-view'
import type { MoteWorkfaceScope } from './mote-workface'
import { useAppStore } from '../store'
import { api } from './api'
import { agentSessionPresentationIndex } from './session-presentation'

type EntryState = { status:'idle'|'reading'|'recovering'|'unconfirmed'|'settled'; issue:string|null }
/** One explicit UI entry consumes the original Core owner. This token grants no Core authority. */
export function useMoteMainEntry({ scope, entryToken, active }: { scope:MoteWorkfaceScope|null; entryToken?:string|undefined; active:boolean }) {
  const dialogue = useMoteDialogueView(), main = dialogue?.page?.main, target = dialogue?.target
  const current = main?.current
  const session = useAppStore(state => {
    const matches = current ? agentSessionPresentationIndex(state.sessions).get(current.sessionId)?.filter(item =>
      item.control.hostId === current.hostId && item.control.agentSessionId === current.sessionId) : undefined
    return matches?.length === 1 ? matches[0] : undefined
  })
  const [state, setState] = useState<EntryState>({ status:'idle', issue:null })
  const retained = useRef<{ key:string; request:MoteDialogueRecoveryRequest } | null>(null)
  const key = active && scope && target && entryToken ? JSON.stringify([target,entryToken]) : null
  const latest = useRef(key); latest.current = key
  const admission = useRef<{ key:string; cancelled:boolean; started:boolean } | null>(null)
  useEffect(() => {
    if (!key) return
    if (admission.current?.key !== key) admission.current = { key, cancelled:false, started:false }
    const cancel = () => {
      const original = admission.current
      if (original?.key === key && !original.started) {
        original.cancelled = true
        setState({ status:'settled', issue:null })
      }
    }
    for (const event of ['pointerdown','keydown','input']) document.addEventListener(event,cancel,true)
    return () => { for (const event of ['pointerdown','keydown','input']) document.removeEventListener(event,cancel,true) }
  }, [key])
  const observe = useCallback(async (key:string, request:MoteDialogueRecoveryRequest, inspect:boolean) => {
    if (latest.current !== key || !inspect && admission.current?.cancelled) return
    setState({ status:'recovering', issue:null })
    try {
      // A lost ensure ACK or a second client first reads the exact original
      // deterministic key; only an authoritative absent receipt admits Start.
      let result = parseMoteDialogueResult('space.mote.dialogue.recovery.inspect', await api.moteDialogue.inspectRecovery(request), request)
      if (!inspect && !result.operation) {
        if (latest.current !== key || admission.current?.cancelled) return
        if (admission.current?.key === key) admission.current.started = true
        result = parseMoteDialogueResult('space.mote.dialogue.recovery.ensure', await api.moteDialogue.ensureRecovery(request), request)
      }
      const op = result.operation
      if (latest.current !== key) return
      if (op) retained.current = { key, request:{ ...request, ...op.moteMainEntry, expectedRun:op.previousRun, operationId:op.operationId } }
      const settled = op && (op.kind === 'resumed' || op.kind === 'reattachable')
      setState({ status:settled ? 'settled' : 'unconfirmed', issue:settled ? null : op
        ? `原恢复操作 ${op.operationId} 尚未确认（${op.reason}）；保留原对话，可核对同一操作。`
        : '原恢复操作尚未读到；保留原对话和输入，不重复启动。' })
      if (settled) await useAppStore.getState().refreshSession(request.reference.sessionId)
    } catch (error) {
      if (latest.current === key) setState({ status:'unconfirmed', issue:error instanceof Error ? error.message : String(error) })
    }
  }, [])
  useEffect(() => {
    if (!key) { setState({ status:'idle', issue:null }); return }
    if (!main || dialogue?.loading && !dialogue.page) {
      setState(dialogue?.issue ? { status:'unconfirmed', issue:dialogue.issue } : { status:'reading', issue:null }); return
    }
    if (main.status !== 'ready') { setState({ status:'unconfirmed', issue:main.issue ?? '原主角色尚未确认；保留原工作面。' }); return }
    if (!main.current || !main.roleRevision || !target) { setState({ status:'settled', issue:null }); return }
    if (retained.current?.key === key || admission.current?.cancelled) return
    if (session?.kind !== 'agent') { setState({ status:'unconfirmed', issue:'原主 Agent 的执行引用尚未读到；保留原对话与原工作面。' }); return }
    const source = { target, expectedRoleRevision:main.roleRevision, reference:main.current }, expectedRun = { ...session.control.run }
    const original = session.continuity
    if (original && original.previousRun.runId === expectedRun.runId && (original.kind === 'starting' ||
      ['runtime-unverified','provider-unverified','operation-unconfirmed','original-operation-unconfirmed'].includes(original.reason))) {
      const request = { ...source, ...original.moteMainEntry, expectedRun, operationId:original.operationId }
      retained.current = { key, request }; void observe(key,request,true); return
    }
    // The original continuity map owns this key across remounts and clients.
    const t = source.target, r = source.reference
    const frozen = JSON.stringify([t.spaceId,t.zoneId,t.expectedResource.hostId,t.expectedResource.workspaceId,t.expectedResource.workspacePath,
      source.expectedRoleRevision,r.hostId,r.sessionId,r.displayWorkspaceId,r.groupId,r.tabId,r.regionId,expectedRun.runId])
    retained.current = { key, request:{ ...source,expectedRun,operationId:'' } }
    void crypto.subtle.digest('SHA-256',new TextEncoder().encode(frozen)).then(hash => {
      if (latest.current !== key || admission.current?.cancelled) return
      const operationId = 'mote-entry-' + Array.from(new Uint8Array(hash),byte => byte.toString(16).padStart(2,'0')).join('')
      const request = { ...source,expectedRun,operationId }; retained.current = { key, request }
      void observe(key,request,false)
    }).catch(error => {
      if (latest.current === key) setState({ status:'unconfirmed', issue:error instanceof Error ? error.message : String(error) })
    })
  }, [key,main,dialogue?.loading,dialogue?.issue,session?.kind === 'agent' ? session.control.run.runId : null,target,observe])
  const inspect = useCallback(() => {
    const held = retained.current
    if (held?.request.operationId && held.key === latest.current) void observe(held.key,held.request,true)
  }, [observe])
  return { ...state, inspect }
}
