import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config'
import { relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...original, plugins: [...original.plugins ?? [], {
  name: 'shipping-file-client-persistence', enforce: 'pre', transform(source, id) {
    if (['apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/desktop-user-state.ts',
      'apps/desktop/src/renderer/src/lib/launcher-state.ts'].includes(relative(root, id.split('?')[0]!))) return { code: source.replaceAll('__AGENTMUX_WEB_PREVIEW__', 'false'), map: null }
  }
}], test: { ...original.test, include: ['apps/desktop/test/file-path-client-projection.test.ts'], passWithNoTests: false, testTimeout: 60000 } })
