import { fileURLToPath } from 'node:url'
const rootUrl = new URL('../../../../../', import.meta.url)
export default {
  root: fileURLToPath(rootUrl),
  resolve: { alias: [{ find: /^@agentmux\/core$/, replacement: fileURLToPath(new URL('packages/core/src/index.ts', rootUrl)) }] },
  test: { include: ['apps/desktop/scripts/fixtures/browser-input-history/process.test.ts'], maxWorkers: 1, cache: false }
}
