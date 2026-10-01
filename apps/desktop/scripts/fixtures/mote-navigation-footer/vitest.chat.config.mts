import { defineConfig } from 'vitest/config'
import owning from './vitest.owning.config.mts'
import { resolve } from 'node:path'
export default defineConfig({ ...owning, resolve: { ...owning.resolve, alias: [...owning.resolve.alias,
  { find: /^react-resizable-panels$/, replacement: resolve(import.meta.dirname, '../../../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.esm.js') }
] }, test: { ...owning.test, include: [
  'test/mote-chat-workspace.test.tsx', 'test/mote-file-scope.test.tsx', 'test/mote-conversation-identity.test.tsx',
  'test/mote-floating-actions.test.tsx', 'test/mote-identity-actions.test.tsx', 'test/window-overlay-host-cost.test.tsx',
  'test/native-overlay-regions.test.ts', 'test/native-overlay-pointer.test.tsx', 'test/window-overlay-layer-contract.test.tsx',
  'test/mote-navigation-rail.test.tsx', 'test/mote-closed-tab-target.test.tsx', 'test/mote-default-dialogue.test.tsx',
  'test/file-explorer-open-as-project.integration.test.tsx'
] } })
