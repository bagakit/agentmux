import base from '../conversation-latest-auto/vitest.owning.config.mts'
import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const target = resolve(import.meta.dirname, '../../../../../packages/core/src/providers/codex-saved-history.ts')
export default defineConfig({ ...base, cacheDir: '.cache/codex-saved-question', plugins: [...base.plugins!, {
  name: 'saved-question-source-counterexample', enforce: 'pre', transform(source, id) {
    if (id.split('?')[0] !== target) return
    let code = source
    const mutation = process.env.AGENTMUX_SAVED_QUESTION_MUTATION
    const replacements: Record<string, [string, string]> = {
      'omit-canonical-question': ["const asyncQuestion = record.type === 'event_msg'", "const asyncQuestion = false && record.type === 'event_msg'"],
      'accept-foreign-source': ["payload.thread_id === nativeSessionId && typeof payload.turn_id === 'string'", "typeof payload.turn_id === 'string'"],
      'omit-request-page-fit': ['if (!items.some(item => item.questionAnswers !== undefined || item.questionRequest !== undefined)) return items',
        'if (!items.some(item => item.questionAnswers !== undefined)) return items'],
      'omit-request-record-fit': ['if (bytes(value) <= maximum) return value', 'if (true) return value']
    }
    if (mutation) {
      const pair = replacements[mutation]
      if (!pair || source.split(pair[0]).length !== 2) throw new Error('Unknown/nonunique saved-question source mutation: ' + mutation)
      code = source.replace(...pair)
    }
    const log = process.env.AGENTMUX_SAVED_QUESTION_LOADED
    if (log) appendFileSync(log, JSON.stringify({ path: 'packages/core/src/providers/codex-saved-history.ts', originalSHA256: createHash('sha256').update(source).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'), ...(mutation ? { mutation } : {}) }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...base.test, include: ['packages/core/test/codex-saved-question-request.test.ts', 'apps/desktop/test/codex-saved-question-card.integration.test.tsx'], passWithNoTests: false } })
