import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { candidateAlias, candidateModule } from '../../../apps/desktop/scripts/candidate-package-resolve.mjs'

const root = resolve(import.meta.dirname, '../../..')
export const mutations: Record<string, { owner: string; from: string; to: string }> = {
  'native-upper-ignored': { owner: 'packages/core/src/native-jsonl-history-reader.ts',
    from: 'if (context.through !== undefined) await reader.limitChanges(context.through)',
    to: 'if (false && context.through !== undefined) await reader.limitChanges(context.through)' },
  'core-native-upper-dropped': { owner: 'packages/core/src/conversation-reader.ts',
    from: 'port.nativeChanges(cut.checkpoint, limit, upper?.kind === \'native\' ? upper.checkpoint : undefined)',
    to: 'port.nativeChanges(cut.checkpoint, limit)' },
  'captured-upper-ignored': { owner: 'packages/core/src/conversation-reader.ts',
    from: "const current = upper?.kind === 'captured' ? {...currentRead,stream:{...currentRead.stream,sequence:upper.sequence,...(upper.inputJournal ? {inputJournal:upper.inputJournal} : {})}} : currentRead",
    to: 'const current = currentRead' },
  'continuation-upper-unchecked': { owner: 'packages/core/src/conversation-reader.ts',
    from: "if (mode === 'changes' && !same(state.through, (input as ConversationChangesInput).through)) return fail('The continuation changed its original upper frontier.')",
    to: 'void 0 /* loaded mutation: continuation upper guard removed */' },
  'upper-source-scope-unchecked': { owner: 'packages/core/src/conversation-reader.ts',
    from: "if (through && !same(through.frontier.scope, checkpoint.scope)) return fail('The upper frontier belongs to another original source scope.')",
    to: 'void 0 /* loaded mutation: source scope guard removed */' },
  'sdk-upper-identity-unchecked': { owner: 'packages/core/src/client.ts',
    from: 'if(input.through){parseConversationCheckpoint(input.through,input);parseConversationFrontier(input.through.frontier,owner.reference)}',
    to: 'void 0 /* loaded mutation: SDK upper identity guard removed */' }
}
const selected = process.env.AGENTMUX_BOUNDED_MUTATION ?? ''
if (selected && !Object.hasOwn(mutations, selected)) throw Error('Unknown bounded source mutation: ' + selected)
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ root, cacheDir: resolve(root, '.cache/native-bounded-changes'),
  resolve: { alias: [candidateAlias(root, { source: true })] },
  plugins: [{ name: 'bounded-production-loaded-source', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!
    if (!isAbsolute(file) || id.includes('?') || !/\.[cm]?[jt]s$/u.test(file)) return
    const actual = candidateModule(root, file)
    if (!actual.startsWith(root + '/packages/core/src/')) return
    const path = relative(root, actual), mutation = selected ? mutations[selected] : undefined
    let loaded = source
    const applied = mutation?.owner === path
    if (mutation && applied) {
      if (source.split(mutation.from).length !== 2) throw Error('Bounded mutation requires exactly one original executable site: ' + selected)
      loaded = source.replace(mutation.from, mutation.to)
    }
    const fact = { path, fileSHA256: sha(readFileSync(actual)), originalSHA256: sha(source), loadedSHA256: sha(loaded), mutation: applied ? selected : null }
    const log = process.env.AGENTMUX_BOUNDED_LOADED
    if (log) appendFileSync(log, JSON.stringify({ ...fact, stage: 'loaded' }) + '\n')
    if (!log) return applied ? loaded : undefined
    return { code: loaded + '\nimport { appendFileSync as __amxBoundedAppend } from "node:fs";\n' +
      '__amxBoundedAppend(' + JSON.stringify(log) + ', ' + JSON.stringify(JSON.stringify({ ...fact, stage: 'evaluated' }) + '\n') + ');\n', map: null }
  } }],
  test: { environment: 'node', include: ['packages/core/test/native-bounded-changes.test.ts'], fileParallelism: false,
    maxWorkers: 1, testTimeout: 20_000, passWithNoTests: false, server: { deps: { inline: [/^@agentmux\//u] } } }
})
