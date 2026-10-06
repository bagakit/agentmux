import { resolve } from 'node:path'
import { readdirSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import { sourceAliases as desktopSourceAliases } from '../bookmark-local-link/vitest.owning.config.mts'
const repository = resolve(import.meta.dirname, '../../../../..')
const shared = resolve(repository, 'packages/client-ui/src')
const sharedAliases = [
  ...['lib', 'components'].flatMap(directory => readdirSync(resolve(shared, directory), { withFileTypes: true })
    .filter(entry => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map(entry => ({ find: `@agentmux/client-ui/${directory === 'lib' ? '' : 'components/'}${entry.name.replace(/\.tsx?$/, '')}`,
      replacement: resolve(shared, directory, entry.name) }))),
  { find: '@agentmux/client-ui/input/styles.css', replacement: resolve(shared, 'input/input.css') },
  { find: '@agentmux/client-ui/input', replacement: resolve(shared, 'input/index.ts') },
  { find: '@agentmux/client-ui/icons', replacement: resolve(shared, 'theme/icons.tsx') },
  { find: '@agentmux/client-ui/theme', replacement: resolve(shared, 'theme/index.ts') },
  { find: '@agentmux/client-ui/note', replacement: resolve(shared, 'note') },
  { find: '@agentmux/client-ui/terminal', replacement: resolve(shared, 'terminal') },
  { find: '@agentmux/client-ui/platform', replacement: resolve(shared, 'platform.tsx') },
  { find: '@agentmux/client-ui/styles.css', replacement: resolve(shared, 'styles/index.css') },
  { find: '@agentmux/client-ui/styles', replacement: resolve(shared, 'styles') },
  { find: '@agentmux/client-ui', replacement: resolve(shared, 'index.ts') }
]
if (sharedAliases.length <= 3) throw new Error('Owning shared source modules must be present')
export const sourceAliases = [...sharedAliases, ...desktopSourceAliases]
export default defineConfig({
  root: repository, resolve: { alias: sourceAliases, conditions: ['browser', 'development', 'import', 'default'] }, define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  test: { include: ['apps/desktop/test/markdown*.test.ts*', 'apps/desktop/test/agent-markdown*.test.ts*', 'apps/desktop/test/file-preview-open.test.tsx',
    'apps/desktop/test/terminal-path-link.test.ts', 'apps/desktop/test/conversation-image*.test.tsx', 'apps/desktop/test/pasted-image-read.test.ts'],
    setupFiles: [resolve(repository, 'vitest.setup.ts')], server: { deps: { inline: ['@agentmux/client-ui'] } },
    passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 45000 },
  cacheDir: resolve(repository, '.tmp/local-link-preview-maintenance/cache')
})
