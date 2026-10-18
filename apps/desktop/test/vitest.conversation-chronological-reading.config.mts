import base from '../scripts/fixtures/conversation-latest-auto/vitest.owning.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
const mutation = process.env.AGENTMUX_CHRONOLOGY_MUTATION
const replacements: Record<string, [string, string, string]> = {
  'stack-inputs': ['conversation-record-sequence.ts', 'for (const record of records) {', "for (const record of [...records.filter(record => record.original.kind === 'native'), ...records.filter(record => record.original.kind === 'captured')]) {"],
  'swallow-input': ['conversation-record-sequence.ts', 'else { flush(); rows.push({ kind:', "else { if (record.original.kind === 'captured' && process.length) continue; flush(); rows.push({ kind:"],
  'change-selected-parent': ['use-conversation-record-layout.ts', 'prior.parent === next.parent', 'true'],
  'forget-disclosure': ['ConversationRecordSequence.tsx', 'const choices = disclosure.source === sourceKey ? disclosure :', 'const choices = false ? disclosure :']
}
export default defineConfig({ ...base, cacheDir: '.cache/conversation-chronological-reading',
  plugins: [{ name: 'chronology-source-counterexample', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!
    if (!['ConversationRecordSequence.tsx', 'conversation-record-sequence.ts', 'use-conversation-record-layout.ts'].some(name => file.endsWith('/' + name))) return
    const replacement = mutation ? replacements[mutation] : undefined
    if (mutation && !replacement) throw Error('Unknown chronology mutation: ' + mutation)
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
