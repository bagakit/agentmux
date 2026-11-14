import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const args = process.argv.slice(2)
assert.ok(args.length === 0 || args.length === 1 && args[0] === '--empty', 'Use the default list search or --empty verification')
const empty = args.includes('--empty')
process.env.AGENTMUX_LIST_CONTROLS_MODE = empty ? 'empty' : 'search'

const input = 'packages/client-ui/src/input/SearchInput.tsx'
const library = 'apps/desktop/src/renderer/src/components/settings/SettingsResourceLibrary.tsx'
const profiles = 'apps/desktop/src/renderer/src/components/settings/BrowserProfileLibrary.tsx'
const trash = 'apps/desktop/src/renderer/src/components/settings/BrowserProfileTrash.tsx'
const goals = 'apps/desktop/src/renderer/src/components/GoalsCollection.tsx'
await verifyRendererSourceMutations({
  name: 'list-' + process.env.AGENTMUX_LIST_CONTROLS_MODE + '-' + randomUUID(),
  tests: ['apps/desktop/test/list-search-controls.test.tsx'],
  sources: [input, library, profiles, trash, goals, 'apps/desktop/src/renderer/src/components/GlobalBoardSurface.tsx'],
  owningConfig: 'apps/desktop/test/settings-form-rows.config.mts',
  mutations: empty ? [
    { label: 'loading-trash-misreported-as-empty', file: trash, before: "archive.status === 'ready' && list?.entries.length === 0", after: '!list?.entries.length' },
    { label: 'trash-retry-reuses-stale-empty', file: trash, before: "archive.status === 'ready' && list?.entries.length === 0", after: "list?.entries.length === 0 && error?.source !== 'read'" },
    { label: 'unknown-profile-projection-misreported-as-empty', file: library, before: 'projection?.length === 0', after: 'items.length === 0' },
    { label: 'goal-zero-matches-loses-its-recovery', file: goals, before: 'onClick={onClearConditions}', after: 'onClick={undefined}' }
  ] : [
    { label: 'clear-leaves-the-old-query', file: input, before: "onValueChange('')", after: 'onValueChange(value)' },
    { label: 'clear-loses-original-input-focus', file: input, before: 'input.current?.focus({ preventScroll: true }); ', after: '' },
    { label: 'composition-escapes-native-input', file: input, before: 'event.stopPropagation(); return', after: 'return' }
  ]
})

if (!empty) execFileSync('pnpm', ['--dir', 'apps/mobile', 'exec', 'vitest', 'run', '--config', 'vitest.config.ts', 'test/mobile-topic-directory-input.test.tsx'], {
  cwd: new URL('../../..', import.meta.url), env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' }, stdio: 'inherit'
})
