import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import original from './connection-owner-consumer.config.mts'

const root = original.root!, mutant = process.env.PUBLICATION_SPEAKER_MUTANT
const mutations = {
  'drop-generation-association': ['packages/connectors/src/connection-services.ts', 'generation?.executionHostId === reference.hostId ? generation.target : undefined', 'undefined'],
  'duplicate-avatar': ['packages/connectors/src/publication-store.ts', 'if (previous) {\n          const receipt = previous.avatarUploads!', 'if (false && previous) {\n          const receipt = previous.avatarUploads!']
} as const
if (mutant && !(mutant in mutations)) throw Error('Unknown speaker integration mutation')
export default defineConfig({ ...original, plugins: [...original.plugins!, { name: 'publication-speaker-actual-source', enforce: 'pre',
  transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^(?:apps\/host|packages\/(?:core|connectors))\/(src|test)\/.+\.[cm]?[jt]s$/u.test(path)) return
    const selected = mutations[mutant as keyof typeof mutations]
    let code = source
    if (selected?.[0] === path) {
      if (code.split(selected[1]).length !== 2) throw Error('Unique actual speaker boundary required')
      code = code.replace(selected[1], selected[2])
    }
    if (process.env.PUBLICATION_SPEAKER_LOADED) {
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      const row = { path, original: sha(source), loaded: sha(code), ...(code === source ? {} : { mutant }) }
      code = "import {appendFileSync as __speakerLoaded} from 'node:fs'; __speakerLoaded(" + JSON.stringify(process.env.PUBLICATION_SPEAKER_LOADED) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + code
    }
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...original.test, include: ['apps/host/test/publication-speaker-consumer.test.ts'],
  ...(mutant ? { testNamePattern: 'default Host freezes exact Mote' } : {}), testTimeout: 40_000 } })
