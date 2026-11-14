import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const variants = {
  canonical: ['packages/core/src/sharing.ts', 'if (formatAmuxObjectLink(target) !== raw)', 'if (false && formatAmuxObjectLink(target) !== raw)'],
  'event-identity': ['packages/core/src/sharing.ts', 'eventId: decodeURIComponent(match[3])', 'eventId: id'],
  'mote-kind': ['packages/core/src/search-metadata.ts', "if (space.kind === 'mote') add(fact.mote, space.spaceId)", 'add(fact.mote, space.spaceId)']
} as const
const mutation = process.env.MOTE_LINK_MUTATION as keyof typeof variants | undefined
if (mutation && !variants[mutation]) throw new Error('Unknown Mote object link mutation')
export default defineConfig({ root, plugins: [{ name: 'mote-object-link-owner', enforce: 'pre', transform(source, id) {
  const path = relative(root, id.split('?')[0]!)
  const variant = mutation && variants[mutation]
  let candidate = source
  if (variant && path === variant[0]) {
    if (source.split(variant[1]).length !== 2) throw new Error('Missing or ambiguous Mote link mutation anchor')
    candidate = source.replace(variant[1], variant[2])
  }
  if (process.env.MOTE_LINK_LOADED && path.startsWith('packages/core/src/')) {
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    appendFileSync(process.env.MOTE_LINK_LOADED, JSON.stringify({ path, originalSHA256: sha(source), loadedSHA256: sha(candidate), mutation: candidate === source ? null : mutation }) + '\n')
  }
  if (candidate !== source) return { code: candidate, map: null }
} }], test: { include: ['packages/core/test/sharing.test.ts', 'packages/core/test/search-metadata.test.ts'],
  passWithNoTests: false, maxWorkers: 1 } })
