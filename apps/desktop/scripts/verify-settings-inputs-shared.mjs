import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const select = 'packages/client-ui/src/input/NativeSelect.tsx'
const search = 'packages/client-ui/src/input/SearchInput.tsx'
await verifyRendererSourceMutations({
  name: 'shared-settings-inputs-' + randomUUID(),
  owningConfig: 'apps/desktop/test/settings-form-rows.config.mts',
  tests: ['apps/desktop/test/settings-shared-inputs.test.tsx', 'apps/desktop/test/selection-local-query.test.tsx'],
  sources: [select, search, 'packages/client-ui/src/input/input.css', 'test/fixture-values.mjs',
    'apps/desktop/src/renderer/src/components/settings/SettingsResourceLibrary.tsx'],
  mutations: [
    { label: 'native-select-loses-shared-drawing', file: select, before: 'ui-input ', after: '' },
    { label: 'settings-library-clear-loses-native-focus', file: search, before: 'input.current?.focus({ preventScroll: true }); ', after: '' }
  ]
})
execFileSync(process.execPath, [
  fileURLToPath(new URL('./verify-settings-search-refinement.mjs', import.meta.url)), '--case', 'clear-focus'
], { stdio: 'inherit' })
