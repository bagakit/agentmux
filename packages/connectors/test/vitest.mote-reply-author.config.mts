import { defineConfig } from 'vitest/config'
import base from './vitest.mote-creator-reply.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
const variants = {
  'drop-author': ["speaker: { ...details, kind: 'agent', reference: ref(relationship) },", ''],
  'wrong-author': ["speaker: { ...details, kind: 'agent', reference: ref(relationship) },", "speaker: { ...details, kind: 'agent', reference: { ...ref(relationship), agentSessionId: 'replacement-main' } },"]
} as const
const mutant = process.env.MOTE_REPLY_AUTHOR_MUTANT as keyof typeof variants | undefined
if (mutant && !variants[mutant]) throw Error('Unknown reply-author mutation')
export default defineConfig({ ...base, plugins: [...base.plugins!, { name: 'original-reply-author-source', enforce: 'pre', transform(code, id) {
  const file = relative(base.root!, id.split('?')[0]!)
  if (!['packages/connectors/src/mote-chat.ts', 'packages/connectors/src/publication-store.ts', 'packages/connectors/src/publication-host.ts'].includes(file)) return
  let loaded = code
  if (file.endsWith('/publication-store.ts') && mutant) { const [before, after] = variants[mutant]; if (code.split(before).length !== 2) throw Error('Reply author source anchor changed'); loaded = code.replace(before, after) }
  if (process.env.MOTE_REPLY_AUTHOR_LOADED) appendFileSync(process.env.MOTE_REPLY_AUTHOR_LOADED, JSON.stringify({ file, sourceSHA256: createHash('sha256').update(code).digest('hex'), loadedSHA256: createHash('sha256').update(loaded).digest('hex'), mutant: loaded === code ? null : mutant }) + '\n')
  return loaded === code ? null : { code: loaded, map: null }
} }], test: { ...base.test, include: ['packages/connectors/test/mote-reply-author.integration.test.ts'], maxWorkers: 1, passWithNoTests: false } })
