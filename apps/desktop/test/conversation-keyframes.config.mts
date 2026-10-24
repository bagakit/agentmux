import { defineConfig } from 'vitest/config'
import { aliases } from '../scripts/fixtures/settings-resource-library/environment.mjs'
export default defineConfig({ esbuild: { jsx: 'automatic' }, resolve: { alias: aliases, conditions: ['browser', 'import', 'default'] },
  ssr: { noExternal: ['@agentmux/client-ui'] }, test: { environment: 'happy-dom', include: ['test/conversation-keyframes.test.tsx'] } })
