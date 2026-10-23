import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import base from './vitest.conversation-native-source-integrity.config.mts'
import { candidateModule } from '../../../apps/desktop/scripts/candidate-package-resolve.mjs'

const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, { owner: string; from: string; to: string }> = {
  'omit-pi-changes': { owner: 'packages/core/src/providers/pi.ts',
    from: '    readConversationChanges: readPiConversationChanges,', to: '' },
  'flat-pi-branches': { owner: 'packages/core/src/providers/pi-native-history.ts',
    from: 'if (identity.parentId !== leaf) {', to: 'if (false && identity.parentId !== leaf) {' },
  'detach-pi-page-cut': { owner: 'packages/core/src/providers/pi-native-history.ts',
    from: 'changesCursor: await reader.historyChangesCursor()', to: 'changesCursor: undefined' }
}
const selected = process.env.AGENTMUX_PI_CHANGES_MUTATION ?? ''
if (selected && !Object.hasOwn(mutations, selected)) throw new Error('Unknown Pi changes mutation: ' + selected)
export default defineConfig({ ...base, cacheDir: '.cache/pi-native-changes',
  plugins: [...base.plugins ?? [], { name: 'pi-changes-original-inputs', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!
    if (!isAbsolute(file)) return
    const actual = candidateModule(root, file)
    if (!actual.startsWith(root + '/') || actual.includes('/node_modules/')) return
    const path = relative(root, actual)
    const kind = !id.includes('?') && /\.[cm]?[jt]sx?$/.test(file) ? 'module' : 'resource'
    const mutation = selected ? mutations[selected] : undefined
    let loaded = source
    const applied = mutation?.owner === path
    if (mutation && applied) {
      if (kind !== 'module') throw new Error('Pi mutation requires its original executable module: ' + selected)
      if (source.split(mutation.from).length !== 2) throw new Error('Pi mutation requires one exact loaded owner site: ' + selected)
      loaded = source.replace(mutation.from, mutation.to)
    }
    if (process.env.AGENTMUX_PI_CHANGES_LOADED) {
      const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.AGENTMUX_PI_CHANGES_LOADED, JSON.stringify({ path, request: relative(root, file) + id.slice(file.length),
        kind, fileSHA256: sha(readFileSync(actual)),
        originalSHA256: sha(source), loadedSHA256: sha(loaded), mutation: applied ? selected : null }) + '\n')
    }
    return applied ? loaded : undefined
  } }],
  test: { ...base.test, include: ['packages/core/test/pi-native-changes.test.ts',
    'packages/core/test/pi-native-public-reading.test.ts',
    'packages/core/test/conversation-native-source-integrity.test.ts',
    'apps/desktop/test/conversation-native-input-refresh.integration.test.tsx',
    'packages/core/test/pi-native-history.test.ts', 'packages/core/test/native-jsonl-history-reader.test.ts'],
    fileParallelism: false, maxWorkers: 1, passWithNoTests: false } })
