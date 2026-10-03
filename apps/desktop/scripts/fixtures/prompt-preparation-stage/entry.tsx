import { flushSync } from 'react-dom'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { applyAppAppearance } from '../../../src/renderer/src/lib/app-appearance'

// Preview read-only facts remain finite. The input function is the actual production
// contextBridge/preload method, calling real Electron IPC and the owning Main handler.
const native = (window as any).agentmux
if (!native?.sessions?.submitPrompt) throw new Error('Actual production preload is required')
const errors: unknown[] = [], attempts: unknown[] = [], copies: unknown[] = []
api.sessions.submitPrompt = async (...args) => {
  attempts.push(structuredClone(args))
  try { await native.sessions.submitPrompt(...args) }
  catch (error) {
    const e = error as Error & { code?: string; detail?: string; controlFailure?: unknown }
    errors.push({ message: e.message, code: e.code, detail: e.detail, controlFailure: e.controlFailure })
    throw error
  }
}
api.ui.writeClipboardText = async text => { copies.push(text) }
// A source-qualified private transform removes only the old fixture's replacement
// of window.agentmux. The actual production bridge stays exposed and unmodified.
await import('../result-ready-input-continuity/entry')
const base = (window as any).resultReady
api.sessions.refresh = async control => {
  const found = useAppStore.getState().sessions.find(s => s.kind === 'agent' && s.hostId === control.hostId &&
    s.control.agentSessionId === control.agentSessionId && s.control.run.runId === control.run.runId)
  if (!found) throw new Error('Private read-only snapshot no longer has the original owner')
  return found
}
const bodies: Record<string, string> = {
  'phase-unknown': '原消息 · 准备阶段未完成，保留原身份和正文。',
  'lost-ack': '原消息 · 输入结果待核实，不得自动重放。',
  'boot-cause': '原历史消息 · 重启保留旧原因与未知投递条件。',
  'known-null': '原草稿消息 · 明确尚未调用输入，仍可编辑。'
}
const draft = '独立原草稿保持可编辑；邻区和终端仍可使用。'
const probe = {
  sessionId: base.sessionId, bodies,
  seed(scene: string, appearance: 'dark' | 'light') {
    if (!bodies[scene] || Object.keys(useAppStore.getState().agentSteerInFlight).length) throw new Error('Distinct finite phase scene required')
    base.seed('healthy'); applyAppAppearance(appearance); attempts.length = 0; errors.length = 0; copies.length = 0
    flushSync(() => useAppStore.setState(state => ({ agentSteerQueues: {}, timelines: {},
      sessions: state.sessions.map(s => s.kind === 'agent' ? { ...s, promptSubmissionPredecessor: null } : s),
      agentComposerDrafts: { ...state.agentComposerDrafts, [base.sessionId]: draft } })))
    useAppStore.getState().enqueueAgentSteer(base.sessionId, bodies[scene], undefined, undefined, 'manual')
    if (scene === 'boot-cause' || scene === 'known-null') flushSync(() => useAppStore.setState(state => ({
      agentSteerQueues: { [base.sessionId]: state.agentSteerQueues[base.sessionId]!.map(entry => {
        const { promptCondition: _old, ...original } = entry
        return { ...original, status: 'deferred', error: '原受控准备原因\nprivate original cause retained',
          errorCode: 'AGENT_PROMPT_PREPARATION_FAILED', ...(scene === 'known-null' ? { promptCondition: null } : {}) }
      }) }
    })))
  },
  async boot() {
    // Exercise the real initialization boot-policy projection on the existing
    // durable queue. This is a fixture rehydrate, not a Native process restart.
    flushSync(() => useAppStore.setState({ loading: true }))
    await useAppStore.getState().initialize()
  },
  facts() {
    const state = useAppStore.getState()
    return { attempts, errors, copies, queue: state.agentSteerQueues[base.sessionId] ?? [],
      draft: state.agentComposerDrafts[base.sessionId], inFlight: state.agentSteerInFlight,
      sessions: state.sessions.map(s => ({ id: s.id, control: s.control, status: s.status })),
      terminal: base.terminal(), gui: base.facts(), text: document.body.innerText }
  }
}
Object.assign(window, { preparationPhase: probe })
probe.seed('phase-unknown', 'dark')
