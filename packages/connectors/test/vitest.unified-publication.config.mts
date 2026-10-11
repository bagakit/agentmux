import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import ts from 'typescript'
import original from '../../../vitest.config.ts'
const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_PUBLICATION_MUTANT
const mutations: Record<string, { path: string; before: string; after: string }> = {
  'bypass-backend-window': { path: 'packages/connectors/src/publication-host.ts', before: 'limit: 100, ...(state.cursor ? { cursor: state.cursor } : {}), ...(lane.view ? { view: lane.view } : {})', after: 'limit: 100, ...(state.cursor ? { cursor: state.cursor } : {})' },
  'forget-retained-parts': { path: 'packages/connectors/src/publication-store.ts', before: 'this.queueRepresentation(boundary, projectionId, unit, materialized, options.fragmentBytes ?? 4096)', after: 'this.queueRepresentation(boundary, projectionId, unit, plan, options.fragmentBytes ?? 4096)' },
  'forget-retained-relation': { path: 'packages/connectors/src/publication-store.ts', before: 'if (prior.some(row => { const intent = JSON.parse(String(row.decision_json)) as RepresentationIntent; return intent.text && !qualified(intent.projectionId) })) ambiguous.add(record.id)', after: 'if (false) ambiguous.add(record.id)' },
  'replay-unknown-effect': { path: 'packages/connectors/src/publication-store.ts', before: ': { ...retained, state: result.state, reason: result.reason, receipt: result }', after: ": { ...retained, state: result.state === 'unknown' ? 'pending' : result.state, reason: result.reason, receipt: result }" },
  'clear-empty-source-gap': { path: 'packages/connectors/src/publication-store.ts', before: 'if (targetRead || sourceRecovered)', after: 'if (d.sourceKey === key)' },
  'trust-author-without-input': { path: 'packages/connectors/src/publication-store.ts', before: " || item.inputRef?.kind !== 'message'", after: '' },
  'broaden-native-consent': { path: 'packages/connectors/src/publication-content.ts', before: "const narrow = binding.scope.publication === 'future-native-user-facing'", after: 'const narrow = false' },
  'omit-original-input-ref': { path: 'packages/core/src/client.ts', before: "        ...(source === 'user' && delivery.inputRef ? { inputRef: delivery.inputRef } : {}),", after: '' },
  'retain-ref-after-content-update': { path: 'packages/core/src/session-timeline-reducer.ts', before: 'publicContent: _publicContent, inputRef: _inputRef, ...unqualified', after: 'publicContent: _publicContent, ...unqualified' },
  'leak-record-source-into-provider': { path: 'packages/core/src/client.ts', before: 'source: originalSource, recordId, signal: controller.signal', after: 'source, recordId, signal: controller.signal' }
}
if (mutation && !mutations[mutation]) throw Error('Unknown publication source mutant')
const clientExports = JSON.parse(readFileSync(resolve(root, 'packages/client-ui/package.json'), 'utf8')).exports as Record<string, { browser?: string }>
const clientAliases = Object.entries(clientExports).filter(([, value]) => value.browser).sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length).map(([key, value]) => ({
  find: new RegExp('^@agentmux/client-ui' + (key === '.' ? '' : key.slice(1).replace('*', '(.*)')) + '$', 'u'),
  replacement: resolve(root, 'packages/client-ui', value.browser!.replace('*', '$1'))
}))
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.cache/unified-publication'),
  resolve: { alias: [
    { find: /^@agentmux\/connectors$/u, replacement: resolve(root, 'packages/connectors/src/index.ts') },
    { find: /^@agentmux\/connectors\/feishu$/u, replacement: resolve(root, 'packages/connectors/src/adapters/feishu/index.ts') },
    ...clientAliases
  ] },
  plugins: [{ name: 'actual-publication-owner-loaded', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    const compiledCore = path === 'packages/core/dist/client.js' || path === 'packages/core/dist/session-timeline-reducer.js'
    const sourcePath = compiledCore ? path.replace('/dist/', '/src/').replace(/\.js$/u, '.ts') : path
    if (!compiledCore && (!path.startsWith('packages/connectors/src/') || !/\.ts$/u.test(path))) return
    let source = compiledCore ? readFileSync(resolve(root, sourcePath), 'utf8') : code
    const originalSHA256 = createHash('sha256').update(source).digest('hex'), selected = mutation ? mutations[mutation]! : undefined
    if (selected?.path === sourcePath) {
      if (source.split(selected.before).length !== 2) throw Error('Source mutant anchor is missing or ambiguous: ' + mutation)
      source = source.replace(selected.before, selected.after)
      if (mutation === 'trust-author-without-input') source = source.replace('item.inputRef.agentSessionId !== ingress.input.agentSessionId || item.inputRef.messageId !== ingress.input.messageId || !same(item.inputRef.expectedRun, ingress.input.expectedRun) || ', '')
    }
    const sha256 = createHash('sha256').update(source).digest('hex')
    if (process.env.AGENTMUX_PUBLICATION_LOADED) appendFileSync(process.env.AGENTMUX_PUBLICATION_LOADED, JSON.stringify({ path: sourcePath, servedPath: path, originalSHA256, sha256, mutation: selected?.path === sourcePath ? mutation : null }) + '\n')
    if (originalSHA256 !== sha256) return { code: compiledCore ? ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext } }).outputText : source, map: null }
  } }], test: { ...original.test, globalSetup: [], fileParallelism: false, passWithNoTests: false,
    include: ['packages/connectors/test/{unified-publication,publication-worker-consumer,durable-publication,conversation-sharing-scope,feishu-publication-consumer,feishu-publication,room-binding}.test.ts', 'packages/core/test/conversation-resource-anchor.test.ts'] } })
