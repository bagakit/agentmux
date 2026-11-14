import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './mote-object-navigation.config.mts'
const variants = {
  'address-as-local-space': ['target.spaceId === undefined ? null : ', ''],
  'wrong-open': ["onOpen={() => void api.ui.openObjectLink(uri)", "onOpen={() => void api.ui.openObjectLink(target.spaceId)"],
  'borrow-identity': ["if (address?.spaceId !== spaceId) return []", "if (false && address?.spaceId !== spaceId) return []"],
  'drop-event': ["revision.version : undefined, selection)", "revision.version : undefined)"],
  'copy-id': ["copyTextToClipboard(uri,", "copyTextToClipboard(target.spaceId,"]
} as const
const mutation = process.env.MOTE_REFERENCE_MUTATION as keyof typeof variants | undefined
if (mutation && !variants[mutation]) throw new Error('Unknown Mote reference mutation')
export default defineConfig({ ...base, plugins: [...base.plugins ?? [], {
  name: 'mote-reference-production-source', enforce: 'pre', transform(source, id) {
    if (!id.split('?')[0]!.endsWith('/components/MoteReference.tsx')) return
    let candidate = source
    if (mutation) {
      const [before, after] = variants[mutation]
      if (source.split(before).length !== 2) throw new Error('Missing or ambiguous current Mote reference mutation')
      candidate = source.replace(before, after)
    }
    if (process.env.MOTE_REFERENCE_LOADED) {
      const sha = (text: string) => createHash('sha256').update(text).digest('hex')
      appendFileSync(process.env.MOTE_REFERENCE_LOADED, JSON.stringify({ path: relative(base.root!, id.split('?')[0]!), originalSHA256: sha(source), loadedSHA256: sha(candidate), mutation: candidate === source ? null : mutation }) + '\n')
    }
    if (candidate !== source) return { code: candidate, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/mote-reference.test.tsx'], passWithNoTests: false } })
