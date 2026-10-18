import base from '../../../apps/desktop/scripts/fixtures/conversation-latest-auto/vitest.owning.config.mts'
import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({ ...base, cacheDir: '.cache/conversation-message',
  resolve: { ...base.resolve, alias: [...base.resolve!.alias as [],
    { find: /^@noble\/hashes\/(.+)$/u, replacement: resolve(import.meta.dirname, '../../core/node_modules/@noble/hashes/$1') }] },
  plugins: [...base.plugins!, { name: 'message-copy-source-mutation', enforce: 'pre', transform(code, id) {
    const copyMutation = process.env.AGENTMUX_MESSAGE_COPY_MUTATION, cardMutation = process.env.AGENTMUX_MESSAGE_CARD_MUTATION
    const mutation = id.endsWith('/packages/client-ui/src/lib/use-content-copy-action.ts') ? copyMutation
      : id.endsWith('/packages/client-ui/src/components/ConversationMessageCard.tsx') ? cardMutation : undefined
    if (!mutation) return
    const changes: Record<string, [string, string]> = {
      'cancel-preparation': ['if (!action || !action.pending || action.writing) return', 'if (true) return'],
      'source-fence': ['mounted.current && latestOwner.current === owner && actionRef.current === action && !action.controller.signal.aborted', 'true'],
      'strict-receipt': ['const accepted = await write(text, failed) === true', 'const accepted = (await write(text, failed), true)'],
      'nested-intent': ['onIntent?.()', 'void 0'],
      'system-source': ['expanded?.identity === identity && expanded.open', 'Boolean(expanded?.open)'],
      'collaboration-retention': ['current.presented || open', 'open']
    }
    const change = changes[mutation]
    if (!change || code.split(change[0]).length !== 2) throw Error('Unknown or non-unique message mutation: ' + mutation)
    return { code: code.replace(...change), map: null }
  } }],
  test: { ...base.test, environment: 'happy-dom', include: [
    'packages/client-ui/test/conversation-message-copy.test.tsx', 'packages/client-ui/test/conversation-message-card.test.tsx', 'packages/client-ui/test/conversation-detail-copy.test.tsx',
    'packages/client-ui/test/native-history-content.test.tsx', 'packages/client-ui/test/conversation-collaboration.test.tsx',
    'packages/client-ui/test/conversation-long-message.test.tsx', 'packages/client-ui/test/markdown-code-copy.test.tsx',
    'apps/desktop/test/conversation-system-message.test.tsx'
  ] }
})
