import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import source from './agent-promotion-ui.config.mts'

const variants = {
  'clubs-entry-disconnected': ['components/settings/TopicDirectorySettingsPane.tsx', 'onClose(); requestPmoTeamsTopicFloatingOpen()', 'onClose()'],
  'topic-original-operation-replaced': ['components/TopicPromotionDialog.tsx', "setReceipt(result.promotion); setPhase('ready')", "operation.current = mintObjectId(); setReceipt(result.promotion); setPhase('ready')"],
  'topic-club-action-hidden': ['components/TopicContextMenu.tsx', "'Promote to Mote Club…'", "'Promote to Mote…'"]
} as const
const mutation = process.env.PROMOTION_CLUB_MUTANT as keyof typeof variants | undefined
if (mutation && !variants[mutation]) throw Error('Choose an exact Club-surface mutation')
export default defineConfig({ ...source, plugins: [...(source.plugins ?? []), {
  name: 'promotion-club-surfaces-source', enforce: 'pre', transform(original, id) {
    const path = relative(source.root!, id.split('?')[0]!)
    if (!path.startsWith('apps/desktop/src/renderer/src/')) return
    let loaded = original
    const change = mutation && variants[mutation]
    if (change && path.endsWith('/' + change[0])) {
      if (original.split(change[1]).length !== 2) throw Error('The Club-surface mutation must match one production anchor')
      loaded = original.replace(change[1], change[2])
    }
    if (process.env.PROMOTION_CLUB_LOADED) {
      const hash = (text: string) => createHash('sha256').update(text).digest('hex')
      appendFileSync(process.env.PROMOTION_CLUB_LOADED, JSON.stringify({ path, originalSHA256: hash(original), loadedSHA256: hash(loaded),
        ...(loaded === original ? {} : { mutation }) }) + '\n')
    }
    return loaded === original ? undefined : { code: loaded, map: null }
  }
}], test: { ...source.test, include: ['apps/desktop/test/promotion-club-surfaces.test.tsx'], passWithNoTests: false } })
