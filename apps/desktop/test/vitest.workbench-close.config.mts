import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'
import { relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...base,
  cacheDir: resolve(root, '.tmp/workbench-close-cache'),
  plugins: [...base.plugins ?? [], { name: 'native-workbench-close-consumer', enforce: 'pre', transform(source, id) {
    const file = relative(root, id.split('?')[0]!)
    // Select the shipping persistence consumers. Only the IPC adapter remains
    // the private test port; the Store and both original durable owners are real.
    if (['apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/desktop-user-state.ts',
      'apps/desktop/src/renderer/src/lib/launcher-state.ts'].includes(file)) return { code: source.replaceAll('__AGENTMUX_WEB_PREVIEW__', 'false'), map: null }
  } }],
  test: { ...base.test, include: ['apps/desktop/test/workbench-close-cli.test.ts'], testTimeout: 30_000, passWithNoTests: false }
})
