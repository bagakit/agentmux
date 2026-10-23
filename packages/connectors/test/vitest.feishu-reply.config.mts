import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..'), mutant = process.env.FEISHU_REPLY_MUTANT
const mutations: Record<string, { path: string; before: string; after: string }> = {
  work: { path: 'packages/connectors/src/adapters/feishu/reply-card.ts', before: 'previous = low', after: 'previous = 0' },
  markdown: { path: 'packages/connectors/src/adapters/feishu/reply-card.ts', before: "tag: 'markdown', content: markdown(text, root.children.filter(child => child.position!.start.offset! >= cursor), cursor)", after: "tag: 'div', text: { tag: 'plain_text', content: after }" },
  table: { path: 'packages/connectors/src/adapters/feishu/reply-card.ts', before: 'elements.push(table(text, node));', after: "elements.push({ tag: 'markdown', content: source(text, node) });" },
  wiring: { path: 'packages/connectors/src/publication-host.ts', before: '...(adapter.fragmentText ? { fragmentText: payload => adapter.fragmentText!(payload, binding) } : {}),', after: '' },
  budget: { path: 'packages/connectors/src/adapters/feishu/publication.ts', before: "<= FEISHU_MESSAGE_BODY_BYTES\n    }", after: "<= 256 * 1024\n    }" },
  recovery: { path: 'packages/connectors/src/publication-host.ts', before: ', adapter.fragmentText ? payload => adapter.fragmentText!(payload, binding) : undefined)', after: ')' },
  prior: { path: 'packages/connectors/src/adapters/feishu/publication.ts', before: "readonly supportedRenderVersions = ['feishu-post-group-v1', 'feishu-group-v2', 'feishu-conversation-v3', this.renderVersion]", after: "readonly supportedRenderVersions = ['feishu-post-group-v1', 'feishu-group-v2', this.renderVersion]" },
  quote: { path: 'packages/connectors/src/adapters/feishu/reply-card.ts', before: "value: codeSpan(source(text, node))", after: 'value: source(text, node)' }
}
if (mutant && !mutations[mutant]) throw Error('Unknown Feishu reply mutation')
const marker = process.env.FEISHU_REPLY_LOADED
const connectorDependency = createRequire(resolve(root, 'packages/connectors/package.json'))
// Every affected Core/Channel owner is resolved to source. Runtime markers below
// prove execution; a stale dist package cannot stand in for this candidate.
export default defineConfig({ root, cacheDir: resolve(root, '.cache/feishu-reply'), define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  resolve: { alias: ['@larksuiteoapi/node-sdk', '@discordjs/rest'].map(find => ({ find, replacement: connectorDependency.resolve(find) })) },
  plugins: [{ name: 'loaded-native-feishu-reply', enforce: 'pre', transform(input, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^(?:apps\/(?:desktop|mobile)\/src\/|packages\/(?:connectors|core)\/src\/)/u.test(path) || !/\.[cm]?[jt]sx?$/u.test(path)) return
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
    include: ['packages/connectors/test/feishu-reply-card-consumer.test.ts', 'packages/connectors/test/feishu-publication.test.ts', 'packages/connectors/test/publication-isolation-consumer.test.ts'], testTimeout: 30000 }
})
