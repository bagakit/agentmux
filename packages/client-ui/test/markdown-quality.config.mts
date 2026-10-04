import { fileURLToPath } from 'node:url'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('../../..', import.meta.url))
export default defineConfig({
  root,
  esbuild: { jsx: 'automatic' },
  plugins: [{
    name: 'markdown-quality-loaded-source', enforce: 'pre',
    transform(code, id) {
      const log = process.env.AGENTMUX_MARKDOWN_LOADED_LOG
      const path = relative(root, id.split('?')[0]!)
      if (log && ['packages/client-ui/src/lib/agent-markdown.ts', 'packages/client-ui/src/components/AgentMarkdown.tsx'].includes(path)) {
        appendFileSync(log, JSON.stringify({ path, loadedSHA256: createHash('sha256').update(code).digest('hex') }) + '\n')
      }
      return null
    }
  }],
  test: {
    include: ['packages/client-ui/test/markdown-semantics.test.tsx'],
    environment: 'happy-dom', globals: false, maxWorkers: 1
  }
})
