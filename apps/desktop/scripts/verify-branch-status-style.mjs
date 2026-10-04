import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { runProbeProcess } from './probe-process.mjs'

const root = path.resolve(import.meta.dirname, '../../..')
const fixture = path.join(root, 'apps/desktop/scripts/fixtures/branch-status-style')
const evidence = path.resolve(process.argv[2] ?? '.tmp/branch-status-style')
const captureOnly = process.argv.includes('--capture-only')
const desktopRequire = createRequire(path.join(root, 'apps/desktop/package.json'))
const run = promisify(execFile)
const sha = value => createHash('sha256').update(value).digest('hex')
const owner = 'apps/desktop/src/renderer/src/components/BranchesPanel.tsx'
const files = [owner, 'apps/desktop/src/renderer/src/styles/source-control.css', 'apps/desktop/test/branches-panel.test.tsx',
  ...['tokens', 'base', 'selector', 'index'].map(name => `apps/desktop/src/renderer/src/styles/${name}.css`),
  ...['entry.tsx', 'state.ts', 'scene.css', 'index.html', 'main.cjs', 'vitest.config.mts'].map(name => `apps/desktop/scripts/fixtures/branch-status-style/${name}`)]
const sourceCandidates = Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await fs.readFile(path.join(root, file)))])))
await fs.mkdir(evidence, { recursive: true })
const command = async (label, args, env = {}) => {
  let result
  try { const value = await run(path.join(root, 'node_modules/.bin/vitest'), args, { cwd: root, env: { ...process.env, ...env }, timeout: 60000, maxBuffer: 4 * 1024 * 1024 }); result = { code: 0, output: value.stdout + value.stderr } }
  catch (error) { result = { code: error.code, output: (error.stdout ?? '') + (error.stderr ?? '') } }
  await fs.writeFile(path.join(evidence, label + '.log'), result.output)
  return result
}
let receipt
try { receipt = JSON.parse(await fs.readFile(path.join(evidence, 'capture.json'), 'utf8')) } catch {}
if (!receipt?.passed || JSON.stringify(receipt.sourceCandidates) !== JSON.stringify(sourceCandidates)) {
  receipt = { schema: 'agentmux.branch-status-style.v1', passed: false, sourceCandidates, mutations: [], productionConsumers: [],
    isolation: 'Actual BranchesPanel, useWorkspaceBranches/useGitAheadBehind, SelectorRow/AgentAvatar and current stylesheet entry run in a private Electron. External Store/API snapshots are fixture inputs; no real Git, user data, Session or Runtime is touched.',
    scope: 'Two pre-existing allStyles assertions are excluded because unrelated concurrent agent-current-fork.css/conversation-ruler.css lack index imports; actual Electron verifies this slice status/sync/pin computed styles. No broad regression is claimed.' }
  const config = path.join(fixture, 'vitest.config.mts')
  const relevant = '^(?!.*(?:每种可见 kind|未 pin 的 pin 键)).*$'
  const control = await command('control', ['run', '--config', config, '-t', relevant])
  assert.equal(control.code, 0, control.output)
  assert.match(control.output, /Tests\s+14 passed/)
  receipt.tests = { passed: 14, skippedPreExistingStyles: 2 }
  for (const [label, before, after] of [
    ['wrong-current-meaning', "const statusLabel = branch.isCurrent ? 'Current branch'", "const statusLabel = branch.isCurrent ? 'Worktree'"],
    ['drop-accessible-status', 'aria-label={statusLabel}', 'aria-label={undefined}']
  ]) {
    const mutation = { file: owner, before, after }
    const mutationFile = path.join(evidence, 'mutation.json'), loaded = path.join(evidence, label + '-loaded.jsonl')
    await fs.writeFile(mutationFile, JSON.stringify(mutation)); await fs.writeFile(loaded, '')
    const red = await command(label, ['run', '--config', config, '-t', '状态图标三岔'], { AMX_BRANCH_STYLE_MUTATION: mutationFile, AMX_BRANCH_STYLE_LOADED: loaded })
    assert.ok(Number.isInteger(red.code) && red.code > 0); assert.match(red.output, /AssertionError/); assert.match(red.output, /1 failed/)
    const applied = (await fs.readFile(loaded, 'utf8')).trim().split('\n').map(JSON.parse).filter(item => item.file === owner && item.mutated)
    assert.equal(applied.length, 1); assert.equal(applied[0].sourceSHA256, sourceCandidates[owner])
    const green = await command(label + '-restored', ['run', '--config', config, '-t', '状态图标三岔'])
    assert.equal(green.code, 0, green.output)
    assert.equal(sha(await fs.readFile(path.join(root, owner))), sourceCandidates[owner])
    receipt.mutations.push({ label, red: red.code, restored: green.code, loaded: applied[0] })
  }
  const scan = async directory => (await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory() ? scan(path.join(directory, entry.name)) : /\.tsx?$/.test(entry.name) ? [path.join(directory, entry.name)] : []))).flat()
  const productionFiles = await scan(path.join(root, 'apps/desktop/src')); assert.ok(productionFiles.length > 0)
  for (const [symbol, definition] of [['BranchesPanel', owner], ['SurfaceToolDock', 'apps/desktop/src/renderer/src/components/SurfaceToolDock.tsx']]) {
    const callers = []
    for (const file of productionFiles.filter(file => file !== path.join(root, definition))) if (new RegExp('<' + symbol + '\\b').test(await fs.readFile(file, 'utf8'))) callers.push(path.relative(root, file))
    assert.ok(callers.length > 0, 'Definition-external production callers: ' + symbol)
    receipt.productionConsumers.push({ symbol, callers })
  }
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'packages/core/package.json'), 'utf8'))
  const aliases = Object.entries(manifest.exports).map(([key, value]) => ({
    find: new RegExp('^' + (key === '.' ? '@agentmux/core' : '@agentmux/core/' + key.slice(2)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
    replacement: path.join(root, 'packages/core', value.import.replace('./dist/', './src/').replace(/\.js$/, '.ts'))
  }))
  aliases.push(
    { find: /^@agentmux\/client-ui\/components\/(.+)$/, replacement: path.join(root, 'packages/client-ui/src/components/$1.tsx') },
    { find: /^@agentmux\/client-ui\/platform$/, replacement: path.join(root, 'packages/client-ui/src/platform.tsx') },
    { find: /^@agentmux\/client-ui\/(?!styles\/)(.+)$/, replacement: path.join(root, 'packages/client-ui/src/lib/$1.ts') }
  )
  const consumed = new Map()
  const externalInputs = { name: 'branch-style-external-inputs', enforce: 'pre', resolveId(id, importer) {
    if (!importer?.includes('/apps/desktop/src/renderer/src/')) return
    if (/(?:^|\/)store(?:\.js)?$/.test(id)) return '\0branch-store'
    if (/(?:^|\/)lib\/api(?:\.js)?$/.test(id)) return '\0branch-api'
  }, load(id) {
    if (id === '\0branch-store') return `export { useAppStore } from ${JSON.stringify(path.join(fixture, 'state.ts'))}`
    if (id === '\0branch-api') return `export { api } from ${JSON.stringify(path.join(fixture, 'state.ts'))}`
  }, transform(code, id) {
    const file = id.split('?')[0]
    if (file.startsWith(root + '/apps/desktop/src/') || file.startsWith(root + '/packages/client-ui/src/')) consumed.set(path.relative(root, file), sha(code))
  } }
  const { build } = await import(pathToFileURL(desktopRequire.resolve('vite')).href)
  const { default: react } = await import(pathToFileURL(desktopRequire.resolve('@vitejs/plugin-react')).href)
  const built = await build({ configFile: false, root: fixture, base: './', logLevel: 'error', define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: aliases }, plugins: [externalInputs, react()], build: { target: 'esnext', outDir: path.join(evidence, 'renderer'), emptyOutDir: true } })
  for (const file of [owner, 'apps/desktop/src/renderer/src/components/SelectorList.tsx', 'apps/desktop/src/renderer/src/components/AgentAvatar.tsx', 'apps/desktop/src/renderer/src/styles/index.css']) assert.ok(consumed.has(file), 'Actual compiled source: ' + file)
  receipt.compiledRenderer = Object.fromEntries(consumed)
  const styles = [built].flat().flatMap(bundle => bundle.output).filter(item => item.type === 'asset' && item.fileName.endsWith('.css'))
  assert.ok(styles.length > 0 && styles.some(item => String(item.source).includes('.branch-row__state')), 'Nonempty compiled production style')
  receipt.compiledStyles = Object.fromEntries(styles.map(item => [item.fileName, sha(item.source)]))
  const privateRoot = await fs.mkdtemp(_hygiene_fixturePath("tmp/amux-branch-style-"))
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE' && !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
    receipt.process = await runProbeProcess(desktopRequire('electron'), [path.join(fixture, 'main.cjs'), path.join(evidence, 'renderer/index.html'), privateRoot, evidence], { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 45000, onLine: line => process.stderr.write(line + '\n') })
    assert.equal(receipt.process.exitCode, 0)
    receipt.electron = JSON.parse(await fs.readFile(path.join(evidence, 'electron.json'), 'utf8')); assert.equal(receipt.electron.passed, true)
    receipt.screenshots = Object.fromEntries(await Promise.all(receipt.electron.screenshots.map(async name => [name, sha(await fs.readFile(path.join(evidence, name)))])))
  } finally { await fs.rm(privateRoot, { recursive: true, force: true }) }
  for (const [file, digest] of Object.entries(sourceCandidates)) assert.equal(sha(await fs.readFile(path.join(root, file))), digest, 'Unchanged candidate after proof: ' + file)
  receipt.passed = true
  await fs.writeFile(path.join(evidence, 'capture.json'), JSON.stringify(receipt, null, 2))
  await fs.writeFile(path.join(evidence, 'review.md'), '# Branches status icons\n\nActual Electron, controlled external Store/API inputs, current production component and styles. Captures show current/worktree/unbound, long identity/path, Agent presence, sync and original pin slots. Native hover/title/aria are recorded in electron.json; OS tooltip is outside capturePage.\n\n' + Object.keys(receipt.screenshots).map(name => `- [${name}](${name})`).join('\n') + '\n')
}
for (const [name, digest] of Object.entries(receipt.screenshots)) assert.equal(sha(await fs.readFile(path.join(evidence, name))), digest)
if (!captureOnly) {
  const review = JSON.parse(await fs.readFile(path.join(evidence, 'independent-review.json'), 'utf8'))
  assert.equal(review.verdict, 'approved', 'Independent full-image aesthetic review required')
  assert.deepEqual(review.screenshots, receipt.screenshots, 'Reviewed exact captured images')
  assert.deepEqual(review.sourceCandidates, receipt.sourceCandidates, 'Reviewed exact source candidate')
}
console.log(JSON.stringify({ passed: true, captureOnly, receipt: path.join(evidence, 'capture.json'), review: path.join(evidence, 'review.md') }))
