import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createCssSourceOverlay } from './css-source-overlay.mjs'

const root = resolve(import.meta.dirname, '../../../../..'), require = createRequire(join(root, 'apps/desktop/package.json'))
const vitePackage = require.resolve('vite/package.json'), { build } = await import(pathToFileURL(require.resolve('vite')).href)
const repositoryRef = process.argv[2] === '--repository' ? process.argv[3] : undefined
assert.ok(process.argv.length === 2 || process.argv.length === 4 && repositoryRef, 'Use verify-css-source-overlay.mjs [--repository <baseline-ref>]')
if (repositoryRef) await mkdir(join(root, '.tmp'), { recursive: true })
const temporary = await mkdtemp(join(repositoryRef ? join(root, '.tmp') : tmpdir(), 'amux-css-source-check-')), project = repositoryRef ? root : join(temporary, 'input')
const original = '.collaboration-edge__packet { animation: original-packet 3200ms linear; } @keyframes original-packet { from { opacity: 0; } to { opacity: 1; } }\n'
const candidate = '.collaboration-edge__packet { animation: candidate-packet 1200ms linear; } @keyframes candidate-packet { from { opacity: 0; } to { opacity: 1; } }\n'
try {
  const files = repositoryRef ? ['apps/desktop/src/renderer/src/styles/collaboration.css', ...['buttons', 'conversation-tool-trace', 'interaction'].map(name => 'packages/client-ui/src/styles/' + name + '.css')] : ['leaf.css']
  const entry = repositoryRef ? join(temporary, 'index.css') : join(project, 'index.css')
  const aliases = repositoryRef ? files.map((file, index) => ({ find: '@private-css/' + index, replacement: join(root, file) })) : []
  if (repositoryRef) await writeFile(entry, files.map((_file, index) => '@import "@private-css/' + index + '";').join('\n') + '\n')
  else { await mkdir(project); await writeFile(entry, '@import "./leaf.css";\n'); await writeFile(join(project, 'leaf.css'), candidate) }
  const originalBytes = new Map(files.map(file => [join(project, file), repositoryRef ? execFileSync('git', ['show', repositoryRef + ':' + file], { cwd: root }) : Buffer.from(original)]))
  async function compile(arm, broken = false) {
    const privateRoot = join(temporary, arm), inputs = {}, overlays = arm === 'candidate' ? new Map() : originalBytes
    const css = await createCssSourceOverlay({ root: project, privateRoot, overlays, inputs, vitePackage })
    await build({ configFile: false, root: project, logLevel: 'silent', resolve: { alias: aliases }, css: { postcss: { plugins: [css.observer] } }, plugins: broken ? [] : [css.plugin], build: { outDir: join(privateRoot, 'compiled'), minify: false, rollupOptions: { input: entry } } })
    const proof = css.verify(), assets = join(privateRoot, 'compiled/assets'), files = (await readdir(assets)).filter(file => file.endsWith('.css'))
    assert.equal(files.length, 1)
    return { proof, emitted: css.emitted(await readFile(join(assets, files[0]))) }
  }
  const baseline = await compile('baseline'), next = await compile('candidate')
  for (const file of files) { assert.ok(baseline.proof.loaded[file].reads.length); assert.equal(baseline.proof.loaded[file].origin, 'git-blob') }
  assert.deepEqual(baseline.emitted.packetAnimationNames, [repositoryRef ? 'collaboration-packet' : 'original-packet'])
  assert.deepEqual(next.emitted.packetAnimationNames, [repositoryRef ? 'collaboration-transfer' : 'candidate-packet'])
  if (repositoryRef) { assert.equal(baseline.emitted.disclosureRules.length, 0); assert.ok(next.emitted.disclosureRules.length > 0) }
  assert.notEqual(baseline.emitted.sha256, next.emitted.sha256)
  let failure
  try { await compile('broken', true) } catch (error) { failure = error.message }
  assert.ok(failure?.includes('Actual PostCSS input is not the declared source bytes'), 'Removing the real private-import rewrite must reject physical candidate CSS')
  console.log(JSON.stringify({ passed: true, baselineRef: repositoryRef ?? null, loadedOriginalCSS: Object.fromEntries(files.map(file => [file, baseline.proof.loaded[file]])), baseline: baseline.emitted, candidate: next.emitted, bypassRejected: failure, boundary: 'Tiny actual Vite/PostCSS CSS pipeline and changed-leaf source-byte mutation only; not Browser motion, Native cost or aesthetic qualification.' }))
} finally { await rm(temporary, { recursive: true, force: true }) }
