import base from '../scripts/fixtures/conversation-latest-auto/vitest.owning.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
const mutation = process.env.AGENTMUX_CHRONOLOGY_MUTATION
const replacements: Record<string, [string, string, string]> = {
  'stack-inputs': ['ActivityView.tsx', 'const beforeRecordId = nativePage?.items[nativeIndex]?.id', 'const beforeRecordId = undefined'],
  'swallow-input': ['conversation-record-sequence.ts', 'if (interruptions?.has(item.id)) flush()', 'if (false) flush()'],
  'captured-range': ['ActivityView.tsx', 'const holdCapturedLayout = committedLayout.current.source === layoutSource', 'const holdCapturedLayout = false && committedLayout.current.source === layoutSource'],
  'native-range': ['ConversationRecordSequence.tsx', 'if (held) {', 'if (held && false) {'],
  'forget-disclosure': ['ConversationRecordSequence.tsx', 'const choices = disclosure.source === sourceKey ? disclosure :', 'const choices = false ? disclosure :']
}
export default defineConfig({ ...base, cacheDir: '.cache/conversation-chronological-reading',
  plugins: [{ name: 'chronology-source-counterexample', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!
    if (!['ActivityView.tsx', 'ConversationRecordSequence.tsx', 'conversation-record-sequence.ts'].some(name => file.endsWith('/' + name))) return
    const replacement = mutation ? replacements[mutation] : undefined
    let code = source
    if (replacement && file.endsWith('/' + replacement[0])) {
      if (source.split(replacement[1]).length !== 2) throw Error('Non-unique chronology mutation: ' + mutation)
      code = source.replace(replacement[1], replacement[2])
    }
    const loaded = process.env.AGENTMUX_CHRONOLOGY_LOADED
    if (loaded) appendFileSync(loaded, JSON.stringify({ path: relative(process.cwd(), file), originalSHA256: createHash('sha256').update(source).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'), ...(code !== source ? { mutation } : {}) }) + '\n')
    return code === source ? undefined : { code, map: null }
  } }, ...base.plugins!],
  test: { ...base.test, include: ['apps/desktop/test/conversation-chronological-reading.test.tsx'] } })
