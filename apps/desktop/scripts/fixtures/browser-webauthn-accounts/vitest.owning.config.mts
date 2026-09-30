import { fileURLToPath } from 'node:url'

// Source-only: this fixture does not consume stale Core dist or claim OS authentication.
const rootUrl = new URL('../../../../../', import.meta.url)
const root = fileURLToPath(rootUrl)
export default {
  root,
  resolve: { alias: [{ find: /^@agentmux\/core$/, replacement: fileURLToPath(new URL('packages/core/src/index.ts', rootUrl)) }] },
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  test: {
    include: ['apps/desktop/test/browser-webauthn-accounts.test.ts', 'apps/desktop/test/browser-webauthn-access.test.ts'],
    maxWorkers: 1,
    cache: false,
    setupFiles: [fileURLToPath(new URL('vitest.setup.ts', rootUrl))]
  }
}
