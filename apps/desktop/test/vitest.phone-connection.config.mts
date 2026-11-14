import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { desktopRequire, installedDependency, root } from '../scripts/fixtures/settings-resource-library/environment.mjs'
import { workspaceSourceExport } from '../../../packages/core/test/helpers/workspace-source-export.mjs'
import { bundleIdentityRuntime } from '../../../packages/identity/scripts/runtime-bundle.mjs'

// node node_modules/vitest/vitest.mjs run --config apps/desktop/test/vitest.phone-connection.config.mts
// This gate consumes current workspace source, including generated identity runtime source;
// it neither rebuilds shared dist nor claims compiled Core qualification.
const suites = ['settings-direct-actions', 'mobile-connection-toolkit', 'toolkit-current-link', 'toolkit-survey-and-phone-settings', 'toolkit-phone-result-chain']
const report = process.env.AGENTMUX_PHONE_CONNECTION_LOADED
const mutation = process.env.AGENTMUX_PHONE_CONNECTION_MUTATION
const variants: Record<string, { before: string; after: string; target: string; file?: string; suite?: string }> = {
  'phone-cached-current-copy': {
    file: 'apps/desktop/src/renderer/src/components/settings/DeviceManagementSettings.tsx', suite: 'settings-direct-actions',
    before: 'const request = picked && (!candidates.length || candidates.some(candidate => candidate.address === picked)) ? picked : null',
    after: "if (action === 'copy' && url && picked === chosen) { await api.ui.writeClipboardText(url); return }\n      const request = picked && (!candidates.length || candidates.some(candidate => candidate.address === picked)) ? picked : null",
    target: 'Mobile current copy re-reads the Host after its default network address changes'
  },
  'phone-premature-current-copy': {
    file: 'apps/desktop/src/renderer/src/components/toolkit/MobileConnectionResult.tsx', suite: 'toolkit-phone-result-chain',
    before: 'const value = await api.toolkit.evaluate(MOBILE_CONNECTION_TOOL_ID, {',
    after: 'if (connection) await api.ui.writeClipboardText(connection.url);\n      const value = await api.toolkit.evaluate(MOBILE_CONNECTION_TOOL_ID, {',
    target: 'real current phone producer waits for the new exact display receipt after the original Host address changes'
  },
  'survey-global-flight': { before: 'inFlight.current?.url === url', after: 'inFlight.current !== null', target: 'in flight \\(opened, waiting\\)' },
  'survey-unscoped-result': { before: 'if (inFlight.current === request) setResult', after: 'setResult', target: 'in flight \\(opened, waiting\\)' },
  'survey-stale-url-feedback': { before: 'result.url === url ? result', after: 'true ? result', target: 'focus with its URL \\(opened\\)' }
}
if (mutation && !Object.hasOwn(variants, mutation)) throw Error('Unknown phone connection mutation: ' + mutation)
const variant = mutation ? variants[mutation] : undefined
const owners = new Set([
  ...suites.map(name => `apps/desktop/test/${name}.test.tsx`),
  ...['SettingsPanel', 'settings/DeviceManagementSettings', 'settings/BuiltinMobileConnectionSettings',
    'toolkit/MobileConnectionResult', 'toolkit/PhoneConnectionVisuals', 'toolkit/ToolkitResultLink', 'toolkit/UserToolkitResult']
    .map(name => `apps/desktop/src/renderer/src/components/${name}.tsx`),
  'apps/desktop/src/main/toolkit-owner.ts', 'apps/desktop/src/main/toolkit-custom-owner.ts',
  'packages/core/src/device-administration.ts'
])
const runtime = `export const identityRuntimeSource = ${JSON.stringify((await bundleIdentityRuntime()).source)};\n`
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

export default defineConfig({ root, cacheDir: resolve(root, '.tmp/phone-connection-source'),
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  resolve: {
    conditions: ['browser', 'module', 'import'], dedupe: ['react', 'react-dom'],
    alias: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client', 'react-dom/server', 'react-dom/test-utils']
      .map(name => ({ find: new RegExp('^' + name + '$'), replacement: desktopRequire.resolve(name) }))
  },
  plugins: [{ name: 'phone-connection-source-consumers', enforce: 'pre',
    resolveId(id, importer) {
      if (id === '@agentmux/identity/runtime-source') return '\0phone-connection-identity'
      return workspaceSourceExport(root, id) ?? installedDependency(id, importer)
    },
    load(id) { if (id === '\0phone-connection-identity') return runtime },
    transform(original, id) {
      const file = relative(root, id.split('?')[0]!)
      if (!owners.has(file)) return
      let code = original
      const changed = variant && file === (variant.file ?? 'apps/desktop/src/renderer/src/components/toolkit/ToolkitResultLink.tsx')
      if (changed) {
        if (code.split(variant.before).length !== 2) throw Error('One actual Survey mutation anchor: ' + mutation)
        code = code.replace(variant.before, variant.after)
      }
      if (report) {
        const row = { file, originalSHA256: sha(readFileSync(resolve(root, file), 'utf8')), loadedSHA256: sha(code), mutation: changed ? mutation : null }
        code = `import { appendFileSync as __phoneLoaded } from 'node:fs'; __phoneLoaded(${JSON.stringify(resolve(root, report))},${JSON.stringify(JSON.stringify(row) + '\n')});\n` + code
      }
      return code === original ? undefined : { code, map: null }
    }
  }],
  test: { include: (variant ? [variant.suite ?? 'toolkit-survey-and-phone-settings'] : suites).map(name => `apps/desktop/test/${name}.test.tsx`),
    testNamePattern: variant?.target, setupFiles: [resolve(root, 'vitest.setup.ts')],
    environment: 'happy-dom', maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 15000 }
})
