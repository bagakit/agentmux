import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const root = resolve(import.meta.dirname, '../../..'), evidence = join(root, '.tmp/agent-square-face')
const files = ['packages/client-ui/src/theme/icon-authored.ts', 'packages/client-ui/src/theme/icon-catalog.ts',
  'packages/client-ui/src/theme/builtin-retro.ts', 'packages/client-ui/src/theme/builtin-fallout.ts',
  'packages/client-ui/test/agent-square-face.test.tsx', 'packages/client-ui/test/agent-square-face.config.mts']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async file => JSON.parse(await readFile(file, 'utf8'))
async function run(mutation) {
  const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'packages/client-ui/test/agent-square-face.config.mts'],
    { cwd: root, env: { ...process.env, AGENT_SQUARE_FACE_MUTANT: mutation ?? '', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes)
  const code = await new Promise((done, fail) => { child.once('error', fail); child.once('exit', done) })
  await writeFile(join(evidence, (mutation ?? 'baseline') + '.log'), output)
  return { code, output }
}
await mkdir(evidence, { recursive: true })
if (process.argv.includes('--prepare')) {
  const baseline = await run()
  assert.equal(baseline.code, 0, baseline.output); assert.match(baseline.output, /Tests\s+3 passed/u)
  const mutations = await Promise.all(['slot', 'fill', 'theme'].map(async mutation => {
    const result = await run(mutation)
    assert.notEqual(result.code, 0, 'Production mutation survived: ' + mutation)
    assert.ok(result.output.includes('AGENT_SQUARE_FACE_MUTANT_LOADED ' + mutation)); assert.match(result.output, /AssertionError/u)
    assert.doesNotMatch(result.output, /ERR_MODULE_NOT_FOUND|Cannot find module|SyntaxError|No test files/u)
    return { mutation, code: result.code }
  }))
  const { evidence: visualPath } = await json(join(evidence, 'latest-visual.json'))
  const visual = await json(join(root, visualPath, 'receipt.json'))
  assert.equal(visual.passed, true); assert.equal(visual.actual.passed, true); assert.equal(visual.frames.length, 8)
  const sources = Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(join(root, file)))])))
  for (const file of files.filter(file => file.includes('/src/'))) assert.equal(visual.inputs[file], sources[file], 'Captured current production source: ' + file)
  await writeFile(join(evidence, 'prepared.json'), JSON.stringify({ passed: true, mutations, sources, visual: visualPath }, null, 2))
  console.log('Agent square face: 3 tests and 3 loaded source mutations verified; candidate bound to ' + visualPath)
} else {
  const prepared = await json(join(evidence, 'prepared.json'))
  assert.equal(prepared.passed, true); assert.equal(prepared.mutations.length, 3)
  for (const item of prepared.mutations) assert.notEqual(item.code, 0)
  assert.ok(Object.keys(prepared.sources).length > 0)
  for (const [file, digest] of Object.entries(prepared.sources)) assert.equal(hash(await readFile(join(root, file))), digest, 'Accepted source changed: ' + file)
  const visual = await json(join(root, prepared.visual, 'receipt.json'))
  assert.equal(visual.passed, true); assert.equal(visual.actual.passed, true); assert.equal(visual.frames.length, 8)
  for (const frame of visual.frames) assert.equal(hash(await readFile(join(root, prepared.visual, frame.file))), frame.sha256)
  const review = await readFile(join(evidence, 'visual-review.md'), 'utf8')
  assert.match(review, /(?:Decision|结论):\s*(?:approved|可交付)/u); assert.ok(review.includes(prepared.visual))
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify({ ...prepared, independentlyReviewed: true, boundary: visual.boundary }, null, 2))
  console.log('Agent square face: current source, actual consumers, 3 mutation counterexamples and 8 independently reviewed Renderer frames verified.')
}
