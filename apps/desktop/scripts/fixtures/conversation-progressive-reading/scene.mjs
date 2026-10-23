import { fixtureIso } from '../../../../../test/fixture-values.mjs'

export const surfacePending = '这条本地意图尚未发送，须由用户明确继续。'
export const draft = '保留这份尚未发送的阅读反馈。'
export const integrityCode = 'integrity deferred original'
export const sceneNames = ['dense', 'longbody', 'surfaces', 'integrity']
const record = (id, turn, payload) => ({ timestamp: fixtureIso(turn * 1000), type: 'response_item',
  payload: { id, ...payload, internal_chat_message_metadata_passthrough: { turn_id: `reading-turn-${turn}` } } })
const message = (id, turn, role, text) => record(id, turn, { type: 'message', role,
  ...(role === 'assistant' ? { phase: 'final_answer' } : {}), content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] })
const longText = turn => `## 阅读结论 ${turn}\n\n` + Array.from({ length: 64 }, (_, paragraph) =>
  `段落 ${paragraph + 1}。正文在原来的记录内逐步呈现。连续回翻时，已经阅读的节点、选区和原始来源必须保留。`).join('\n\n')

/** Controlled Provider-format input, not output attributed to a vendor model. */
export function sceneRows(scene) {
  if (!sceneNames.includes(scene)) throw new Error('Unknown reading scene')
  const rows = []
  for (let turn = 1; turn <= 96; turn++) {
    rows.push({ type: 'turn_context', ordinal: 1000 + turn * 2, payload: { turn_id: `reading-turn-${turn}` } })
    rows.push(message(`${scene}-question-${turn}`, turn, 'user', `阅读问题 ${turn}：核对原记录、阅读锚点与未发送草稿。`))
    for (let step = 0; step < (scene === 'dense' ? 16 : 2); step++) rows.push(record(`${scene}-step-${turn}-${step}`, turn, {
      type: 'reasoning', summary: [{ type: 'summary_text', text: `过程 ${turn}.${step}：读取准确原记录并保留来源。` }] }))
    const text = scene === 'dense' ? `阅读结论 ${turn}：原记录保持完整，过程可展开。`
      : longText(turn) + (scene === 'integrity' ? '\n\n```text\n' + integrityCode + '\n```' : '')
    rows.push(message(`${scene}-answer-${turn}`, turn, 'assistant', text))
    rows.push({ type: 'event_msg', ordinal: 1001 + turn * 2, payload: { type: 'task_complete', turn_id: `reading-turn-${turn}` } })
  }
  return rows
}

export function appendRow(scene, suffix = 'desktop') {
  return message(`${scene}-${suffix}-appended-answer`, 97, 'assistant', scene === 'longbody' ? longText(97) : '追加结论：当前阅读锚点和原选区保持；原 Session 与未发送草稿没有改变。')
}
