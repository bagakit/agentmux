import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import base from './browser-offline-cache.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const file = 'apps/desktop/src/main/browser-profile-storage-confirmation.ts'
const mutants: Record<string, [string, string]> = {
  'profile': ['profile.id !== input.profileId || ', ''],
  'revision': ['profile.revision !== input.expectedRevision || ', ''],
  'cancel-default': ['defaultId: 0', 'defaultId: 1'],
  'native-response': ['return answer.response === 1', 'return answer.response >= 0'],
  'question': ["type: 'question'", "type: 'warning'"]
}
const selected = process.env.AGENTMUX_CONFIRMATION_MUTANT
if (selected && !mutants[selected]) throw new Error('Unknown confirmation source mutation')
let applied = false
export default defineConfig({ root, resolve: base.resolve,
  cacheDir: resolve(root, '.bagakit/feature-tracker/resource-confirmation-and-paste-readability/confirmation-cache', selected ?? 'baseline'),
  plugins: [{ name: 'confirmation-source-proof', enforce: 'pre', transform(code, id) {
    if (!selected || relative(root, id.split('?')[0]!) !== file) return
    const [before, after] = mutants[selected]!
    if (code.split(before).length !== 2) throw new Error('Unique original confirmation source anchor required')
    applied = true; return { code: code.replace(before, after), map: null }
  }, buildEnd() { if (selected && !applied) throw new Error('Confirmation mutation was not consumed') } }],
  test: { include: ['apps/desktop/test/browser-offline-cache-confirmation.test.ts'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1 }
})
