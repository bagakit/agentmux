import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

// Owning tests for the README HTML subset, GitHub alerts and the document reading layout.
// The verify script copies these files with this config into an isolated tree for mutation proof.
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({
  root, esbuild: { jsx: 'automatic' },
  test: {
    include: ['packages/client-ui/test/markdown-html-subset.test.tsx', 'packages/client-ui/test/markdown-html-render.test.tsx', 'packages/client-ui/test/markdown-semantics.test.tsx'],
    environment: 'happy-dom', globals: false, passWithNoTests: false
  }
})
