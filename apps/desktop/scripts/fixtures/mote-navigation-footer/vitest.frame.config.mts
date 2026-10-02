import { defineConfig } from 'vitest/config'
import owning from './vitest.chat.config.mts'
import { resolve } from 'node:path'
const repository = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({ ...owning, resolve: { ...owning.resolve, alias: [...owning.resolve.alias,
  { find: /^@agentmux\/core\/spatial-layout$/, replacement: resolve(repository, 'packages/core/src/spatial-layout.ts') },
  { find: /^@agentmux\/core\/spatial-graph$/, replacement: resolve(repository, 'packages/core/src/spatial-graph.ts') },
  { find: /^@agentmux\/client-ui$/, replacement: resolve(repository, 'packages/client-ui/src/index.ts') },
  { find: /^@agentmux\/client-ui\/platform$/, replacement: resolve(repository, 'packages/client-ui/src/platform.tsx') },
  { find: /^@agentmux\/client-ui\/components\/(.*)$/, replacement: resolve(repository, 'packages/client-ui/src/components/$1.tsx') },
  { find: /^@agentmux\/client-ui\/terminal\/(.*)$/, replacement: resolve(repository, 'packages/client-ui/src/terminal/$1.ts') },
  { find: /^@agentmux\/client-ui\/styles.css$/, replacement: resolve(repository, 'packages/client-ui/src/styles/index.css') },
  { find: /^@agentmux\/client-ui\/(.*)$/, replacement: resolve(repository, 'packages/client-ui/src/lib/$1.ts') }
]}, test: { ...owning.test, setupFiles: [...owning.test.setupFiles, resolve(import.meta.dirname, 'atomic-move.setup.ts')], include: [...owning.test.include, 'test/mote-shared-space-frame.test.tsx', 'test/mote-materials-exact-reference.test.tsx', 'test/mote-details-panel.test.tsx', 'test/mote-hover-surface.test.tsx', 'test/workbench-projection-ownership.test.tsx', 'test/workbench-presentation-wiring.integration.test.tsx', 'test/mote-module-integrity.test.tsx', 'test/explorer-git-switch-material.test.tsx'] } })
