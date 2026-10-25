import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..'), mutant = process.env.REPLY_METADATA_MUTANT
const mutations: Record<string, { path: string; before: string; after: string }> = {
  turn: { path: 'packages/connectors/src/publication-reply-metadata.ts', before: 'JSON.stringify([...source, record.original.item.turnId])', after: 'JSON.stringify(source)' },
  response: { path: 'packages/connectors/src/publication-reply-metadata.ts', before: "fact.recordKey === projection.recordKey && fact.revision === projection.revision && fact.metrics?.scope === 'response'", after: "fact.metrics?.scope === 'response'" },
  sum: { path: 'packages/connectors/src/publication-reply-metadata.ts', before: 'usage: usageFact.metrics!.usage!', after: 'usage: { ...usageFact.metrics!.usage!, outputTokens: turns.reduce((sum, fact) => sum + (fact.metrics?.usage?.outputTokens ?? 0), 0) }' },
  wiring: { path: 'packages/connectors/src/publication-store.ts', before: 'withReplyMetadata(payload, metadata)', after: 'withReplyMetadata(payload, undefined)' },
  late: { path: 'packages/connectors/src/publication-store.ts', before: 'for (const projectionId of replyProjections) this.refreshReplyMetadata(boundary, projectionId, options.fragmentText)', after: 'for (const projectionId of []) this.refreshReplyMetadata(boundary, projectionId, options.fragmentText)' },
  fragment: { path: 'packages/connectors/src/publication-store.ts', before: 'index !== selected.length - 1 || payload.replyMetadata === undefined', after: 'payload.replyMetadata === undefined' },
  unknown: { path: 'packages/connectors/src/publication-store.ts', before: 'if (metadataOnly && frozenOriginal) return', after: 'if (false) return' },
  'cancelled-recovery': { path: 'packages/connectors/src/publication-store.ts', before: 'if (metadataOnly && frozenOriginal) return', after: "if (latest.length === parts.length && latest.some(operation => operation.state !== 'confirmed') && latest.every((operation, index) => operation.effect === 'upsert' && same(withoutMetadata(operation.payload), withoutMetadata(parts[index]!)))) return" },
  frozen: { path: 'packages/connectors/src/publication-store.ts', before: 'if (!prior && exists) return', after: 'if (false) return' },
  avatar: { path: 'packages/connectors/src/publication-store.ts', before: 'if (original.avatarSource) operation.avatarSource = original.avatarSource', after: 'if (false) operation.avatarSource = original.avatarSource' },
  source: { path: 'packages/connectors/src/publication-reply-metadata.ts', before: 'reference.source.providerId, reference.source.nativeSessionId', after: "'shared-source'" },
  order: { path: 'packages/connectors/src/publication-reply-metadata.ts', before: 'a.order!.indexInPage - b.order!.indexInPage', after: '0' },
  footer: { path: 'packages/connectors/src/adapters/feishu/role-card.ts', before: 'if (options.replyMetadata) body.elements.push(...feishuReplyFooter(options.replyMetadata))', after: '' },
  'footer-budget': { path: 'packages/connectors/src/adapters/feishu/publication.ts', before: 'replyMetadata: feishuReplyFooterBudget(payload.replyMetadata)', after: 'replyMetadata: undefined' }
}
if (mutant && !mutations[mutant]) throw Error('Unknown Feishu reply mutation')
const marker = process.env.REPLY_METADATA_LOADED
const connectorDependency = createRequire(resolve(root, 'packages/connectors/package.json'))
// Every affected Core/Channel owner is resolved to source. Runtime markers below
// prove execution; a stale dist package cannot stand in for this candidate.
export default defineConfig({ root, cacheDir: resolve(root, '.cache/reply-metadata'), define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  resolve: { alias: ['@larksuiteoapi/node-sdk', '@discordjs/rest'].map(find => ({ find, replacement: connectorDependency.resolve(find) })) },
  plugins: [{ name: 'loaded-reply-metadata', enforce: 'pre', transform(input, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^(?:apps\/(?:desktop|mobile)\/src\/|packages\/(?:connectors|core)\/(?:src|test)\/)/u.test(path) || !/\.[cm]?[jt]sx?$/u.test(path)) return
    let output = input
    const selected = mutant ? mutations[mutant] : undefined
    if (selected?.path === path) {
      if (input.split(selected.before).length !== 2) throw Error('Feishu reply mutation owner changed')
      output = input.replace(selected.before, selected.after)
    }
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    if (!marker) return input === output ? undefined : { code: output, map: null }
    const row = JSON.stringify({ path, originalSHA256: sha(input), loadedSHA256: sha(output), mutation: input === output ? null : mutant })
    return { code: "import { appendFileSync as __markUserCard } from 'node:fs'; __markUserCard(" + JSON.stringify(marker) + ', ' + JSON.stringify(row + '\n') + ');\n' + output, map: null }
  }, resolveId(source, importer) {
    if (source === '@agentmux/core') return resolve(root, 'packages/core/src/index.ts')
    if (source === '@agentmux/connectors') return resolve(root, 'packages/connectors/src/index.ts')
    if (source.startsWith('@agentmux/core/') || source.startsWith('@agentmux/connectors/')) {
      const pkg = source.startsWith('@agentmux/core/') ? 'core' : 'connectors'
      const exports = JSON.parse(readFileSync(resolve(root, 'packages', pkg, 'package.json'), 'utf8')).exports
      const entry = exports['./' + source.slice(('@agentmux/' + pkg + '/').length)]?.import as string | undefined
      if (entry?.startsWith('./dist/')) return resolve(root, 'packages', pkg, 'src', entry.slice('./dist/'.length).replace(/\.js$/u, '.ts'))
    }
    if (!importer || !source.startsWith('.')) return
    const match = resolve(dirname(importer), source).match(/\/packages\/(core|connectors)\/dist\/(.+)\.js$/u)
    if (match) return resolve(root, 'packages', match[1]!, 'src', match[2]! + '.ts')
  } }], test: { environment: 'node', setupFiles: [resolve(root, 'vitest.setup.ts')], globalSetup: [], passWithNoTests: false, fileParallelism: false,
    include: ['packages/connectors/test/publication-reply-metadata-consumer.test.ts', 'packages/connectors/test/publication-reply-metadata.test.ts', 'packages/connectors/test/feishu-reply-footer.test.ts'], testTimeout: 30000 }
})
