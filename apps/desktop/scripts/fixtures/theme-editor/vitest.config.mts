import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import settings from '../settings-overview/vitest.config.mts'
// Only native export filename randomness is fixed. Main writer and filesystem calls stay real.
const nativeExportUuid = '\0test-native-theme-export-uuid'
export default defineConfig({
  plugins: [{
    name: 'native-export-only-deterministic-uuid', enforce: 'pre',
    resolveId(source, importer) {
      if (source === 'node:crypto' && importer?.endsWith('/main/theme-file-export.ts')) return nativeExportUuid
    },
    load(id) {
      if (id === nativeExportUuid) return "export const randomUUID = () => '00000000-0000-0000-0000-000000000001'"
    }
  }],
  resolve: { alias: [
    ...(settings.resolve!.alias as []),
    { find: /^@agentmux\/client-ui\/theme$/, replacement: resolve(import.meta.dirname, '../../../../../packages/client-ui/src/theme/index.ts') },
    { find: /^@agentmux\/client-ui\/icons$/, replacement: resolve(import.meta.dirname, '../../../../../packages/client-ui/src/theme/icons.tsx') }
  ] }, define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  test: { include: ['apps/desktop/test/theme-editor-runtime.test.tsx', 'apps/desktop/test/theme-files-runtime.test.tsx'], environment: 'happy-dom', maxWorkers: 1 }
})
