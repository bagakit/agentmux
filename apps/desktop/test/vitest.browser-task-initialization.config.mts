import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'

export default defineConfig({ ...source, plugins: [...(source.plugins ?? []), {
  name: 'browser-task-input-mutation', enforce: 'pre',
  transform(code, id) {
    if (!process.env.AGENTMUX_TEST_BROWSER_TASK_MUTATION || !id.split('?')[0]!.endsWith('/renderer/src/store.ts')) return
    const original = "if (recipient) return { expectedRun: { ...recipient.run }, admissionIntent: { kind: 'session-conversation' } }"
    if (code.split(original).length !== 2) throw new Error('Browser task admission mutation must match exactly one loaded implementation')
    return { code: code.replace(original, original.replace('session-conversation', 'manual-actor')), map: null }
  }
}], test: { ...source.test,
  include: ['apps/desktop/test/browser-task-initialization.test.ts'], passWithNoTests: false, testTimeout: 30000
} })
