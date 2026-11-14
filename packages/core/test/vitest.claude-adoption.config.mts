import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import nativeInput from './vitest.native-input.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const mutants: Record<string, [string, string, string]> = {
  'wrong-queue-field': ['packages/providers/dist/claude/native-history.js', 'attachment?.source_uuid', 'attachment?.delivery_id'],
  'queue-as-turn': ['packages/providers/dist/claude/native-history.js', 'queuedSubmissionId: correlation, clientCorrelation: correlation', 'turnId: correlation, clientCorrelation: correlation'],
  'edited-body-adopted': ['packages/core/dist/native-input-adoption.js', '|| !frozenContent', '|| false'],
  'native-peer-becomes-primary-speech': ['packages/core/dist/conversation-stream.js', 'if (key)\n            return records.find', 'if (false)\n            return records.find'],
  'adapter-loses-original-input': ['packages/core/dist/conversation.js', 'const record = conversationEventPrimary(event.recordIds.map(id => records.get(id)), event.anchorId)',
    "const record = records.get(event.anchorId) ?? records.get(event.content[0]?.recordId ?? '') ?? records.get(event.recordIds[0])"]
}
const selected = process.env.AGENTMUX_CLAUDE_ADOPTION_MUTATION
if (selected && !mutants[selected]) throw new Error('Unknown Claude adoption production mutation: ' + selected)
const observed = new Set(Object.values(mutants).map(value => value[0]))

export default defineConfig({ ...nativeInput, root,
  cacheDir: resolve(root, '.local/claude-queued-adoption-vitest', selected ?? 'baseline'),
  plugins: [...(nativeInput.plugins ?? []), { name: 'actual-compiled-claude-adoption', enforce: 'pre',
    transform(code, id) {
      const path = relative(root, id.split('?')[0]!)
      if (!observed.has(path)) return
      const original = code, mutation = selected && mutants[selected]
      if (mutation && path === mutation[0]) {
        if (code.split(mutation[1]).length !== 2) throw new Error('Production mutation anchor is not unique: ' + selected)
        code = code.replace(mutation[1], mutation[2])
      }
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      if (process.env.AGENTMUX_CLAUDE_ADOPTION_LOADED) appendFileSync(process.env.AGENTMUX_CLAUDE_ADOPTION_LOADED,
        JSON.stringify({ path, originalSHA256: sha(original), sha256: sha(code), ...(original !== code ? { mutation: selected } : {}) }) + '\n')
      if (original !== code) return { code, map: null }
    }
  }],
  test: { ...nativeInput.test, include: ['packages/core/test/claude-native-input-adoption.test.ts', 'packages/core/test/claude-native-history.test.ts', 'packages/core/test/native-input-adoption.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'], passWithNoTests: false }
})
