import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../../..')
const source = 'apps/desktop/scripts/package-runtime-upgrade.mjs'
const test = 'apps/desktop/test/package-ui-observation-rpc.test.ts'
const evidence = join(root, '.tmp/package-ui-observation-rpc-mutations')
const copied = [source, 'apps/desktop/src/shared/client-observation.ts',
  'apps/desktop/src/shared/desktop-focus-observation.ts', 'packages/core/src/socket-liveness.ts']
const inputs = [...copied, test, 'apps/desktop/tsconfig.json',
  'apps/desktop/scripts/verify-package-ui-observation-rpc-mutations.mjs',
  'packages/core/src/public-rpc-client.ts', 'packages/core/src/public-rpc.ts',
  'packages/core/dist/index.js', 'packages/core/dist/public-rpc-client.js',
  'packages/core/dist/public-rpc-wire.js', 'packages/core/dist/rpc-business-codec.js']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const original = new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(root, file))])))
const hashes = values => Object.fromEntries([...values].map(([file, bytes]) => [file, sha(bytes)]))
const receipt = { schema: 'agentmux.node-source-mutation.v1', passed: false,
  sourceBefore: hashes(original), sharedTreeMutations: 0, runtimeControl: [], cases: [] }
const copy = await realpath(await mkdtemp(_hygiene_fixturePath("tmp/amx-ui-reader-mutation-")))
const target = join(copy, source)

async function run(label) {
  const loadedPath = join(evidence, `${label}-loaded.jsonl`)
  await writeFile(loadedPath, '')
  const result = await new Promise((done, reject) => {
    const child = spawn('pnpm', ['exec', 'vitest', 'run', test, '--maxWorkers=1',
      '--exclude', '.tmp/**', '--exclude', 'docs/**', '--exclude', '.bagakit/**'], {
      cwd: root, env: { ...process.env, AGENTMUX_UI_OBSERVATION_SOURCE: target,
        AGENTMUX_UI_READER_LOAD_LOG: loadedPath,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(join(copy, 'observe-load.mjs')).href}` },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    child.on('error', reject); child.on('close', (code, signal) => done({ code, signal, output }))
  })
  const log = `${label}.log`
  await writeFile(join(evidence, log), result.output)
  const loaded = (await readFile(loadedPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.equal(loaded.length, 3, 'Every actual helper child must load the selected source.')
  assert.deepEqual(loaded.map(item => item.url), Array(3).fill(pathToFileURL(target).href))
  assert.deepEqual(loaded.map(item => item.sha256), Array(3).fill(sha(await readFile(target))))
  return { ...result, log, loaded }
}

try {
  await mkdir(evidence, { recursive: true })
  for (const file of copied) { await mkdir(dirname(join(copy, file)), { recursive: true }); await cp(join(root, file), join(copy, file)) }
  await cp(join(root, 'package.json'), join(copy, 'package.json'))
  await symlink(join(root, 'node_modules'), join(copy, 'node_modules'))
  await symlink(join(root, 'apps/desktop/node_modules'), join(copy, 'apps/desktop/node_modules'))
  // This proof observer delegates the actual Node loader unchanged. It records only the
  // exact bytes loaded by --inspect-ui children; it does not resolve or rewrite modules.
  await writeFile(join(copy, 'observe-load.mjs'), `
import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  if (process.argv[2] === '--inspect-ui' && url === pathToFileURL(process.env.AGENTMUX_UI_OBSERVATION_SOURCE).href) {
    appendFileSync(process.env.AGENTMUX_UI_READER_LOAD_LOG, JSON.stringify({ pid: process.pid, url,
      sha256: createHash('sha256').update(loaded.source).digest('hex') }) + '\\n');
  }
  return loaded;
} });
`)
  const baseline = await run('baseline-green')
  assert.equal(baseline.code, 0, baseline.output)
  receipt.baseline = { exit: baseline.code, log: baseline.log, loaded: baseline.loaded }
  const before = `const { connectAgentMuxRpc } = await import(pathToFileURL(process.argv[3]).href)
  const client = await connectAgentMuxRpc()
  try {
    const result = await client.call('app.inspect', {})
    process.stdout.write(JSON.stringify(parseDesktopClientObservation(result.observation)))
  } finally { await client.dispose() }`
  const after = `const { requestAgentMuxControl } = await import(pathToFileURL(process.argv[3]).href)
  const receipt = await requestAgentMuxControl({ schemaVersion: 5, requestId: randomUUID(), operation: 'inspect.client' })
  process.stdout.write(JSON.stringify(parseDesktopClientObservation(receipt.result.observation)))`
  const text = original.get(source).toString()
  assert.equal(text.split(before).length - 1, 1, 'The public reader mutation must have exactly one source anchor.')
  let red
  try {
    await writeFile(target, text.replace(before, after))
    red = await run('removed-public-call-red')
    assert.ok(red.code > 0 && red.signal === null, red.output)
    assert.match(red.output, /AssertionError/)
    assert.match(red.output, /Tests\s+[1-9]\d* failed/)
    assert.match(red.output, /requestAgentMuxControl is not a function/)
  } finally { await writeFile(target, original.get(source)) }
  const green = await run('removed-public-call-restore-green')
  assert.equal(green.code, 0, green.output)
  receipt.cases.push({ label: 'removed-public-call', file: source, before, after,
    exit: red.code, log: red.log, loaded: red.loaded,
    restore: { exit: green.code, log: green.log, loaded: green.loaded } })
  receipt.sourceAfter = hashes(new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(root, file))]))))
  assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore)
  receipt.copyAfter = Object.fromEntries(await Promise.all(copied.map(async file => [file, sha(await readFile(join(copy, file)))])))
  assert.deepEqual(receipt.copyAfter, Object.fromEntries(copied.map(file => [file, receipt.sourceBefore[file]])))
  receipt.passed = true
} catch (error) {
  receipt.failure = { message: error.message }
  throw error
} finally {
  await rm(copy, { recursive: true, force: true })
  receipt.cleanup = { copyRemoved: true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
console.log(JSON.stringify({ passed: receipt.passed, mutants: receipt.cases.length, receipt: join(evidence, 'receipt.json') }))
