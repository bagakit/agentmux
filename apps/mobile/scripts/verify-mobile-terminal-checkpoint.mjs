import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

assert.equal(process.argv.length, 2, 'This verifier runs a fresh private Core checkpoint; proof reuse is not supported.')
const repo = resolve(import.meta.dirname, '../../..')
const evidence = join(repo, '.tmp/agentmux-private-mobile-client/mobile-terminal/checkpoint')
await mkdir(evidence, { recursive: true })
const paths = ['apps/mobile/src/terminal/reader.ts', 'apps/mobile/test/terminal-checkpoint.test.ts',
  'apps/mobile/test/terminal-reader.test.ts', 'apps/mobile/test/terminal-browser-fixture.tsx',
  'apps/host/test/mobile-terminal-control.test.ts', 'apps/mobile/scripts/verify-mobile-terminal-checkpoint.mjs']
const dependencies = ['apps/mobile/src/terminal/MobileTerminalViewer.tsx', 'packages/core/src/types.ts',
  'packages/core/src/terminal-continuation.ts', 'packages/core/dist/client.js', 'packages/core/dist/ctxmux-run-adapter.js',
  'packages/client-ui/src/terminal/replay.ts', 'packages/client-ui/src/terminal/live-output.ts',
  'packages/core/vendor/ctxmux/darwin-arm64/manifest.json', 'packages/core/node_modules/@xterm/headless/lib-headless/xterm-headless.js']
const hashes = async files => Object.fromEntries(await Promise.all(files.map(async file =>
  [file, createHash('sha256').update(await readFile(join(repo, file))).digest('hex')])))
const source = await hashes(paths), consumedSource = await hashes(dependencies)
const target = join(repo, paths[0]), product = await readFile(target, 'utf8')
const start = product.indexOf("      if (step.type === 'restore') {"), end = product.indexOf("      } else if (step.type === 'resized') {", start)
assert.ok(start >= 0 && end > start)
const block = product.slice(start, end)
assert.ok(block.includes('checkpoint.restoreSize') && block.includes('checkpoint.resizeAfterRestoreBytes') && block.includes('finally') && block.includes('cursor = step.checkpoint.throughByte'), 'Nonempty actual checkpoint consumer')
const baseConfig = {
  test: { environment: 'node', include: ['apps/mobile/test/terminal-checkpoint.test.ts'], testTimeout: 30_000 },
  resolve: { alias: Object.fromEntries([
    ['@agentmux/core/terminal-continuation', 'packages/core/src/terminal-continuation.ts'],
    ['@agentmux/client-ui/terminal/replay', 'packages/client-ui/src/terminal/replay.ts'],
    ['@agentmux/client-ui/terminal/live-output', 'packages/client-ui/src/terminal/live-output.ts']
  ].map(([name, file]) => [name, join(repo, file)])) }
}
const config = join(evidence, 'source.config.mts')
await writeFile(config, `export default ${JSON.stringify(baseConfig)};\n`)
const run = (configuration, pattern) => {
  const result = spawnSync(process.execPath, [join(repo, 'node_modules/vitest/vitest.mjs'), 'run', '--config', configuration,
    ...(pattern ? ['--testNamePattern', pattern] : [])], { cwd: repo, env: { ...process.env,
      AGENTMUX_CHECKPOINT_EVIDENCE: join(evidence, 'actual-core21.json') }, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
  if (result.error) throw result.error
  return { exitCode: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}
const green = run(config)
await writeFile(join(evidence, 'green.log'), green.output)
assert.equal(green.exitCode, 0, green.output); assert.match(green.output, /3 passed/u)
const actual = JSON.parse(await readFile(join(evidence, 'actual-core21.json'), 'utf8'))
const actualFiles = [paths[0], paths[1], 'packages/core/src/terminal-continuation.ts', 'packages/client-ui/src/terminal/replay.ts']
assert.deepEqual(Object.keys(actual.source).sort(), [...actualFiles].sort(), 'The fresh Run proof must bind all four Source owners, not an empty proof')
assert.deepEqual(actual.source, await hashes(actualFiles)); assert.equal(actual.sourceBeforeAfterEqual, true)
assert.deepEqual(actual.before, actual.after); assert.deepEqual(actual.forbidden, []); assert.deepEqual(actual.cleanup, [])
assert.ok(actual.before.pid > 1 && actual.normalBufferLines > actual.before.rows)
assert.equal(actual.activeBuffer, 'alternate'); assert.equal(actual.normalAndAlternateBuffersMatchReference, true)
assert.equal(actual.parsedCursor, actual.latestOutputBytes)
assert.equal(actual.source[paths[0]], source[paths[0]]); assert.equal(actual.source[paths[1]], source[paths[1]])
const mutations = [
  { id: 'checkpoint-consumer-withdrawn', from: block, to: `      if (step.type === 'restore') {
        canvas.reset()
        canvas.resize(step.checkpoint.size.cols, step.checkpoint.size.rows)
        await restoreTerminalCheckpoint(step.restoreBytes, write)
        if (closed) return
        cursor = step.checkpoint.throughByte
        resizeRevision = step.checkpoint.resizeRevision
        geometryKnown = true
` },
  { id: 'temporary-history-finally-withdrawn', from: '        } finally {\n          canvas.options.scrollback = scrollback\n        }', to: '        } finally {}' }
]
const proofs = []
for (const mutation of mutations) {
  assert.equal(product.split(mutation.from).length, 2, `${mutation.id}: one actual nonempty block`)
  const candidate = join(evidence, `${mutation.id}.config.mts`)
  await writeFile(candidate, `const base=${JSON.stringify(baseConfig)},target=${JSON.stringify(target)},from=${JSON.stringify(mutation.from)},to=${JSON.stringify(mutation.to)};export default {...base,plugins:[{name:'mobile-checkpoint-block',enforce:'pre',transform(code,id){if(id.split('?')[0]!==target)return;if(code.split(from).length!==2)throw new Error('Owning Source block missing');console.info('MOBILE_CHECKPOINT_MUTANT:${mutation.id}');return code.replace(from,to)}}]};\n`)
  try {
    const red = run(candidate, 'authoritative old grid|local history policy')
    await writeFile(join(evidence, `${mutation.id}.red.log`), red.output)
    assert.notEqual(red.exitCode, 0); assert.match(red.output, /AssertionError/u)
    assert.ok(red.output.includes(`MOBILE_CHECKPOINT_MUTANT:${mutation.id}`), 'Actual product Source transformed')
    proofs.push({ id: mutation.id, exitCode: red.exitCode, actualSourceBlockApplied: true, assertionRed: true })
  } finally { await rm(candidate) }
}
const restored = run(config, 'authoritative old grid|local history policy')
await writeFile(join(evidence, 'restored-green.log'), restored.output)
assert.equal(restored.exitCode, 0, restored.output); assert.match(restored.output, /2 passed/u)
const viewer = await readFile(join(repo, dependencies[0]), 'utf8')
assert.equal(viewer.split('binding = createMobileTerminalReader({ client, agentSessionId, canvas, report: setReading })').length, 2,
  'Actual MobileTerminalViewer must consume the reader outside its definition')
const strict = join(evidence, 'tsconfig.json')
await writeFile(strict, JSON.stringify({ extends: join(repo, 'apps/mobile/tsconfig.json'), compilerOptions: { types: ['node'] },
  files: [join(repo, 'apps/mobile/node_modules/vite/client.d.ts'), join(repo, 'packages/core/node_modules/@xterm/headless/typings/xterm-headless.d.ts')],
  include: paths.filter(file => file.endsWith('.ts') || file.endsWith('.tsx')).map(file => join(repo, file)) }, null, 2) + '\n')
const typecheck = spawnSync(process.execPath, [join(repo, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', strict],
  { cwd: repo, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
await writeFile(join(evidence, 'types.log'), `${typecheck.stdout ?? ''}${typecheck.stderr ?? ''}`)
assert.equal(typecheck.status, 0, `${typecheck.stdout}${typecheck.stderr}`)
assert.deepEqual(await hashes(paths), source); assert.deepEqual(await hashes(dependencies), consumedSource)
await writeFile(join(evidence, 'receipt.json'), JSON.stringify({ scope: 'Existing checkpoint contract follow-through only', source, consumedSource,
  sourceBeforeAfterEqual: true, behaviorCases: 3, headlessAuthorityCase: { oldGrid: [12, 6], finalGrid: [6, 4], temporaryScrollbackRows: 17,
    callbackFenceBeforeBothParses: 0, originalThroughByte: 9001, protocolRepliesNotForwarded: true }, actualCore21: actual,
  sourceMutations: proofs, restoredGreen: { exitCode: restored.exitCode, headlessCases: 2 }, strictTypesExitCode: typecheck.status,
  caller: 'MobileTerminalViewer → createMobileTerminalReader → original shared replay/ctxmux checkpoint fields',
  limitations: ['Every invocation runs a fresh private Core checkpoint; proof reuse is not supported.',
    'Non-null temporary history capacity is proven by the explicit headless authority fixture; the real Core21 checkpoint has null capacity.',
    'No user App/Run, browser, OS dialog, native installation or phone acceptance.', 'This receipt closes the existing checkpoint consumer follow-through; it does not declare all T005 or the mobile Feature done.'] }, null, 2) + '\n')
console.log('Mobile checkpoint: 3 behaviors (including one real private Core21 Run), 2 Source block Assertion RED, restored 2 GREEN, strict types and product caller.')
