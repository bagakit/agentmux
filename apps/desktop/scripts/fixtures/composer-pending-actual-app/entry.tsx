import { flushSync } from 'react-dom'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
await import('../composer-pending-delivery/entry')
const pending = (window as any).pendingDelivery
const original = (window as any).resultReady
const names = ['检查原消息投递原因', '非首条也可以原位编辑', '可能已提交的原操作保持只读', '准备未完成，保留原意图', '保持每张卡的编号与动作', '最后一条仍然可以编辑']
Object.assign(window, { actualCards: {
  seed(theme: 'dark' | 'light', count = 6) {
    pending.seed(theme)
    for (let i = 0; i < count; i++) pending.queue(names[i % names.length] + (count > 6 ? ` ${i + 1}` : ''))
    if (count === 6) flushSync(() => useAppStore.setState(state => ({ agentSteerQueues: {
      [original.sessionId]: state.agentSteerQueues[original.sessionId]!.map((entry, index) => index === 2 ? {
        ...entry, status: 'deferred', error: 'Original input result is unknown', promptCondition: { expectedRun: { runId: entry.runId! }, afterSubmissionId: null }
      } : index === 3 ? { ...entry, status: 'deferred', promptCondition: null, errorCode: 'AGENT_PROMPT_PREPARATION_FAILED', error: 'This call did not attempt input.' } : entry)
    } })))
  },
  async footer() {
    const session = useAppStore.getState().sessions.find(s => s.id === original.sessionId)!
    // Controlled preview output to the production mounted TerminalView, not a
    // claim about a ctxmux Run or a real provider accepting user input.
    const col = Math.max(1, original.terminal().cols - 27)
    await api.sessions.write(session.control, `\x1b[2J\x1b[Horiginal input\x1b[999;1H\x1b[1A\x1b[${col}G5 warnings · open details\x1b[1B\x1b[1G`, 'user')
  },
  locked() {
    flushSync(() => useAppStore.setState(state => ({ agentSteerQueues: {
      [original.sessionId]: state.agentSteerQueues[original.sessionId]!.map(entry => ({ ...entry, status: 'deferred', error: 'Original outcome is unknown', promptCondition: { expectedRun: { runId: entry.runId! }, afterSubmissionId: null } }))
    } })))
  },
  rejectSave() {
    useAppStore.setState({ editQueuedAgentSteer: () => { throw new Error('Private original Save failed; keep this local edit draft and the same queue.') } })
  },
  facts: pending.facts
} })
