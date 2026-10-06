import { createRoot } from 'react-dom/client'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { AgentSessionComposer } from '../../../src/renderer/src/components/AgentSessionComposer'
import { GlobalSystemNotices } from '../../../src/renderer/src/components/GlobalSystemNotices'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import '../../../src/renderer/src/styles/index.css'

let disposeStartup: (() => void) | undefined
const root = createRoot(document.querySelector('#composer')!)
const noticeRoot = createRoot(document.querySelector('#notices')!)
const observedErrors: any[] = []
const reportOriginalError = useAppStore.getState().reportError
useAppStore.setState({ reportError(error: any, context: any) {
  observedErrors.push({ name: error.name, code: error.code, message: error.message, context })
  reportOriginalError(error, context)
} })
Object.assign(window, { waitProof: {
  async setup(config: unknown, session: any) {
    disposeStartup = await useAppStore.getState().initialize()
    useAppStore.setState({ config, sessions: [session], loading: false, agentSteerQueues: {}, agentSteerInFlight: {}, agentSteerInFlightPhase: {} } as never)
    root.render(<DesktopClientUiProvider><AgentSessionComposer sessionId={session.id} /></DesktopClientUiProvider>)
    noticeRoot.render(<GlobalSystemNotices />)
  },
  draft(sid: string, body: string) { useAppStore.getState().setAgentComposerDraft(sid, body) },
  entries(sid: string) { return structuredClone(useAppStore.getState().agentSteerQueues[sid] ?? []) },
  ownership(sid: string) { return { inFlight: useAppStore.getState().agentSteerInFlight[sid], phase: useAppStore.getState().agentSteerInFlightPhase[sid] } },
  fresh(sid: string, body: string) { return useAppStore.getState().send(sid, body, undefined, 'manual') },
  async pending(sid: string) { return await useAppStore.getState().executeControl({ operation: 'message.pending.ls', agentSessionId: sid } as never) },
  project(receipt: any) { useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: { type: 'agent-input', receipt } }) },
  issue() { return { observed: structuredClone(observedErrors.at(-1)), error: useAppStore.getState().error, context: structuredClone(useAppStore.getState().errorNoticeContext) } },
  retainEntry(sid: string, entry: any) { useAppStore.setState(state => ({ agentSteerQueues: { ...state.agentSteerQueues, [sid]: [...(state.agentSteerQueues[sid] ?? []), entry] } })) },
  projectSession(session: any) { useAppStore.setState(state => ({ sessions: state.sessions.map(item => item.id === session.id ? session : item) })) },
  async failure(method: 'inspect' | 'stop' | 'rejoin', control: any, ref: any) {
    try {
      if (method === 'inspect') await api.sessions.inspectInput(control, ref.key)
      else if (method === 'stop') await api.sessions.stopInputWaiting(control, ref, 'private-error-stop')
      else await api.sessions.rejoinInputWaiting(control, ref)
      return { fulfilled: true }
    } catch (error: any) { return { fulfilled: false, error: { name: error.name, message: error.message, code: error.code,
      detail: error.detail, controlFailure: error.controlFailure, logId: error.logId, cause: error.cause } } }
  },
  sendStored(sid: string, operationId: string) { return useAppStore.getState().sendQueuedAgentSteer(sid, operationId) },
  stop(sid: string, operationId: string) { return useAppStore.getState().cancelAgentSteerPreparation(sid, operationId) },
  exactControl(request: any) { return useAppStore.getState().executeControl(request) },
  raw(control: any) { return api.sessions.write(control, 'original raw bytes', 'user') },
  dispose() { root.unmount(); noticeRoot.unmount(); disposeStartup?.() }
} })
