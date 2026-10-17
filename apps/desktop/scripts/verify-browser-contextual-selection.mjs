import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(import.meta.dirname, '../../..'), args = process.argv.slice(2)
const baseline = args.includes('--baseline'), handoff = args.includes('--capture-handoff'), foreground = args.includes('--foreground')
let output = join(root, '.tmp/browser-agent-collaboration/contextual-selection-proof'), coreBuildReceipt
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--output') { assert.ok(args[i + 1] && !args[i + 1].startsWith('--')); output = resolve(args[++i]) }
  else if (args[i] === '--core-build-receipt') { assert.ok(args[i + 1] && !args[i + 1].startsWith('--')); coreBuildReceipt = resolve(args[++i]) }
  else assert.ok(['--baseline', '--capture-handoff', '--foreground'].includes(args[i]), 'Unsupported selection proof argument')
}
assert.ok(!foreground || handoff, 'Foreground selection uses the exact private capture handoff')
assert.ok(coreBuildReceipt, 'Selection must identify its exact source-qualified Core build receipt')
await mkdir(output, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const receipt = { schema: 'agentmux.browser-contextual-selection.proof.v1', passed: false, baselineOnly: baseline,
  candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sources: {},
  physicalInputQualified: false, independentVisualReview: 'not-performed',
  boundary: 'One private actual BrowserPane/editor workflow through original Main, Hosted/Core, Provider and reader. Separate Renderer and native document images never stand in for an OS whole-window visual review.' }
receipt.sources[relative(root, fileURLToPath(import.meta.url))] = hash(await readFile(fileURLToPath(import.meta.url)))
async function run(file, parameters, name) {
  const log = []
  const status = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...parameters], { cwd: root, env: { ...process.env, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log.push(bytes); process.stdout.write(bytes) })
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }))
  })
  await writeFile(join(output, name + '.log'), Buffer.concat(log))
  assert.equal(status.code, 0, name + ' must complete its actual product assertions'); assert.equal(status.signal, null)
}
async function consume(path) {
  const value = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(value.candidate, receipt.candidate)
  assert.ok(Object.keys(value.sources).length > 0, 'A qualified selection slice binds real nonempty source inputs')
  for (const [file, digest] of Object.entries(value.sources)) {
    assert.equal(hash(await readFile(join(root, file))), digest, 'Changed selection source: ' + file)
    if (receipt.sources[file]) assert.equal(receipt.sources[file], digest)
    receipt.sources[file] = digest
  }
  return value
}
try {
  const nativeDirectory = join(output, 'native')
  await run('apps/desktop/scripts/verify-browser-contextual-composer.mjs', ['--selection-only', '--output', nativeDirectory,
    '--core-build-receipt', coreBuildReceipt,
    ...(handoff ? ['--capture-handoff'] : []), ...(foreground ? ['--foreground'] : [])], 'selection-native')
  const native = await consume(join(nativeDirectory, 'receipt.json'))
  assert.equal(native.selectionBaselineComplete, true)
  assert.equal(native.runs.length, 1)
  assert.equal(native.runs[0].actual.selection.passed, true)
  assert.equal(native.runs[0].actual.selection.publicInspect.passed, true)
  assert.ok(native.coreBuild?.sourceCount > 0 && native.coreBuild?.outputCount > 0)
  receipt.coreBuild = native.coreBuild
  receipt.native = { file: relative(root, join(nativeDirectory, 'receipt.json')), sha256: hash(await readFile(join(nativeDirectory, 'receipt.json'))), wholeWindowCaptures: native.runs[0].actual.frames?.filter(frame => frame.surface === 'os-native-window').length ?? 0 }
  if (handoff) assert.equal(receipt.native.wholeWindowCaptures, 2, 'Selection handoff retains its exact normal and narrow native window images')
  if (!baseline) {
    const path = join(output, 'opinion.json')
    await run('apps/desktop/scripts/verify-browser-opinion-selection.mjs', ['--receipt', path], 'opinion-owner')
    const unit = await consume(path)
    assert.equal(unit.schema, 'agentmux.browser-opinion-selection.proof.v1'); assert.equal(unit.passed, true)
    assert.equal(unit.runs.length, 9)
    assert.ok(unit.runs.every(run => run.assertions === 14))
    receipt.opinion = { file: relative(root, path), sha256: hash(await readFile(path)) }
  }
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), receipt.candidate)
  for (const [file, digest] of Object.entries(receipt.sources)) assert.equal(hash(await readFile(join(root, file))), digest, 'Changed final selection source: ' + file)
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack }; throw error }
finally { await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2)) }
