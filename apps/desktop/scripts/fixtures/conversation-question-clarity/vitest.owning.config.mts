import base from '../conversation-latest-auto/vitest.owning.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '../../../../..')
const mutations: Record<string, [string, string, string]> = {
  'drop-terminal-caret': ['apps/desktop/src/renderer/src/components/SessionPane.tsx', 'useAppStore.getState().requestRegionCaretFocus(linkOrigin.regionId)', 'void 0 /* missing explicit caret handoff */'],
  'draft-as-submitted': ['packages/client-ui/src/components/AgentAsyncQuestionCard.tsx', '答案草稿（尚未提交）', '答案已提交'],
  'always-unread': ['packages/client-ui/src/lib/conversation-sources.ts', "${unreadTarget ? '对应的原始记录尚未读到。'", "${true ? '对应的原始记录尚未读到。'"],
  'search-captures-terminal-intent': ['apps/desktop/src/renderer/src/components/TerminalView.tsx', "request.target === 'terminal' ? null : searchInputRef.current", 'searchInputRef.current'],
  'retain-replaced-caret': ['apps/desktop/src/renderer/src/components/TerminalView.tsx', "hostDocument.addEventListener('keydown', onLaterInput)", 'void 0 /* later input must not retain the old pending caret */']
}
export default defineConfig({ ...base, cacheDir: '.cache/conversation-question-clarity', plugins: [...(base.plugins ?? []), {
  name: 'question-clarity-loaded-source', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!, path = relative(root, file)
    if (!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/client-ui/src/') && !path.startsWith('apps/desktop/test/') && !path.startsWith('packages/client-ui/test/') && !path.startsWith('apps/mobile/test/')) return
    let code = source
    const mutation = process.env.AGENTMUX_QUESTION_CLARITY_MUTATION, rule = mutation ? mutations[mutation] : undefined
    if (rule && path === rule[0]) {
      if (source.split(rule[1]).length !== 2) throw Error('Non-unique source mutation: ' + mutation)
      code = source.replace(rule[1], rule[2])
    }
    if (mutation && !rule) throw Error('Unknown source mutation: ' + mutation)
    const log = process.env.AGENTMUX_QUESTION_CLARITY_LOADED
    if (log) appendFileSync(log, JSON.stringify({ path, sha256: createHash('sha256').update(code).digest('hex'), originalSHA256: createHash('sha256').update(source).digest('hex'), ...(code !== source ? { mutation } : {}) }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...base.test, environment: 'happy-dom', testTimeout: 20000, include: [
  'apps/desktop/test/session-pane-navigation-context.test.tsx',
  'apps/desktop/test/session-pane-async-question.integration.test.tsx', 'packages/client-ui/test/async-question-input.test.tsx',
  'apps/desktop/test/conversation-collected-reply.test.tsx', 'apps/desktop/test/conversation-source-roles.test.tsx',
  'apps/desktop/test/conversation-async-question.integration.test.tsx', 'apps/desktop/test/codex-saved-question-card.integration.test.tsx'
] } })
