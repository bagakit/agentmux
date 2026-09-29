import { fileURLToPath } from 'node:url'
const rootUrl = new URL('../../../../../', import.meta.url)
export default {
  root: fileURLToPath(rootUrl),
  resolve: { alias: [{ find: /^@agentmux\/core$/, replacement: fileURLToPath(new URL('packages/core/src/index.ts', rootUrl)) }] },
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  test: { include: ['apps/desktop/test/browser-operation-feedback.test.ts', 'apps/desktop/test/browser-page-action-feedback.test.ts'],
    maxWorkers: 1, cache: false, setupFiles: [fileURLToPath(new URL('vitest.setup.ts', rootUrl))] }
}
