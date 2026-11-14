import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import ts from 'typescript'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../..')
const owner = 'packages/connectors/src/mote-chat.ts'
const mutations: Record<string, { path: string; changes: Array<[string, string]> }> = {
  'duplicate-admission': { path: owner, changes: [['if (saved) {', 'if (false && saved) {'], ['if (duplicate) {', 'if (false && duplicate) {']] },
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
  'skip-new-binding-publication': { path: 'packages/connectors/src/connection-services.ts', changes: [['if (binding) publication?.refresh()', 'if (false && binding) publication?.refresh()']] },
  'require-native-creator': { path: 'packages/core/src/mote/chat-codec.ts', changes: [['if (creator && (!values.connection || JSON.stringify(creator.application) !== JSON.stringify(values.connection.application)))', 'if (values.enabled && !creator || creator && (!values.connection || JSON.stringify(creator.application) !== JSON.stringify(values.connection.application)))']] },
  'discard-retained-creator': { path: owner, changes: [['let creator = same(current?.values.connection?.application, input.values.connection?.application) ? current?.creator ?? null : null', 'let creator = null']] },
  'skip-person-qualification': { path: owner, changes: [['if (existing?.person.creator === creator) return existing', 'if (existing) return existing']] },
  'skip-audience-qualification': { path: owner, changes: [['const current = configuration ? this.person(configuration, row.person.actor, row) : row', 'const current = row']] },
  'skip-allocation-qualification': { path: owner, changes: [['const qualified = this.person(configuration, input.actor, row)', 'const qualified = row']] },
  'reset-qualified-usage': { path: owner, changes: [['used = existing?.person.used ?? 0', 'used = 0']] },
  'feishu-direct-is-group': { path: 'packages/connectors/src/adapters/feishu/message.ts', changes: [["message.chat_type === 'p2p' ? 'direct' : 'group'", "'group'"]] },
  'discord-direct-is-group': { path: 'packages/connectors/src/adapters/discord/protocol.ts', changes: [["'guild_id' in message && message.guild_id ? 'group' : 'direct'", "'group'"]] },
  'telegram-direct-is-group': { path: 'packages/connectors/src/adapters/telegram/protocol.ts', changes: [["message.chat.type === 'private' ? 'direct' : 'group'", "'group'"]] },
  'ordinary-policy-online': { path: owner, changes: [['if (input.refreshCreator) {', 'if (input.refreshCreator || current && input.values.enabled) {']] },
  'discard-refresh-action': { path: 'packages/core/src/mote/chat-codec.ts', changes: [['...(p.refreshCreator === true ? { refreshCreator: true as const } : {})', '...{}']] },
  'accept-unqualified-refresh': { path: owner, changes: [['if (!observation?.creator) fail(', 'if (false && !observation?.creator) fail('], ['creator = parseConnectionActor({ application: ref.application, ...observation.creator })', 'creator = observation?.creator ? parseConnectionActor({ application: ref.application, ...observation.creator }) : creator']] },
  'skip-stale-refresh-cas': { path: owner, changes: [['if ((actual?.revision ?? null) !== input.expectedRevision)', 'if (!input.refreshCreator && (actual?.revision ?? null) !== input.expectedRevision)']] },
  'guest-selected-alias-revokes-admission': { path: owner, changes: [['same(a!.actor, actor) && this.active(row)', 'same(a!.actor, actor) && this.active(row) && this.store.configuration(row.generation.target.spaceId)?.values.connection?.connectionId === row.connectionId']] },
  'main-selected-alias-revokes-admission': { path: owner, changes: [['same(current.creator, admission.actor) &&', 'current.values.connection?.connectionId === admission.binding.connectionId && same(current.creator, admission.actor) &&']] },
  'accept-null-refresh-result': { path: 'packages/core/src/mote/chat-codec.ts', changes: [["if (i && 'refreshCreator' in i && i.refreshCreator === true && o.configuration.creator === null) fail(code)", '']] }
}
const mutation = process.env.AGENTMUX_MOTE_CHAT_MUTANT
if (mutation && !mutations[mutation]) throw new Error('Unknown Mote chat mutation')
const selected = mutation ? mutations[mutation]! : undefined
const suite = process.env.AGENTMUX_MOTE_CHAT_SUITE ?? 'all'
if (!['owner', 'journey', 'native', 'provider', 'restart', 'main', 'all'].includes(suite)) throw new Error('Unknown Mote chat test suite')
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ ...original, root,
  cacheDir: resolve(root, '.local/mote-direct-chat/vitest-cache', mutation ?? 'original'),
  plugins: [{ name: 'mote-chat-original-consumer-mutation', enforce: 'pre', resolveId(source, importer) {
    if (source === '@agentmux/core') return resolve(root, 'packages/core/src/index.ts')
    if (source === '@agentmux/connectors') return resolve(root, 'packages/connectors/src/index.ts')
    for (const [prefix, directory] of [['@agentmux/core/', 'packages/core'], ['@agentmux/host/', 'apps/host']]) if (source.startsWith(prefix!)) {
      const entry = JSON.parse(readFileSync(resolve(root, directory!, 'package.json'), 'utf8')).exports['./' + source.slice(prefix!.length)]?.import as string | undefined
      if (entry?.startsWith('./dist/')) return resolve(root, directory!, 'src', entry.slice('./dist/'.length).replace(/\.js$/u, '.ts'))
    }
    if (!importer || !source.startsWith('.')) return
    const match = resolve(dirname(importer), source).match(/\/packages\/(core|connectors)\/dist\/(.+)\.js$/u)
    if (match) return resolve(root, 'packages', match[1]!, 'src', match[2]! + '.ts')
  }, transform(code, id) {
    const servedPath = relative(root, id.split('?')[0]!)
    const sourcePath = servedPath.startsWith('packages/connectors/dist/') ? servedPath.replace('/dist/', '/src/').replace(/\.js$/u, '.ts') : servedPath
    if (![owner, 'packages/core/src/mote/chat-codec.ts', 'packages/connectors/src/durable-ingress.ts', 'packages/connectors/src/connection-services.ts', ...(selected ? [selected.path] : [])].includes(sourcePath)) return
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
  test: { ...original.test, globalSetup: [], fileParallelism: false, maxWorkers: 1, passWithNoTests: false,
    include: [
      ...(['owner', 'all'].includes(suite) ? ['packages/connectors/test/mote-chat-owner.test.ts'] : []),
      ...(['journey', 'all'].includes(suite) ? ['packages/connectors/test/mote-chat-desktop-journey.integration.test.ts'] : []),
      ...(['native', 'all'].includes(suite) ? ['packages/connectors/test/mote-chat-native-journey.integration.test.ts'] : []),
      ...(suite === 'provider' ? ['packages/core/test/claude-native-input.test.ts'] : []),
      ...(suite === 'restart' ? ['packages/connectors/test/mote-chat-core-reopen.integration.test.ts'] : []),
      ...(suite === 'main' ? ['packages/connectors/test/mote-chat-main-alias.integration.test.ts'] : [])
    ] }
})
