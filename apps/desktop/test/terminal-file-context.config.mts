import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// These tests exercise only xterm cells, Renderer file actions and their wiring.
// Reject Core imports rather than consuming a concurrently changing Core dist.
export default defineConfig({
  resolve: { alias: ['terminal-path-link', 'markdown-file-reference', 'link-url'].map(leaf => ({
    find: '@agentmux/client-ui/' + leaf, replacement: resolve('packages/client-ui/src/lib/' + leaf + '.ts')
  })) },
  plugins: [{ name: 'terminal-file-context-no-core', resolveId(id) {
    if (id === '@agentmux/core' || id.startsWith('@agentmux/core/')) throw Error('This focused terminal file test must not consume Core dist')
  } }],
  test: {
    include: ['apps/desktop/test/terminal-file-context.test.ts', 'apps/desktop/test/terminal-artifact-context-menu.test.tsx',
      'apps/desktop/test/terminal-artifact-link.test.ts', 'apps/desktop/test/terminal-link-provider-coverage.test.ts',
      'apps/desktop/test/{terminal-link-range,terminal-path-link,terminal-http-link-boundary,tilde-path-link}.test.ts'],
    passWithNoTests: false
  }
})
