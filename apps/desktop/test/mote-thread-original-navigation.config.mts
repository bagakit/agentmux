import { defineConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'
import source from './mote-discussion-threads.config.mts'

const variants = {
  'work-requires-current-membership': ['components/MoteThreadsPanel.tsx', 'const state = useAppStore.getState(), catalog = workbenchSelectionCatalog(state), sessions = sessionPresentationById(state.sessions)',
    'const state = useAppStore.getState(), catalog = workbenchSelectionCatalog(state), sessions = sessionPresentationById(state.sessions); if (!dialogue?.target || !moteMembers(catalog, dialogue.target.spaceId).some(member => member.hostId === source.origin.hostId && member.agentSessionId === source.origin.recipientSessionId)) return []'],
  'work-opens-club-member': ['components/MoteWorkface.tsx', 'onOpenOriginal={openOriginalWork}', 'onOpenOriginal={showThread}'],
  'work-ignores-host': ['components/MoteThreadsPanel.tsx', "session.control.hostId === source.origin.hostId &&", 'true &&'],
  'work-reference-duplicates': ['components/MoteThreadsPanel.tsx', 'references.set(JSON.stringify(reference), reference)', 'references.set(JSON.stringify([reference, references.size]), reference)']
} as const
const mutation = process.env.MOTE_ORIGINAL_WORK_MUTANT as keyof typeof variants | undefined
if (mutation && !variants[mutation]) throw Error('Choose an exact original-work mutation')
export default defineConfig({ ...source, plugins: [...(source.plugins ?? []), {
  name: 'original-work-navigation-source', enforce: 'pre', transform(original, id) {
    const path = relative(source.root!, id.split('?')[0]!)
    if (!path.startsWith('apps/desktop/src/renderer/src/')) return
    let loaded = original
    const change = mutation && variants[mutation]
    if (change && path.endsWith('/' + change[0])) {
      if (original.split(change[1]).length !== 2) throw Error('The original-work mutation must match one production anchor')
      loaded = original.replace(change[1], change[2])
    }
    if (process.env.MOTE_ORIGINAL_WORK_LOADED) {
      const hash = (text: string) => createHash('sha256').update(text).digest('hex')
      appendFileSync(process.env.MOTE_ORIGINAL_WORK_LOADED, JSON.stringify({ path, originalSHA256: hash(original), loadedSHA256: hash(loaded),
        ...(loaded === original ? {} : { mutation }) }) + '\n')
    }
    return loaded === original ? undefined : { code: loaded, map: null }
  }
}], test: { ...source.test, include: ['apps/desktop/test/mote-thread-original-navigation.test.tsx', 'apps/desktop/test/mote-thread-location-label.test.tsx'], passWithNoTests: false } })
