import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './publication-speaker-consumer.config.mts'

const root = original.root!, mutant = process.env.GROUP_SPEAKER_CARD_MUTANT
const variants = {
  'drop-group-portrait': ['apps/host/src/connections.ts', 'if (!mote && original) affiliation = groupSpeakerMote(original.graph, reference)', 'if (false && !mote && original) affiliation = groupSpeakerMote(original.graph, reference)'],
  'full-size-progress': ['packages/connectors/src/adapters/feishu/role-card.ts', "const compact = options.phase === 'progress'", 'const compact = false']
} as const
if (mutant && !(mutant in variants)) throw Error('Unknown group speaker card mutation')
export default defineConfig({ ...original, cacheDir: resolve(root, '.cache/group-speaker-card'), plugins: [{
  name: 'actual-group-speaker-card-source', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^(?:apps\/host|packages\/(?:core|connectors))\/(?:src|test)\/.+\.[cm]?[jt]s$/u.test(path)) return
    let code = source
    const selected = variants[mutant as keyof typeof variants]
    if (selected?.[0] === path) {
      if (code.split(selected[1]).length !== 2) throw Error('The actual group card mutation requires one owning expression')
      code = code.replace(selected[1], selected[2])
    }
    if (process.env.GROUP_SPEAKER_CARD_LOADED) {
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      const row = { path, original: sha(source), loaded: sha(code), ...(code === source ? {} : { mutant }) }
      code = "import {appendFileSync as __groupCardLoaded} from 'node:fs'; __groupCardLoaded(" + JSON.stringify(process.env.GROUP_SPEAKER_CARD_LOADED) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + code
    }
    return code === source ? undefined : { code, map: null }
  }
}, ...original.plugins!], test: { ...original.test,
  include: ['apps/host/test/publication-speaker-consumer.test.ts', 'packages/connectors/test/feishu-role-card.test.ts', 'packages/connectors/test/feishu-publication.test.ts'],
  ...(mutant ? { testNamePattern: mutant === 'drop-group-portrait' ? 'group portraits follow the exact sender spatial relation' : 'delivers compact attributed progress' } : {})
} })
