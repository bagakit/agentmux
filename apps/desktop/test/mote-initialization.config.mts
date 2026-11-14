import { resolve } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { defineConfig } from 'vitest/config'
import owning from '../scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, { file: string; before: string; after: string }> = {
  'profile-navigation': { file: 'MoteDetailsPanel.tsx', before: 'setProfileOpen(true)', after: "void onOpenPath(scope.rootPath + '/topic.md')" },
  'clear-newer-draft': { file: 'MoteProfileDialog.tsx', before: 'latest.current === submitted && !moved', after: '!moved' },
  'skip-first-continuation': { file: 'MoteQuickMode.tsx', before: 'if (firstConversation) continueToConversation?.()', after: 'void firstConversation' }
}
const selected = process.env.MOTE_INITIALIZATION_UI_MUTATION
if (selected && !mutations[selected]) throw new Error('Unknown UI mutation')
export default defineConfig({ ...owning, root, plugins: [{ name: 'mote-initialization-actual-source-mutation', enforce: 'pre',
  transform(source, id) {
    const file = id.split('?')[0]!, mutation = selected ? mutations[selected] : undefined
    if (!file.startsWith(root + '/apps/desktop/src/renderer/src/')) return
    let loaded = source
    if (mutation && file.endsWith('/' + mutation.file)) {
      if (source.split(mutation.before).length !== 2) throw new Error('Mutation needs one exact production anchor')
      loaded = source.replace(mutation.before, mutation.after)
    }
    if (process.env.MOTE_INITIALIZATION_UI_LOADED && Object.values(mutations).some(value => file.endsWith('/' + value.file))) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.MOTE_INITIALIZATION_UI_LOADED, JSON.stringify({ file, sourceSHA256: hash(source), loadedSHA256: hash(loaded), mutation: loaded === source ? null : selected }) + '\n')
    }
    return loaded === source ? null : { code: loaded, map: null }
  }
}], resolve: { ...owning.resolve, alias: [
  { find: /^@agentmux\/identity\/runtime-source$/, replacement: resolve(import.meta.dirname, '../../../packages/identity/dist/runtime-source.js') },
  ...owning.resolve!.alias as import('vite').Alias[]
] }, test: { ...owning.test, include: ['apps/desktop/test/mote-initialization.test.tsx', 'apps/desktop/test/mote-quick-mode.test.tsx'], testTimeout: 15000 } })
