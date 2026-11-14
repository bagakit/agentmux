import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'

const repository = resolve(import.meta.dirname, '../../..')
const args = process.argv.slice(2)
const root = args.includes('--root') ? resolve(args[args.indexOf('--root') + 1]) : repository
const verify = args.includes('--verify')
const output = args.includes('--output') ? resolve(args[args.indexOf('--output') + 1]) : resolve(root, 'docs/reviews/ui-component-inventory.json')
const extensions = new Set(['.ts', '.tsx', '.mts', '.mjs', '.cjs', '.css', '.md'])
const roots = ['apps/desktop/src', 'apps/desktop/scripts', 'apps/desktop/test', 'apps/mobile/src', 'apps/mobile/scripts', 'packages/client-ui/src']

function walk(directory) {
  if (!directory.startsWith(root + '/') && directory !== root) throw new Error('Inventory path escapes the selected root')
  let entries
  try { entries = readdirSync(directory) } catch { return [] }
  return entries.flatMap(name => {
    if (['node_modules', 'dist', '.tmp', '.local', '.bagakit', '.worktrees', 'coverage'].includes(name)) return []
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return walk(path)
    return extensions.has(name.slice(name.lastIndexOf('.'))) ? [path] : []
  })
}

const files = roots.flatMap(base => walk(join(root, base)))
const sources = new Map(files.map(file => [file, readFileSync(file, 'utf8')]))
const relativeFile = file => relative(root, file).replaceAll('\\', '/')
const lineAt = (source, index) => source.slice(0, index).split('\n').length

const components = files.filter(file => /\.tsx$/u.test(file)).flatMap(file => {
  const path = relativeFile(file), source = sources.get(file)
  const exported = [...source.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+([A-Z][A-Za-z0-9_]*)/g)].map(match => match[1])
  const names = exported.length ? [...new Set(exported)] : (/^[A-Z]/.test(basename(file)) ? [basename(file, '.tsx')] : [])
  return names.map(name => {
    const category = /(?:Picker|Composer|Conversation|Executor|Workbench|Surface|Pane)/u.test(name) ? 'domain-composite'
      : /^(?:Mobile|Desktop)/u.test(name) ? 'host-adapter' : 'basic'
    return { name, file: path, category, owner: path.startsWith('packages/client-ui/') ? 'packages/client-ui' : path.startsWith('apps/mobile/') ? 'apps/mobile' : 'apps/desktop' }
  })
}).sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name))

const componentNames = ['SelectionField']
const consumers = []
for (const [file, source] of sources) {
  for (const component of componentNames) {
    if (!source.includes(component)) continue
    const path = relativeFile(file)
    const add = kind => consumers.push({ component, file: path, kind, owner: path.startsWith('apps/mobile/') ? 'apps/mobile' : path.startsWith('packages/client-ui/') ? 'packages/client-ui' : 'apps/desktop' })
    if (new RegExp(`import[^;]*${component}[^;]*from`, 'u').test(source)) add('import')
    if (new RegExp(`<${component}(?:\\s|/|>)`, 'u').test(source)) add('jsx')
    if (source.includes(`components/${component}`) || source.includes(`styles/${component}`)) add('literal-path')
    if (new RegExp(`(?:join|resolve|replace|slice|replaceAll)[^;\\n]{0,180}${component}|${component}[^;\\n]{0,180}(?:join|resolve)`, 'u').test(source)) add('dynamic-path')
  }
}
const uniqueConsumers = [...new Map(consumers.map(item => [`${item.component}|${item.file}|${item.kind}`, item])).values()]
  .sort((a, b) => a.file.localeCompare(b.file) || a.kind.localeCompare(b.kind))

const nativeSelects = []
for (const [file, source] of sources) {
  if (!file.endsWith('.tsx')) continue
  for (const match of source.matchAll(/<select\b/g)) nativeSelects.push({ file: relativeFile(file), line: lineAt(source, match.index), owner: relativeFile(file).startsWith('packages/client-ui/') ? 'packages/client-ui' : relativeFile(file).startsWith('apps/mobile/') ? 'apps/mobile' : 'apps/desktop' })
}

const defined = new Set()
for (const source of sources.values()) for (const match of source.matchAll(/(?:^|[{;\s'\"`])(--[a-z0-9-]+)\s*:/gim)) defined.add(match[1])
const styleIssues = []
for (const [file, source] of sources) {
  if (!file.endsWith('.css')) continue
  const body = source.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const match of body.matchAll(/var\(\s*(--[a-z0-9-]+)\s*([,)])/gi)) {
    if (match[2] === ',' || match[1].startsWith('--radix-') || defined.has(match[1])) continue
    styleIssues.push({ file: relativeFile(file), property: match[1], line: lineAt(body, match.index) })
  }
}

const futureFeatures = [
  { id: 'ui-shared-selection-package', owner: 'packages/client-ui', dependsOn: ['f-3su8fk3ca'], verification: ['Radix patch identity and typed footer', 'all old-path guards', 'Desktop/Mobile Modal attachment', 'production mutations and independent visual review'] },
  { id: 'ui-mobile-selection-consistency', owner: 'apps/mobile + packages/client-ui', dependsOn: ['ui-shared-selection-package'], verification: ['ordinary Mobile Modal consumer', 'root ClientUiProvider and mobile-overlays', 'keyboard/IME/safe-area evidence separated from physical-device claims', 'independent visual review'] },
  { id: 'ui-typography-consistency', owner: 'Desktop presentation owners', dependsOn: ['f-3su8fk3ca'], verification: ['computed typography roles', 'component CSS guards', 'Settings/Focus independent visual review'] },
  { id: 'ui-rich-composite-consistency', owner: 'domain component owners', dependsOn: ['ui-shared-selection-package'], verification: ['typed DTO and host-injected actions', 'Executor/Composer/Conversation consumer tests', 'no business Store in basic controls'] },
  { id: 'ui-component-directory-cohesion', owner: 'packages/client-ui', dependsOn: ['ui-shared-selection-package', 'ui-rich-composite-consistency'], verification: ['approved final taxonomy before moves', 'all static/dynamic path guards', 'package exports and Desktop/Mobile builds'] },
]

const report = {
  schema: 'agentmux.ui-component-inventory.v1',
  root: relative(repository, root) || '.',
  components,
  consumers: uniqueConsumers,
  nativeSelects,
  styleIssues,
  futureFeatures,
  notes: [
    'Nonempty presence is not a completeness proof; reverse fixtures must fail when a real JSX consumer disappears.',
    'Native selects and domain composites require per-field semantic review, not mechanical replacement.',
    'This Feature closes Desktop selection consumers only; futureFeatures own the remaining user goal.',
  ],
}

if (verify) {
  assert.ok(components.length > 0, 'Inventory must contain real components')
  const selections = uniqueConsumers.filter(item => item.component === 'SelectionField')
  assert.ok(selections.length > 0, 'Inventory must contain SelectionField consumers')
  assert.ok(selections.some(item => item.kind === 'import' || item.kind === 'jsx'), 'Dynamic strings alone cannot prove a real SelectionField consumer')
  for (const kind of ['import', 'jsx', 'literal-path', 'dynamic-path']) assert.ok(selections.some(item => item.kind === kind), `SelectionField consumer form missing: ${kind}`)
  assert.ok(nativeSelects.length > 0, 'Native select inventory must not be empty')
  assert.ok(futureFeatures.every(item => item.owner && item.verification.length > 0), 'Every follow-up Feature needs an owner and verification')
}

mkdirSync(resolve(output, '..'), { recursive: true })
writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
if (root !== repository || args.includes('--output')) console.log(JSON.stringify(report))
else console.log(JSON.stringify({ schema: report.schema, components: components.length, consumers: uniqueConsumers.length, nativeSelects: nativeSelects.length, styleIssues: styleIssues.length, output }))
