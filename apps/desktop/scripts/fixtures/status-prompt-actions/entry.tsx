import '../result-ready-input-continuity/entry'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel'
import { useAppStore } from '../../../src/renderer/src/store'
import { applyAppAppearance } from '../../../src/renderer/src/lib/app-appearance'
import { api } from '../../../src/renderer/src/lib/api'
import { COMPOSER_PROMPT_STATES } from '../../../src/shared/composer-shortcut-library'
import type { ComposerShortcut } from '../../../src/shared/contracts'
import type { AgentDisplayState, AgentMuxInteractionRequest, AgentMuxInteractionResponse } from '@agentmux/core'

// Reuse the ordered-byte/basic-vt scene: real workbench/pane/xterm/input/CSS, private API facts only.
const base = (window as any).resultReady
const longBody = '大白话说清楚\n1. 目标与现状：哪些事实已经确认，哪些仍未确认。\n2. 完成的内容：逐项说明实际改动与可见结果。\n3. 质量与品位：给出验证、取舍与仍需改善的细节。\n4. 接下来工作的价值和重点：先解决影响使用的真实问题。\n5. 保留当前 Session、Run、长草稿和终端阅读位置。\n6. 不把状态未知当作空闲，也不把回合结束当作目标完成。\n  原样保留这行缩进与中文标点。\n最后一行：确认这些边界以后，继续推进下一步。'
const prompts: ComposerShortcut[] = COMPOSER_PROMPT_STATES.map((state) => ({ id: state, keyword: state,
  label: state === 'done' ? '大白话说说做了什么' : `Explain ${state}`, body: `Configured ${state} prompt\n  exact spacing`, states: [state] }))
prompts.push(...Array.from({ length: 7 }, (_, index) => ({ id: `extra-${index}`, keyword: `extra-${index}`,
  label: index === 6 ? '大白话说清楚目标与现状、完成内容质量品位，以及接下来工作的价值和重点' : `继续优化 ${index + 1}`,
  body: index === 6 ? longBody : `User next step ${index + 1}`, states: ['done' as const] })))
const submissions: unknown[] = [], responses: unknown[] = [], saved: unknown[] = []
api.sessions.submitPrompt = async (control, text) => { submissions.push({ control, text }) }
api.sessions.refresh = async (control) => {
  const session = useAppStore.getState().sessions.find((session) => session.id === control.agentSessionId)
  if (!session) throw new Error('The original Session must still exist')
  return session
}
api.sessions.respondInteraction = async (control, response) => {
  responses.push({ control, response })
  flushSync(() => useAppStore.setState((state) => ({ sessions: state.sessions.map((session) => {
    if (session.id !== control.agentSessionId || session.kind !== 'agent') return session
    const { pendingInteraction: _answered, ...rest } = session
    return rest
  }) })))
}
api.config.save = async (config, expected) => {
  saved.push({ config, expected })
  flushSync(() => useAppStore.setState({ config: structuredClone(config) }))
}
const settingsHost = document.createElement('div')
settingsHost.style.cssText = 'position:fixed;inset:0;z-index:1000;display:none'
document.body.append(settingsHost)
let settingsRoot: Root | null = null
function closeSettings() { flushSync(() => settingsRoot?.unmount()); settingsRoot = null; settingsHost.style.display = 'none' }
const probe = {
  states: COMPOSER_PROMPT_STATES, prompts, sessionId: base.sessionId,
  seed(configured = true) {
    base.seed()
    flushSync(() => useAppStore.setState((state) => ({ config: { ...state.config!, composerShortcuts: configured ? structuredClone(prompts) : [] },
      agentSteerQueues: {}, agentSteerInFlight: {} })))
  },
  lowerRegion() {
    flushSync(() => useAppStore.setState((state) => {
      const tab = state.tabs[base.tabId]!, layout = tab.layout.root
      if (layout.type !== 'split') throw new Error('Expected two real Regions')
      return { tabs: { ...state.tabs, [tab.id]: { ...tab, layout: { ...tab.layout, root: { ...layout, direction: 'vertical', first: layout.second, second: layout.first } } } } }
    }))
  },
  draft(text: string) { flushSync(() => useAppStore.getState().setAgentComposerDraft(base.sessionId, text)) },
  appearance(mode: 'dark' | 'light') { applyAppAppearance(mode) },
  state(display: AgentDisplayState) {
    // Display-state transitions are controlled observations, not a claim that this private CLI exited.
    flushSync(() => useAppStore.setState((state) => ({ sessions: state.sessions.map((session) => session.id === base.sessionId
      ? { ...session, status: { state: display, source: 'native-hook' as const, observedAt: Date.now() } } : session) })))
  },
  pending(kind: 'permission' | 'question') {
    const session = useAppStore.getState().sessions.find((session) => session.id === base.sessionId)!
    const evidence = { source: 'native-hook' as const, observedAt: Date.now(), run: session.control.run }
    const request: AgentMuxInteractionRequest = kind === 'permission'
      ? { kind, id: 'private-request', agentSessionId: base.sessionId, title: 'Allow?', options: [{ id: 'allow', label: 'Allow', kind: 'allow-once' }], evidence }
      : { kind, id: 'private-request', agentSessionId: base.sessionId, questions: [{ id: 'q', prompt: 'Which?', options: [{ id: 'choice', label: 'Choice' }] }], evidence }
    flushSync(() => useAppStore.setState((state) => ({ sessions: state.sessions.map((current) => current.id === session.id && current.kind === 'agent'
      ? { ...current, pendingInteraction: request } : current) })))
  },
  async answer(kind: 'permission' | 'question') {
    const response: AgentMuxInteractionResponse = kind === 'permission'
      ? { kind, requestId: 'private-request', decision: { outcome: 'selected', optionId: 'allow' } }
      : { kind, requestId: 'private-request', outcome: 'answered', answers: [{ questionId: 'q', optionId: 'choice' }] }
    await useAppStore.getState().respondInteraction(base.sessionId, response)
  },
  async drain() { await useAppStore.getState().flushAgentSteerQueue(base.sessionId) },
  settings() {
    settingsHost.style.display = 'block'; settingsRoot = createRoot(settingsHost)
    flushSync(() => settingsRoot!.render(<SettingsPanel initialSection="prompts" onClose={closeSettings} />))
  },
  closeSettings,
  facts() {
    const state = useAppStore.getState()
    return { ...base.facts(), config: state.config, submissions, responses, saved, queues: state.agentSteerQueues,
      pending: state.sessions.find((session) => session.id === base.sessionId)?.kind === 'agent'
        ? (state.sessions.find((session) => session.id === base.sessionId) as any).pendingInteraction : null }
  }
}
Object.assign(window, { statusPromptActions: probe })
probe.seed(false)
