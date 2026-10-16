import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config'

const root = new URL('../../../', import.meta.url).pathname.replace(/\/$/, '')

/** Test-owned work counts on the actual loaded Renderer parser. No product counter
 * or trusted-data flag is introduced. Run only the named owning consumer suite. */
export default defineConfig({
  ...original, root,
  resolve: { alias: [{ find: /^@agentmux\/core\/conversation$/, replacement: root + '/packages/core/dist/conversation.js' }] },
  ssr: { noExternal: ['@agentmux/core', '@agentmux/client-ui'] },
  test: { ...original.test, env: { AGENTMUX_VALIDATION_WORK: '1' } },
  plugins: [{
    name: 'conversation-response-validation-work', enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]
      if (!file?.startsWith(root + '/packages/core/dist/')) return
      let needle: string, measurement: string
      if (file.endsWith('/conversation-changes.js')) {
        needle = 'export function parseConversationUnit(value, ref, accepted) {'
        measurement = `const work = globalThis.__conversationValidationWork;
          if (work) work[new Error().stack.includes('consumeConversationWindowPage') ? 'window' : 'page'].push(value.event.id);`
      } else if (file.endsWith('/conversation-timeline.js')) {
        needle = 'export function conversationRevision(value) {'
        measurement = 'if (globalThis.__conversationValidationWork) globalThis.__conversationValidationWork.revisions++;'
      } else return
      if (code.split(needle).length !== 2) throw new Error('Expected exactly one actual conversation validation owner')
      return { code: code.replace(needle, needle + measurement), map: null }
    }
  }]
})
