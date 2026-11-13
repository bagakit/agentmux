import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from '../../../vitest.config'

const root = resolve(import.meta.dirname, '../../..')
const variants = {
  propagation: ['apps/desktop/src/renderer/src/components/settings/ExternalConnectionsSettings.tsx',
    '<MoteConnectionPanel key={JSON.stringify([moteSelection.origin.target, moteSelection.origin.topicId])} {...moteSelection.origin} active={active}',
    '<MoteConnectionPanel key={JSON.stringify([moteSelection.origin.target, moteSelection.origin.topicId])} {...moteSelection.origin} active={true}'],
  cleanup: ['apps/desktop/src/renderer/src/lib/use-mote-bot-setup.ts',
    'setDriving(false); setEnrollmentView(null); setChecking(null); setProgressIssue(null)',
    'setDriving(false); setChecking(null); setProgressIssue(null)'],
  'late-private-view': ['apps/desktop/src/renderer/src/lib/use-mote-bot-setup.ts',
    'presentation.current && workbenchDocumentVisible(document) && epoch === privateEpoch.current',
    'presentation.current && workbenchDocumentVisible(document)'],
  'profile-propagation': ['apps/desktop/src/renderer/src/components/MoteBotSetup.tsx',
    '<MoteProfileSetup active={setup.active}', '<MoteProfileSetup active={true}'],
  'profile-first-read': ['apps/desktop/src/renderer/src/components/MoteBotSetup.tsx',
    'readOnOpen={setup.readPrivate}', 'readOnOpen={true}']
} as const
const mutation = process.env.SETTINGS_MOTE_VISIBILITY_MUTATION as keyof typeof variants | undefined
if (mutation && !variants[mutation]) throw Error('Unknown Settings Mote visibility mutation')
export default defineConfig({ ...base, root,
  plugins: [{ name: 'settings-mote-visibility-source', enforce: 'pre', transform(original, id) {
    const file = relative(root, id.split('?')[0]!)
    if (!file.startsWith('apps/desktop/src/renderer/src/')) return
    let loaded = original
    const selected = mutation && variants[mutation]
    if (selected && selected[0] === file) {
      if (original.split(selected[1]).length !== 2) throw Error('Settings visibility mutation anchor must match once')
      loaded = original.replace(selected[1], selected[2])
    }
    if (process.env.SETTINGS_MOTE_VISIBILITY_LOADED) appendFileSync(process.env.SETTINGS_MOTE_VISIBILITY_LOADED,
      JSON.stringify({ file, originalSHA256: createHash('sha256').update(original).digest('hex'), loadedSHA256: createHash('sha256').update(loaded).digest('hex'), mutation: loaded === original ? null : mutation }) + '\n')
    return loaded === original ? undefined : { code: loaded, map: null }
  } }],
  test: { ...base.test, include: ['apps/desktop/test/settings-mote-visibility.test.tsx'], fileParallelism: false, passWithNoTests: false }
})
