import '../focus-context-recap-menu/entry.mjs'
import { useAppStore } from '../../../src/renderer/src/store'
import { createFocusProjectionSelector } from '../../../src/renderer/src/lib/focus-context'

// Reuse the maintained typed recap transport and actual Global/Row/menu/error
// scene. Extend only seed facts; no component, Store action or identity owner
// is replaced here. The separate compact occurrence is kept for density review.
const seed = window.recapProof
const longName = '同名 Agent · 保持原会话与连续阅读 · 检查泳道卡片、完整预览和精确 Session 的操作归属'
const paragraph = '保留正在阅读的内容、原草稿和选区。预览只展示已有事实；鼠标可以自然移入，选择文字，并在内部继续向下阅读。'
const longResponse = (seed.response + paragraph.repeat(14)).slice(0, 735) + ' 阅读末尾：原会话与事实保持完整。'
useAppStore.setState(state => ({
  agentNames: { ...state.agentNames, 'recap-a': longName, 'recap-b': longName },
  timelines: { ...state.timelines, 'recap-a': {
    ...state.timelines['recap-a'],
    items: state.timelines['recap-a'].items.map(item => item.id === 'response' ? { ...item, content: longResponse } : item)
  } }
}))
const original = useAppStore.getState(), select = createFocusProjectionSelector()
const initialIds = original.sessions.map(session => ({ id: session.id, runId: session.control.run.runId }))
window.cardInteractionScene = {
  ready: true, longName, longResponse, expectedSecondAddress: seed.expectedSecondAddress,
  derivedSecondName: original.sessions.find(session => session.id === 'recap-b').label,
  remember: () => seed.remember(), churn: () => seed.churn(),
  facts() {
    const state = useAppStore.getState()
    return { ...seed.facts(), names: { ...state.agentNames }, selectedId: state.agentFocus.execution.sessionId,
      sessionRefsPreserved: state.sessions.length === original.sessions.length && state.sessions.every((session, index) => session === original.sessions[index]),
      timelineRefsPreserved: state.timelines === original.timelines,
      draftOwnerPreserved: state.agentComposerDrafts === original.agentComposerDrafts,
      focusOwnerPreserved: state.agentFocus === original.agentFocus,
      identityFacts: state.sessions.map(session => ({ id: session.id, runId: session.control.run.runId })), initialIds,
      currentNames: Object.fromEntries(select(state).contexts.map(context => [context.id, context.name])) }
  }
}
