import { fixtureTime } from '../../lib/fixture-values.mjs'

/** One source inventory for both the DOM consumer and private Chromium process. */
export const readingSessionId = 'mote-reading-main'
export const readingNativeId = 'mote-reading-original-native'
export const readingRunId = 'mote-reading-original-run'
export const readingDraft = 'Original unsent Mote reading draft'
export function readingRecord(index: number) {
  const role = index % 2 ? 'assistant' : 'user'
  return { uuid: `reading-original-${index}`, type: role, sessionId: readingNativeId,
    timestamp: new Date(fixtureTime(index * 1000)).toISOString(), message: { role,
      content: role === 'user' ? `Original Mote input ${index}` : [
        { type: 'thinking', thinking: `Original Mote thought ${index}` },
        { type: 'text', text: `Original Mote reply ${index}. This exact source record remains readable across hiding and showing the same conversation.` }
      ] } }
}
export const readingLines = (from: number, count: number) => Array.from({ length: count }, (_, n) => JSON.stringify(readingRecord(from + n))).join('\n') + '\n'
