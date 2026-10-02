import { flushSync } from 'react-dom'
import type { AgentMuxPermissionRequest } from '@agentmux/core'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
await import('../mailbox-message-navigation/entry')
const navigation = (window as any).mailboxNavigation, base = (window as any).resultReady
// The old scene seeds a checkpoint without the current public restoration geometry.
// This bounded preview adapter supplies its known 80x24 origin, not a live Runtime claim.
const attach = api.sessions.attach
api.sessions.attach = async (...args) => {
  const snapshot = await attach(...args)
  return { ...snapshot, terminal: snapshot.terminal.type !== 'basic-vt' ? snapshot.terminal : {
    ...snapshot.terminal, restoreBytes: new TextEncoder().encode('\x1b[0m'), checkpoint: {
      ...snapshot.terminal.checkpoint, restoreSize: snapshot.terminal.checkpoint.size,
      restoreScrollbackRows: 0, resizeAfterRestoreBytes: 0
    }
  } }
}
let releasePreparation: (() => void) | undefined
let releaseSubmission: (() => void) | undefined
let rejectSubmission: ((error: Error) => void) | undefined
let attempts: unknown[] = []
let copies: string[] = []
api.ui.writeClipboardText = async text => { copies.push(text) }
api.sessions.refresh = async control => {
  await new Promise<void>(resolve => { releasePreparation = resolve })
  return structuredClone(useAppStore.getState().sessions.find(s => s.id === control.agentSessionId)!)
}
api.sessions.submitPrompt = async (...args) => {
  attempts.push(args)
  await new Promise<void>((resolve, reject) => { releaseSubmission = resolve; rejectSubmission = reject })
}
api.continuousProgress.list = async () => []
const probe = {
  seed(appearance: 'dark' | 'light') {
    if (Object.keys(useAppStore.getState().agentSteerInFlight).length) throw Error('Finish the original private attempt before reseeding')
    navigation.seed(appearance, 'Original draft stays editable')
    attempts=[];copies=[];releasePreparation=undefined;releaseSubmission=undefined;rejectSubmission=undefined
    flushSync(() => useAppStore.setState(state => ({agentSteerQueues:{},agentSteerInFlight:{},agentSteerInFlightPhase:{},
      timelines:{},sessions:state.sessions.map(s => s.id === base.sessionId ? {...s,promptSubmissionPredecessor:null} : s)})))
  },
  queue() { flushSync(() => useAppStore.getState().enqueueAgentSteer(base.sessionId,'Review the mailbox design and keep the original message identity',undefined,undefined,'manual')) },
  prepared() { if(!releasePreparation)throw Error('No actual preparation'); const release=releasePreparation;releasePreparation=undefined;release() },
  submitted(fail = false) { if(!releaseSubmission)throw Error('No actual submission'); const release=releaseSubmission,reject=rejectSubmission;releaseSubmission=undefined;rejectSubmission=undefined;fail?reject!(new Error('Delivery result unknown')):release() },
  interaction(value: boolean) { flushSync(() => useAppStore.setState(state => ({sessions:state.sessions.map(s => s.id===base.sessionId?{...s,pendingInteraction:value?{id:'private-request',kind:'permission',agentSessionId:s.id,title:'Original request',options:[{id:'allow',label:'Allow once',kind:'allow_once'}],evidence:{source:'native-hook',observedAt:1,run:s.control.run}} satisfies AgentMuxPermissionRequest:undefined}:s)}))) },
  unknown() { flushSync(() => useAppStore.setState(state => ({agentSteerQueues:{[base.sessionId]:state.agentSteerQueues[base.sessionId]!.map(e => ({...e,status:'deferred',error:'Delivery result unknown',promptCondition:{expectedRun:{runId:e.runId!},afterSubmissionId:null}}))}}))) },
  clear() { if(Object.keys(useAppStore.getState().agentSteerInFlight).length)throw Error('Cannot discard an in-flight operation');flushSync(() => useAppStore.setState({agentSteerQueues:{}})) },
  facts() { const state=useAppStore.getState();return{...base.facts(),queues:state.agentSteerQueues,inFlight:state.agentSteerInFlight,phase:state.agentSteerInFlightPhase,attempts,copies} },
  terminal:base.terminal
}
Object.assign(window,{pendingDelivery:probe})
probe.seed('dark')
