import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
const root = fileURLToPath(new URL('../../../../../', import.meta.url))
export default defineConfig({ root, resolve: { alias: [{ find: /^@agentmux\/core$/, replacement: fileURLToPath(new URL('../../../../../packages/core/src/index.ts', import.meta.url)) }] }, test: {
  environment: 'node', include: ['apps/desktop/test/browser-uploads.test.ts', 'apps/desktop/test/browser-upload-document-lifetime.test.ts', 'apps/desktop/test/browser-page-dispatch.test.ts', 'apps/desktop/test/browser-external-target.test.ts', 'apps/desktop/test/browser-external-main-glue.test.ts'], maxWorkers: 1, fileParallelism: false
} })
