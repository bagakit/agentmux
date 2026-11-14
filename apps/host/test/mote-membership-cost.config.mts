import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import base from '../../../packages/connectors/test/vitest.mote-chat-perception.config.mts'

const variants: Record<string, [string, string, string]> = {
  'stale-file': ['packages/core/src/spatial-state.ts', 'if (!selected || selected.stamp !== stamp)', 'if (!selected)'],
  'rebuild-warm': ['packages/core/src/spatial-state.ts', 'if (!selected || selected.stamp !== stamp)', 'if (true)'],
  'host-disconnected': ['apps/host/src/mote-membership.ts', "return membership.spaceKind === 'mote' && membership.member", 'return false']
}
const name = process.env.MOTE_MEMBERSHIP_MUTANT
if (name && !variants[name]) throw Error('Unknown membership mutation')
export default defineConfig({ ...base, plugins: [...base.plugins ?? [], {
  name: 'loaded-space-membership-cost', enforce: 'pre', transform(original, id) {
    const path = relative(base.root!, id.split('?')[0]!), variant = name ? variants[name] : undefined
    if (!['packages/core/src/spatial-state.ts', 'apps/host/src/mote-membership.ts'].includes(path)) return
    let loaded = original
    if (variant?.[0] === path) {
      if (original.split(variant[1]).length !== 2) throw Error('Expected one exact membership source anchor')
      loaded = original.replace(variant[1], variant[2])
    }
    if (process.env.MOTE_MEMBERSHIP_TRACE) {
      const sha = (text: string) => createHash('sha256').update(text).digest('hex')
      appendFileSync(process.env.MOTE_MEMBERSHIP_TRACE, JSON.stringify({ path, originalSHA256: sha(original), loadedSHA256: sha(loaded), ...(loaded !== original ? { mutation: name } : {}) }) + '\n')
    }
    if (loaded !== original) return { code: loaded, map: null }
  }
}], test: { ...base.test, include: [...base.test!.include!, 'packages/core/test/spatial-agent-membership.test.ts'] } })
