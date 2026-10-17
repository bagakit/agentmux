import { fixtureEpoch, fixtureIso } from '../../../../../test/fixture-values.mjs'

export const sessionId = 'conversation-review'
export const source = { providerId: 'codex', nativeSessionId: 'native-reading-review' }
export const reply = '**已完成对话记录检查。**\n\n保留每一份原记录，准确关联的来源共享主要正文。\n\n- 未关联快照保留原文、复制和详情。\n- 子 Agent 回报显示准确发送者与接收者。\n- 连续进度保留身份与时间，减少重复装饰。\n\n原 Session、输入草稿和阅读选区保持。'
export const draft = '保留这份尚未发送的回复草稿。'
const at = seconds => fixtureEpoch(1, seconds)
const message = (id, seconds, phase, text) => ({ timestamp: fixtureIso(seconds * 1000), type: 'response_item', payload: {
  id, type: 'message', role: 'assistant', phase, content: [{ type: 'output_text', text }], internal_chat_message_metadata_passthrough: { turn_id: 'original-review-turn' }
} })
const activity = (id, seconds, text) => ({ timestamp: fixtureIso(seconds * 1000), type: 'response_item', payload: { id, type: 'reasoning', summary: [{ type: 'summary_text', text }] } })
export function originalRows(cwd) {
  return [
    { type: 'session_meta', payload: { id: source.nativeSessionId, cwd } },
    { type: 'turn_context', payload: { turn_id: 'original-review-turn' } },
    message('progress-one', 1, 'commentary', '已确认重复来自原生回答与独立观察，正在核对原记录边界。'),
    activity('before-observation', 2, '核对原记录身份与来源。'),
    activity('after-observation', 4, '确认观察入口不切断相邻执行过程。'),
    message('progress-two', 5, 'commentary', '来源核对完成，开始收紧连续进度与快照入口。'),
    { timestamp: fixtureIso(6000), type: 'response_item', payload: { type: 'agent_message', id: 'collaboration-report',
      author: '/root/reviewer', recipient: '/root', content: [{ type: 'input_text', text: '独立评审：原文与身份边界保持，未知来源未被推断为新发言。' }],
      internal_chat_message_metadata_passthrough: { turn_id: 'original-review-turn' } } },
    message('final-reply', 8, 'final_answer', reply)
  ]
}
export const appendedRow = message('later-progress', 10, 'commentary', '追加原记录后，已经打开的原文和选区仍保持。')
export const snapshots = [{ id: 'reply-observation', agentSessionId: sessionId, kind: 'assistant_message', source: 'native-hook', eventName: 'Stop',
  title: 'Recorded reply', status: 'complete', content: reply, createdAt: at(3), updatedAt: at(3) }]
