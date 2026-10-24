import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import ts from 'typescript'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../..')
const owner = 'packages/connectors/src/mote-chat.ts'
const mutations: Record<string, { path: string; changes: Array<[string, string]> }> = {
  'duplicate-admission': { path: owner, changes: [['if (saved) {', 'if (false && saved) {'], ['if (duplicate) return { generationId: duplicate.generationId }', 'if (false && duplicate) return { generationId: duplicate.generationId }']] },
  'strict-rollover': { path: owner, changes: [['elapsed > current.values.conversationIdleMs', 'elapsed >= current.values.conversationIdleMs']] },
  'required-history': { path: owner, changes: [['recent.length ? recent.map(g =>', 'recent.length ? recent.slice(0, 0).map(g =>']] },
  'original-create-recovery': { path: owner, changes: [['if (row.dispatched) result = await this.options.agents.inspect', 'if (false && row.dispatched) result = await this.options.agents.inspect']] },
  'last-quota-unit': { path: owner, changes: [['person.person.used >= person.person.total!', 'person.person.used + 1 >= person.person.total!']] },
  'background-execution': { path: owner, changes: [['if (result.executionHostId !== row.generation.executionHostId || result.agentSessionId !== row.generation.agentSessionId)', 'if (result.executionHostId !== row.generation.executionHostId || result.agentSessionId !== row.generation.agentSessionId || !result.regionId)']] },
  'observed-activity-gate': { path: owner, changes: [["row.generation.phase === 'ready' && elapsed >", "row.generation.phase === 'ready' && activity !== null && elapsed >"]] },
  'skip-allocation-revalidation': { path: owner, changes: [["    await context.assertCurrent?.()\n    const intent = encode({ method: 'allocate', input, actor: context.actor })", "    const intent = encode({ method: 'allocate', input, actor: context.actor })"]] },
  'borrow-paused-private-audience': { path: owner, changes: [['findActiveAudience: input => chat.knowsAudience(input) ? chat.findActiveAudience(input) : groups.findActiveAudience(input)', 'findActiveAudience: input => chat.findActiveAudience(input) ?? groups.findActiveAudience(input)']] },
  'skip-mote-preparation': { path: 'packages/connectors/src/connection-services.ts', changes: [["if (record.conversationKind === 'direct')", 'if (false)']] },
  'retarget-frozen-authority': { path: 'packages/connectors/src/durable-ingress.ts', changes: [['const binding = expected ? this.options.bindings.readExact(expected.author.bindingId, expected.author.bindingRevision) : this.binding(record)', 'const binding = this.binding(record)']] },
  'skip-new-binding-publication': { path: 'packages/connectors/src/connection-services.ts', changes: [['if (binding) publication?.refresh()', 'if (false && binding) publication?.refresh()']] }
}
const mutation = process.env.AGENTMUX_MOTE_CHAT_MUTANT
if (mutation && !mutations[mutation]) throw new Error('Unknown Mote chat mutation')
const selected = mutation ? mutations[mutation]! : undefined
const suite = process.env.AGENTMUX_MOTE_CHAT_SUITE ?? 'all'
if (!['owner', 'journey', 'all'].includes(suite)) throw new Error('Unknown Mote chat test suite')
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ ...original, root,
  cacheDir: resolve(root, '.local/mote-direct-chat/vitest-cache', mutation ?? 'original'),
  plugins: [{ name: 'mote-chat-original-consumer-mutation', enforce: 'pre', transform(code, id) {
    const servedPath = relative(root, id.split('?')[0]!)
    const sourcePath = servedPath.startsWith('packages/connectors/dist/') ? servedPath.replace('/dist/', '/src/').replace(/\.js$/u, '.ts') : servedPath
    if (![owner, 'packages/connectors/src/durable-ingress.ts', 'packages/connectors/src/connection-services.ts'].includes(sourcePath)) return
    const compiled = sourcePath !== servedPath
    const source = compiled ? readFileSync(resolve(root, sourcePath), 'utf8') : code
    let candidate = source
    if (selected?.path === sourcePath) for (const [before, after] of selected.changes) {
      if (candidate.split(before).length !== 2) throw new Error('Missing or ambiguous Mote chat mutation anchor: ' + mutation)
      candidate = candidate.replace(before, after)
    }
    const changed = source !== candidate
    const loaded = changed && compiled ? ts.transpileModule(candidate, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext } }).outputText : changed ? candidate : code
    if (process.env.AGENTMUX_MOTE_CHAT_LOADED) appendFileSync(process.env.AGENTMUX_MOTE_CHAT_LOADED, JSON.stringify({ sourcePath, servedPath,
      originalSourceSHA256: sha(source), candidateSourceSHA256: sha(candidate), originalLoadedSHA256: sha(code), loadedSHA256: sha(loaded), mutation: changed ? mutation : null }) + '\n')
    if (changed) return { code: loaded, map: null }
  } }],
  test: { ...original.test, fileParallelism: false, passWithNoTests: false,
    include: [
      ...(suite !== 'journey' ? ['packages/connectors/test/mote-chat-owner.test.ts'] : []),
      ...(suite !== 'owner' ? ['packages/connectors/test/mote-chat-desktop-journey.integration.test.ts'] : [])
    ] }
})
