import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, posix, relative, resolve } from 'node:path'
import ts from 'typescript'
import * as entries from '../packages/client-ui/scripts/supported-entries.mjs'

const root = resolve(import.meta.dirname, '..')
const require = createRequire(join(root, 'apps/desktop/package.json'))
const { parse: parseCss } = createRequire(require.resolve('vite/package.json'))('postcss')
const packageRoot = 'packages/client-ui'
const packageName = '@agentmux/client-ui'
const manifestPath = packageRoot + '/package.json'
const bindingPath = '.local/state/client-ui-migration/inputs.json'
const baseline = 'ce6e37c9697b'
const hosts = {
  Desktop: 'apps/desktop/src',
  Mobile: 'apps/mobile/src',
  Host: 'apps/host/src',
  'editor-extensions': 'packages/editor-extensions/src'
}
const roots = [...Object.values(hosts), packageRoot + '/src']
const sourceFile = /\.(?:[cm]?[jt]sx?|css)$/u
const retired = new Set(['.', './*', './components/*', './styles/*', './note/*', './terminal/*'])
const dataWildcards = new Set(['./brand/*', './agent-icons/*'])
const scan = process.argv.includes('--scan')
assert.ok(process.argv.slice(2).every(value => value === '--scan'), 'Use --scan for an inventory before runtime qualification')
const digest = value => createHash('sha256').update(value).digest('hex')
const git = (...arguments_) => execFileSync('git', arguments_, { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
const read = file => readFileSync(resolve(root, file), 'utf8')
const candidate = git('rev-parse', 'HEAD').trim()
const manifest = JSON.parse(read(manifestPath))
const publicSpecifier = value => value === packageName || value.startsWith(packageName + '/')

function assetOrModule(file, source) {
  if (file.endsWith('.css')) {
    const sheet = parseCss(source, { from: file })
    const edges = []
    sheet.walkAtRules('import', rule => {
      const value = /^(?:url\(\s*)?(['"])(.*?)\1/u.exec(rule.params)?.[2]
      if (value) edges.push({ value, kind: 'style' })
    })
    return { source, edges, sheet }
  }
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const edges = []
  const push = (value, kind) => {
    if (value && ts.isStringLiteralLike(value)) edges.push({ value: value.text, kind })
  }
  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause, bindings = clause?.namedBindings
      const typeOnly = clause?.isTypeOnly || clause && !clause.name && bindings && ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 && bindings.elements.every(binding => binding.isTypeOnly)
      push(node.moduleSpecifier, typeOnly ? 'type' : 'runtime')
    } else if (ts.isExportDeclaration(node)) {
      push(node.moduleSpecifier, node.isTypeOnly ? 'type' : 'runtime')
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      push(node.argument.literal, 'type')
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      push(node.arguments[0], 'runtime')
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return { source, edges }
}

function exportEntry(exports, specifier) {
  const key = specifier === packageName ? '.' : './' + specifier.slice(packageName.length + 1)
  if (Object.hasOwn(exports, key)) return { key, entry: exports[key] }
  const candidates = Object.keys(exports).filter(pattern => pattern.includes('*')).sort((a, b) => b.length - a.length)
  for (const pattern of candidates) {
    const [left, right] = pattern.split('*')
    if (key.startsWith(left) && key.endsWith(right)) {
      return { key: pattern, entry: exports[pattern], remainder: key.slice(left.length, key.length - right.length) }
    }
  }
  return { key }
}

function resolveExport(exports, file, edge, browser, historical = false) {
  const value = exportEntry(exports, edge.value)
  const condition = typeof value.entry === 'string' ? 'asset' : edge.kind === 'type' ? 'types' : browser ? 'browser' : 'import'
  const target = condition === 'asset' ? value.entry : value.entry?.[condition]
  const endpoint = 'Cannot resolve Client UI export ' + edge.value + ' from ' + file + ' with ' + condition
  assert.equal(typeof target, 'string', endpoint + ' because this export condition is absent')
  const pathFor = path => posix.normalize(packageRoot + '/' + path.replace('*', value.remainder ?? ''))
  const destination = pathFor(target)
  const owner = pathFor(typeof value.entry === 'string' ? value.entry : value.entry.browser ?? value.entry.types ?? target)
  assert.ok(owner.startsWith(packageRoot + '/') && (historical || existsSync(resolve(root, owner))), endpoint + ' because the source owner is absent: ' + owner)
  assert.ok(destination.startsWith(packageRoot + '/') && (scan || historical || existsSync(resolve(root, destination))),
    endpoint + ' because the compiled artifact is absent: ' + destination)
  return { from: file, specifier: edge.value, key: value.key, condition, destination, owner, kind: edge.kind }
}

const tracked = git('ls-files', '-z', '--', ...roots).split('\0').filter(file => sourceFile.test(file))
assert.ok(tracked.length > 0)
const entities = new Map(tracked.map(file => [file, assetOrModule(file, read(file))]))
const original = { exports: manifest.exports, entities }

function uses({ exports, entities, historical = false }) {
  const output = {}
  for (const [host, directory] of Object.entries(hosts)) {
    const edges = []
    for (const [file, record] of entities) {
      if (!file.startsWith(directory + '/')) continue
      const browser = host !== 'Host' && !(host === 'Desktop' && /\/src\/(?:main|preload)\//u.test(file))
      for (const edge of record.edges) if (publicSpecifier(edge.value)) edges.push(resolveExport(exports, file, edge, browser, historical))
    }
    assert.ok(edges.some(edge => edge.kind === 'runtime'), host + ' must have an actual production Client UI import')
    output[host] = edges
  }
  return output
}

function localModule(entities, from, specifier) {
  const path = posix.normalize(posix.join(posix.dirname(from), specifier.split('?')[0]))
  return [path, path.replace(/\.[cm]?js$/u, '.ts'), path.replace(/\.[cm]?js$/u, '.tsx'),
    path + '.ts', path + '.tsx', path + '/index.ts', path + '/index.tsx'].find(value => entities.has(value))
}

function desktopStyles({ exports, entities }) {
  const pending = ['apps/desktop/src/renderer/src/main.tsx']
  const visited = new Set()
  while (pending.length) {
    const file = pending.pop()
    if (visited.has(file)) continue
    const record = entities.get(file)
    assert.ok(record, 'The Desktop Renderer CSS graph cannot reach ' + file)
    visited.add(file)
    for (const edge of record.edges) {
      if (edge.kind === 'type') continue
      const next = edge.value.startsWith('.') ? localModule(entities, file, edge.value)
        : publicSpecifier(edge.value) ? resolveExport(exports, file, edge, true).destination : undefined
      if (next && entities.has(next)) pending.push(next)
    }
  }
  return [...visited].filter(file => file.endsWith('.css'))
}

// The input group's base selector belongs to its shared primitive. Scoped
// overrides and media states are separate rules with their own purpose.
const fieldCss = packageRoot + '/src/input/input.css'
const fieldSelector = '.ui-input-group--prompt'
const desktopCss = 'apps/desktop/src/renderer/src/styles/index.css'
function fieldOwner(graph) {
  const reachable = desktopStyles(graph)
  assert.ok(reachable.includes(fieldCss) && reachable.includes(desktopCss), 'The actual Desktop Renderer must load the shared field styles')
  const owners = reachable.filter(file => graph.entities.get(file).sheet.nodes.some(node => node.type === 'rule' && node.selector.trim() === fieldSelector))
  assert.deepEqual(owners, [fieldCss], 'A second reachable base stylesheet owns ' + fieldSelector)
  return { selector: fieldSelector, owner: fieldCss, reachable: reachable.length }
}

function mutateFile(graph, file, change) {
  const record = graph.entities.get(file)
  assert.ok(record, 'Mutation must target a real tracked product input')
  const source = change(record.source)
  assert.notEqual(source, record.source, 'Mutation must change a real product input')
  return { graph: { ...graph, entities: new Map(graph.entities).set(file, assetOrModule(file, source)) },
    hashes: { file, before: digest(record.source), after: digest(source) } }
}

const consumers = uses(original)
const css = fieldOwner(original)
const reference = 'apps/mobile/src/conversation/MobileConversationSurface.tsx'
const originalSpecifier = '@agentmux/client-ui/platform'
const disconnectedSpecifier = '@agentmux/client-ui/retired-consumer-entry'
assert.ok(consumers.Mobile.some(edge => edge.from === reference && edge.specifier === originalSpecifier && edge.kind === 'runtime'))
const disconnected = mutateFile(original, reference, source => source.replace(originalSpecifier, disconnectedSpecifier))
assert.throws(() => uses(disconnected.graph), error => error instanceof assert.AssertionError &&
  error.message.includes('Cannot resolve Client UI export ' + disconnectedSpecifier + ' from ' + reference))
const rule = entities.get(fieldCss).sheet.nodes.find(node => node.type === 'rule' && node.selector === fieldSelector)
const duplicated = mutateFile(original, desktopCss, source => source + '\n' + rule.toString() + '\n')
assert.throws(() => fieldOwner(duplicated.graph), error => error instanceof assert.AssertionError &&
  error.message.includes('A second reachable base stylesheet') && error.actual.includes(desktopCss))
assert.deepEqual(uses(original), consumers)
assert.deepEqual(fieldOwner(original), css)

const mutations = { disconnectedConsumer: disconnected.hashes, secondCssOwner: duplicated.hashes }
const exportDelta = Object.keys(manifest.exports).filter(key => retired.has(key) || key.includes('*') && !dataWildcards.has(key))
const countsOf = byHost => Object.fromEntries(Object.entries(byHost).map(([host, edges]) => [host, {
  files: new Set(edges.map(edge => edge.from)).size, imports: edges.length, owners: new Set(edges.map(edge => edge.owner)).size
}]))
const counts = countsOf(consumers)
if (scan) {
  console.log(JSON.stringify({ candidate, scanned: true, pendingCutover: exportDelta, counts, css, mutations }))
  process.exit(0)
}

assert.equal(typeof entries.workspaceExportMap, 'function', 'The workspace entry owner must classify the final public exports')
assert.deepEqual(manifest.exports, entries.workspaceExportMap(), 'The committed export manifest differs from its canonical owner')
assert.deepEqual(exportDelta, [], 'Retired Client UI exports remain available')
assert.equal(git('status', '--porcelain', '--untracked-files=no', '--', ...roots, manifestPath, 'pnpm-lock.yaml',
  'packages/client-ui/scripts/supported-entries.mjs', 'packages/editor-extensions/package.json', 'apps/host/package.json',
  relative(root, import.meta.filename)).trim(), '',
  'Consumer qualification requires the committed candidate')

function evidence(file) {
  assert.ok(typeof file === 'string' && file.length > 0, 'An actual product receipt is required')
  const bytes = read(file)
  return { data: JSON.parse(bytes), binding: { file: relative(root, resolve(root, file)), sha256: digest(bytes) } }
}
function bind(files, digests) {
  for (const file of files) assert.equal(digests?.[file], digest(readFileSync(resolve(root, file))), 'Product receipt did not bind the original input ' + file)
}
const paths = JSON.parse(read(bindingPath))
const product = Object.fromEntries(Object.entries(hosts).map(([host]) => [host, evidence(paths[host])]))
const desktop = product.Desktop.data
assert.equal(desktop.candidate, candidate)
assert.ok(desktop.passed && desktop.executed && desktop.sourceBound && desktop.cleanup.privateRootRemoved)
const terminal = desktop.phases[0]?.actual.nativeTerminal
assert.ok(terminal?.live.state === 'running' && terminal.older.focused && terminal.after.sameTerminal)
assert.equal(terminal.originalAttachment.filter(call => call.kind === 'attach').length, 1)
assert.deepEqual(desktop.inputDrift, [])
bind(['apps/desktop/src/renderer/src/components/TerminalView.tsx', 'apps/desktop/src/renderer/src/components/ActivityView.tsx',
  'apps/desktop/src/preload/index.ts'], desktop.inputs)
bind([fieldCss], desktop.cssInputs)

const mobile = product.Mobile.data
assert.equal(mobile.candidate, candidate)
assert.ok(mobile.passed && mobile.executed && mobile.sourceBound && mobile.cleanup.privateRootRemoved)
assert.equal(mobile.phases.length, 6)
assert.ok(mobile.phases.every(phase => phase.actual.mobile?.passed && phase.actual.mobile.anchorSample?.stillMounted))
bind(['apps/mobile/src/MobileApp.tsx', 'apps/mobile/src/conversation/MobileConversationSurface.tsx'],
  mobile.mobileVariants.candidate.source)

const host = product.Host.data
assert.ok(host.normal?.passed && host.restored?.passed && host.normal.editedBlocks.length > 1 && host.normal.nodeFiles > 0)
assert.equal(host.mutation, 'rendered-theme')
bind(['apps/host/dist/note-file-writer.js', 'apps/host/dist/theme-observation.js', 'apps/host/dist/mote-avatar-read.js',
  'packages/client-ui/dist/theme/model.js', 'packages/client-ui/dist/note/note-content-schema.js'], host.inputs)

const extension = product['editor-extensions'].data
assert.equal(extension.candidate, candidate)
assert.ok(extension.passed && extension.tests > 0 && extension.previews?.outputs > 0 && extension.previews.restored)
assert.match(extension.previews.archiveSHA256, /^[\da-f]{64}$/u)
bind([manifestPath, 'packages/editor-extensions/package.json', 'packages/editor-extensions/src/ui/NotebookFilePreview.tsx',
  'packages/editor-extensions/src/pdf/PdfReader.tsx'], extension.sourceHashes)

const oldExports = JSON.parse(git('show', baseline + ':' + manifestPath)).exports
const oldEntities = new Map(entities)
// Only touched files need a prior blob; unaffected call sites are byte-identical.
const differences = git('diff', '--name-status', '--no-renames', '-z', baseline, candidate, '--', ...Object.values(hosts))
  .split('\0').slice(0, -1)
for (let i = 0; i < differences.length; i += 2) {
  const [status, file] = differences.slice(i, i + 2)
  if (!sourceFile.test(file)) continue
  if (status === 'A') oldEntities.delete(file)
  else oldEntities.set(file, assetOrModule(file, git('show', baseline + ':' + file)))
}
const priorCounts = countsOf(uses({ exports: oldExports, entities: oldEntities, historical: true }))
const examples = Object.fromEntries(Object.entries(entries.supportedExamples).map(([family, definition]) => {
  const keys = new Set([...Object.keys(definition.entries), ...definition.styles])
  return [family, Object.fromEntries(Object.entries(consumers).map(([host, edges]) => [
    host, edges.filter(edge => keys.has(edge.key)).length
  ]))]
}))
const output = '.local/state/client-ui-migration/verification.json'
mkdirSync(resolve(root, dirname(output)), { recursive: true })
writeFileSync(resolve(root, output), JSON.stringify({
  schema: 'agentmux.client-ui-consumer-migration.v1', passed: true, candidate, baseline, counts, priorCounts, consumers, examples, css, mutations,
  exportDelta: { before: Object.keys(oldExports).length, after: Object.keys(manifest.exports).length,
    removed: Object.keys(oldExports).filter(key => !Object.hasOwn(manifest.exports, key)) },
  product: Object.fromEntries(Object.entries(product).map(([key, value]) => [key, value.binding]))
}, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, candidate, counts, evidence: output }))
