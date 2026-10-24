import { defineConfig } from 'vitest/config'
export default defineConfig({ esbuild: { jsx: 'automatic' }, resolve: { conditions: ['browser', 'import', 'default'] },
  ssr: { noExternal: ['@agentmux/client-ui'] }, test: { environment: 'happy-dom', include: ['test/conversation-keyframes.test.tsx'] } })
