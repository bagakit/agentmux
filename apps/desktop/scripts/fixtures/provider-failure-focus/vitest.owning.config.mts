import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../../../..')
// These two unrelated, currently broken leaves are outside this Agent/Terminal scenario.
// They fail explicitly if reached; the Store, Focus, Attention, Composer and Notices stay real.
export default defineConfig({ root,
  resolve: { conditions: ['browser', 'import', 'default'] },
  ssr: { noExternal: ['@agentmux/client-ui'], resolve: { conditions: ['browser', 'import', 'default'] } },
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  plugins: [{ name: 'provider-failure-unrelated-paint-boundary', enforce: 'pre', transform(source, id) {
    const path = id.split('?')[0]!
    if (path.endsWith('/components/ConversationView.tsx'))
      return { code: "export function ConversationView(){throw new Error('Native conversation painting is outside this provider-failure fixture')}", map: null }
    if (path.endsWith('/lib/space-agent-control.ts')) {
      const anchor = "import { zoneFileResource } from '../../../shared/zone-file-resource'"
      if (source.includes(anchor)) return { code: source.replace(anchor,
        "function zoneFileResource(..._args: unknown[]): never { throw new Error('File-zone resources are outside this Agent/Terminal fixture') }"), map: null }
    }
  } }],
  test: { setupFiles: [resolve(root, 'vitest.setup.ts')], passWithNoTests: false, fileParallelism: false, maxWorkers: 1,
    include: ['apps/desktop/test/provider-failure-focus.test.tsx', 'apps/desktop/test/focus-card-information.test.tsx',
      'apps/desktop/test/focus-context-cost.test.ts', 'apps/desktop/test/session-mailbox.test.tsx'] }
})
