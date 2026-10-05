import { defineConfig } from 'vitest/config'
import existing from '../../../../../packages/client-ui/test/input-markdown.config.mts'

export default defineConfig({ ...existing, test: { ...existing.test,
  include: ['packages/client-ui/test/markdown-parse-reuse.test.tsx', 'packages/client-ui/test/input-markdown.test.tsx',
    'packages/client-ui/test/markdown-semantics.test.tsx', 'packages/client-ui/test/markdown-outline.test.tsx'] } })
