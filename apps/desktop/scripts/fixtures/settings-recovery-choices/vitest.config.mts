import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { aliases, root } from '../settings-resource-library/environment.mjs'

const require = createRequire(resolve(root, 'apps/desktop/package.json'))
const localReact = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'].map(name => ({ find: new RegExp(`^${name}$`), replacement: require.resolve(name) }))
const mutant = process.env.AGENTMUX_RECOVERY_CHOICE_MUTANT
export default defineConfig({
  root,
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  resolve: { alias: [...localReact, ...aliases] },
  plugins: mutant ? [{ name: 'recovery-choice-owner-mutation', enforce: 'pre', transform(source, id) {
    const file = 'apps/desktop/src/renderer/src/components/settings/ContinuitySettingsPane.tsx'
    if (id.split('?')[0] !== resolve(root, file)) return
    const before = "onChange={() => draft.setField('activeRecovery', 'manual')}"
    if (source.split(before).length !== 2) throw new Error('Expected one recovery choice owner')
    const changed = source.replace(before, "onChange={() => draft.setField('activeRecovery', 'automatic')}")
    if (process.env.AGENTMUX_RECOVERY_CHOICE_EVIDENCE) appendFileSync(process.env.AGENTMUX_RECOVERY_CHOICE_EVIDENCE, JSON.stringify({
      mutant: 'manual-mode', file, count: 1,
      original: createHash('sha256').update(source).digest('hex'), consumed: createHash('sha256').update(changed).digest('hex')
    }) + '\n')
    return { code: changed, map: null }
  } }] : [],
  test: {
    include: ['apps/desktop/test/settings-recovery-choices.test.tsx', 'apps/desktop/test/session-continuity-settings.test.tsx'],
    setupFiles: [resolve(root, 'vitest.setup.ts')], maxWorkers: 1
  }
})
