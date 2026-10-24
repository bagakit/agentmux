import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../packages/core/package.json', import.meta.url))
const { build } = require('esbuild')
const temporaryRoot = join(root, 'packages/core/.tmp')
await mkdir(temporaryRoot, { recursive: true })
const directory = await mkdtemp(join(temporaryRoot, 'native-public-'))
const cli = join(directory, 'amux.mjs')
const run = (args, env = process.env) => spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
try {
  const native = run([join(root, 'packages/native-desktop/scripts/verify-client.mjs')])
  process.stdout.write(native.stdout); process.stderr.write(native.stderr)
  assert.equal(native.status, 0, 'Native transport and image boundary must pass before public consumption')
  // Use the actual current production listener asset, without replacing its dispatcher.
  await build({ entryPoints: [join(root, 'packages/core/src/control-endpoint-listener-worker.ts')], outfile: join(root, 'packages/core/dist/control-endpoint-listener-worker.js'),
    bundle: true, platform: 'node', target: 'node24', format: 'esm', logLevel: 'silent' })
  await build({ entryPoints: [join(root, 'packages/core/src/agentmux.ts')], outfile: cli,
    bundle: true, platform: 'node', target: 'node24', format: 'esm', packages: 'external',
    banner: { js: "import { createRequire as nativeProofRequire } from 'node:module'; const require = nativeProofRequire(import.meta.url);" }, logLevel: 'silent' })
  const args = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'packages/core/test/native-desktop.config.mts']
  const baseline = run(args, { ...process.env, NATIVE_PUBLIC_CLI: cli })
  process.stdout.write(baseline.stdout); process.stderr.write(baseline.stderr)
  assert.equal(baseline.status, 0, 'Native public baseline must pass')
  const cases = {
    target: 'accurate result codec rejects', owner: 'public service consumes',
    auth: 'only transport-authenticated', action: 'typed action codec rejects'
  }
  for (const [mutation, title] of Object.entries(cases)) {
    const result = run([...args, '-t', title], { ...process.env, NATIVE_PUBLIC_CLI: cli, NATIVE_PUBLIC_MUTATION: mutation })
    assert.notEqual(result.status, 0, `Surviving native public mutation: ${mutation}`)
    assert.match(result.stdout + result.stderr, /AssertionError|expected.*to|to have been called/i, `Mutation must fail in its behavior assertion, not loading: ${result.stdout}\n${result.stderr}`)
    console.log(`killed: native public ${mutation}`)
  }
  console.log('Native public: actual CLI → public Unix service → shared host adapter → production Node connection; protocol fixture is not OS/TCC proof.')
} finally { await rm(directory, { recursive: true, force: true }) }
