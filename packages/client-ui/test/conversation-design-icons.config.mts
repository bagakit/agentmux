import { defineConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import base from '../../../apps/desktop/test/vitest.conversation-unified-consumers.config.mts'

export default defineConfig({ ...base, cacheDir: '.cache/conversation-design-icons', plugins: [...base.plugins ?? [], {
  name: 'design-icons-private-semantic-mutation', enforce: 'pre', transform(source, id) {
    if (!process.env.AGENTMUX_DESIGN_ICON_MUTATION || !id.endsWith('/packages/client-ui/src/components/DeferredConversationProcess.tsx')) return
    if (process.env.AGENTMUX_DESIGN_ICON_MUTATION !== 'deferred-result-as-call') throw Error('Unknown icon semantic mutation')
    const needle = "header.parts.some(part => part.kind === 'tool-result') ? 'conversation.tool-result'"
    if (source.split(needle).length !== 2) throw Error('Expected one actual deferred-result semantic owner')
    const code = source.replace(needle, "header.parts.some(part => part.kind === 'tool-result') ? 'conversation.tool-call'")
    if (process.env.AGENTMUX_DESIGN_ICON_MUTATION_HITS) appendFileSync(process.env.AGENTMUX_DESIGN_ICON_MUTATION_HITS,
      JSON.stringify({ path: id, matches: 1, originalSHA256: createHash('sha256').update(source).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex') }) + '\n')
    return { code, map: null }
  }
}], test: { ...base.test, include: ['packages/client-ui/test/conversation-design-icons.test.tsx'], passWithNoTests: false, maxWorkers: 1, fileParallelism: false } })
