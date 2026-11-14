import { useEffect, useMemo, useRef, useState } from 'react'
import { AgentComposer } from '@agentmux/client-ui/components/AgentComposer'
import { projectInputReceipt } from '@agentmux/client-ui/input-receipt-projection'
import type { AgentInputSubmissionReceipt } from '@agentmux/core'
import type { RuntimeEvent, SessionSnapshot } from '../../../shared/contracts'
import type { SpaceMountMemberTarget, SpaceMountMemberSurface, SpaceMountRecord } from '../../../shared/space-mount'
import { api } from '../lib/api'
import { originalInputExplanation } from '../lib/original-input-presentation'
import { initialNativeComposerBinding } from '../lib/initial-native-composer-binding'
import { editMountedMemberInput, mountedMemberInputScope, mountedMemberDraft, mountedMemberRequestBuckets, mountedMemberMessages, sameMountedMemberInput, type MountedMemberInput } from '../lib/space-member-input'
import { checkpointMountedSpaceInputs, useAppStore } from '../store'
import { editMountedSpaceDraftInput } from '../lib/space-mount-view'

/** Private user intent and original receipts only; Core still owns dispatch, waiting and completion. */
export function MountedSpaceComposer({ target, surface, subscribe, session, mountKey, tabId, active, privateInput }: {
  target: SpaceMountMemberTarget; surface?: SpaceMountMemberSurface | undefined;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
  session?: SessionSnapshot; mountKey: string; tabId: string; active: boolean; privateInput?: SpaceMountRecord | undefined
}) {
  const scope = mountedMemberInputScope(target), targetKey = JSON.stringify([scope,target.target.expectedRun.runId])
  const live = useRef({ scope, targetKey, mounted: true }); live.current.scope = scope; live.current.targetKey = targetKey
  const revision = useRef(0), preparing = useRef<symbol | null>(null)
  const raw = useAppStore(state => {
    try { return mountedMemberRequestBuckets(state.mountedSpaceInputs,mountKey,target,privateInput) } catch { return undefined }
  })
  const savedDraft = useAppStore(state => {
    try { return mountedMemberDraft(state.mountedSpaceInputs,mountKey,tabId,target,privateInput) } catch { return '' }
  })
  const [buffer,setBuffer] = useState({ key:targetKey,text:savedDraft }), [issue,setIssue] = useState<string>(), [busy,setBusy] = useState(false)
  const receipts = useRef<Record<string,AgentInputSubmissionReceipt>>({})
  const [confirmed,setConfirmed] = useState<Record<string,AgentInputSubmissionReceipt>>({})
  const text = buffer.key === targetKey ? buffer.text : savedDraft
  const rows = useMemo(() => mountedMemberMessages(raw??{},target),[raw,scope])
  useEffect(() => { live.current.mounted = true; return () => { live.current.mounted = false } },[])
  function retain(input: MountedMemberInput, update: (current:MountedMemberInput)=>MountedMemberInput) {
    useAppStore.setState(state => ({mountedSpaceInputs:editMountedMemberInput(state.mountedSpaceInputs,mountKey,input.target,input.request.operationId,
      current => current && !sameMountedMemberInput(current,input) ? current : update(current ?? input),privateInput)}))
  }
  function observe(receipt:AgentInputSubmissionReceipt, original?:MountedMemberInput) {
    const key=receipt.key
    if(key.kind!=='prompt'||key.agentSessionId!==target.target.agentSessionId)return
    const candidates=original?[original]:mountedMemberMessages(mountedMemberRequestBuckets(useAppStore.getState().mountedSpaceInputs,mountKey,target,privateInput),target)
      .flatMap(row=>row.input&&row.input.request.operationId===key.submissionId&&row.input.target.target.expectedRun.runId===key.expectedRun.runId?[row.input]:[])
    // Ambiguous retained carriers never choose a first request; each can be explicitly checked.
    if(candidates.length!==1)return
    const input=candidates[0]!
    if(input.request.operationId!==key.submissionId||input.target.target.expectedRun.runId!==key.expectedRun.runId)return
    const receiptKey=JSON.stringify([mountedMemberInputScope(input.target),input.request.operationId,input.target.target.expectedRun.runId])
    const next=projectInputReceipt(receipts.current[receiptKey],receipt)
    receipts.current[receiptKey]=next
    retain(input,value=>({...value,submitted:true,response:next,issue:undefined}))
    if(live.current.mounted&&live.current.scope===scope)setConfirmed(prior=>({...prior,[receiptKey]:next}))
  }
  useEffect(()=>subscribe(event=>{if(event.event.type==='agent-input')try{observe(event.event.receipt)}catch(cause){setIssue(cause instanceof Error?cause.message:String(cause))}}),[subscribe,scope])
  function change(value:string) {
    ++revision.current;setBuffer({key:targetKey,text:value})
    try{if(privateInput)useAppStore.setState(state=>({mountedSpaceInputs:editMountedSpaceDraftInput(state.mountedSpaceInputs,mountKey,tabId,target.target.regionId,value,undefined,privateInput)}));else useAppStore.getState().editSpaceMountDraft(mountKey,tabId,target.target.regionId,value)}catch(cause){setIssue(cause instanceof Error?cause.message:String(cause))}
  }
  async function send(input?:MountedMemberInput) {
    if(preparing.current)return
    if(!input&&!text.trim())return
    const original:MountedMemberInput=input??{target,request:{operationId:crypto.randomUUID(),prompt:text,binding:session?.kind==='agent'?initialNativeComposerBinding(session)??{expectedRun:target.target.expectedRun,admissionIntent:{kind:'manual-actor' as const}}:{expectedRun:target.target.expectedRun,admissionIntent:{kind:'manual-actor' as const}}},submitted:false}
    const fieldRevision=revision.current,producer=Symbol('original-input-checkpoint');preparing.current=producer;setBusy(true);setIssue(undefined)
    const releasePreparation=()=>{if(preparing.current===producer){preparing.current=null;if(live.current.mounted)setBusy(false)}}
    let ownSurface:SpaceMountMemberSurface|undefined
    try {
      retain(original,current=>({...current,submitted:true,issue:undefined}))
      try{await checkpointMountedSpaceInputs()}catch(cause){retain(original,current=>({...current,submitted:false,issue:cause instanceof Error?cause.message:String(cause)}));throw cause}
      // Moving confirmed local intent out of the editor is not a delivery ACK. Its full original request is retained below.
      if(!input&&live.current.mounted&&live.current.targetKey===targetKey&&revision.current===fieldRevision)change('')
      // A retained unsent message keeps its original Run even after the visible member changes.
      const producerSurface=input||!surface?await api.spaceMounts.member(original.target,()=>{}):surface
      if(producerSurface!==surface)ownSurface=producerSurface
      const pending=producerSurface.call('submitPrompt',original.request)
      releasePreparation()
      try {
        const reply=await pending
        if(reply&&'key'in reply&&'status'in reply)observe(reply,original)
        else retain(original,current=>({...current,response:reply}))
      }catch(cause){retain(original,current=>({...current,issue:cause instanceof Error?cause.message:String(cause)}))}
    }catch(cause){if(live.current.mounted&&live.current.scope===scope)setIssue(cause instanceof Error?cause.message:String(cause))}
    finally{releasePreparation();if(ownSurface)void Promise.resolve(ownSurface.dispose()).catch(cause=>console.warn('[mounted-space] Input reader release unconfirmed',cause))}
  }
  async function inspect(input:MountedMemberInput) {
    let original:SpaceMountMemberSurface|undefined
    try {
      // Old Run inputs keep their original target. No create, continue, new input or route substitution.
      original=await api.spaceMounts.member(input.target,()=>{})
      const receipt=await original.call('inspectInput',{key:{kind:'prompt',agentSessionId:input.target.target.agentSessionId,expectedRun:input.target.target.expectedRun,submissionId:input.request.operationId}})
      if(receipt)observe(receipt,input)
      else retain(input,current=>({...current,issue:'The original input is not returned by this observation. Its outcome remains unconfirmed; it was not sent again.'}))
    }catch(cause){retain(input,current=>({...current,issue:cause instanceof Error?cause.message:String(cause)}))}
    finally{if(original)void Promise.resolve(original.dispose()).catch(cause=>console.warn('[mounted-space] Input reader release unconfirmed',cause))}
  }
  return <div className="mounted-space-agent__composer">
    <AgentComposer active={active} value={text} onChange={change} disabled={false} placeholder="Message this original Agent…" tools={()=>null}
      {...(!busy?{onSubmit:()=>void send()}:{} )} submitLabel="Send new message" />
    {issue||!raw?<p role="status">{issue??'Saved input is unreadable. Its original data is retained.'}</p>:null}
    {busy?<p role="status">Saving this outgoing message before sending…</p>:null}
    {rows.length?<details className="mounted-space-agent__inputs"><summary>Original messages · {rows.length}</summary><ul>{rows.map(({id,input})=>{
      const receipt=input?confirmed[JSON.stringify([mountedMemberInputScope(input.target),input.request.operationId,input.target.target.expectedRun.runId])]:undefined
      const explanation=input&&!input.submitted?{title:'Unsent input',detail:'The original request is kept in this workface. Sending has not started.'}:originalInputExplanation(receipt?.status??'unknown',receipt?.control.waiting)
      return <li key={id}><strong>{input?explanation.title:'Original input unreadable'}</strong><p>{input?explanation.detail:'Original bytes are retained.'}</p>
        {input?<><pre>{input.request.prompt}</pre>{input.issue?<p role="status">{input.issue}</p>:null}
          {!input.submitted?<button type="button" className="small-button" onClick={()=>void send(input)}>Send original message</button>:null}
          <button type="button" className="small-button" onClick={()=>void inspect(input)}>Check original input</button>
          <details><summary>Original request</summary><pre>{JSON.stringify(input,null,2)}</pre></details></>:<code>{id}</code>}</li>
    })}</ul></details>:null}
  </div>
}
