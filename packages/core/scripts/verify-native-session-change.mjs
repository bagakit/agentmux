import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
const exec = promisify(execFile), repo = resolve(import.meta.dirname, '../../..')
const evidence = resolve(process.argv[2] ?? join(repo, '.bagakit/feature-tracker/features/f-2qw8frt2d/artifacts/core-verification'))
await mkdir(evidence, { recursive: true })
const privateBuild = await mkdtemp(join(tmpdir(), 'amx-source-confirm-cli-'))
const sha = data => createHash('sha256').update(data).digest('hex')
// Workspace links can resolve into another tree's dist. Bind every local dependency to this candidate.
const aliases = Object.fromEntries((await Promise.all(['demand', 'relay'].map(async name => {
  const manifest = JSON.parse(await readFile(join(repo, 'packages', name, 'package.json'), 'utf8'))
  return Object.entries(manifest.exports).map(([key, value]) => [key === '.' ? '@agentmux/' + name : '@agentmux/' + name + '/' + key.slice(2),
    resolve(repo, 'packages', name, value.import.replace('./dist/src/', './src/').replace('./dist/', './src/').replace(/\.js$/, '.ts'))])
}))).flat())
const receipts = []
const candidates = new Map()
const verificationInputs = Object.fromEntries(await Promise.all([
  'packages/core/test/native-session-change.test.ts', 'packages/core/test/fixtures/native-session-change/vitest.owning.config.mts',
  'packages/core/scripts/verify-native-session-change.mjs'
].map(async path => [path, sha(await readFile(join(repo, path)))])))
try {
  await mkdir(join(privateBuild, 'bin')); await mkdir(join(privateBuild, 'dist'))
  await mkdir(join(privateBuild, 'node_modules'))
  const linked = new Set()
  for (const name of ['core', 'relay']) {
    const manifest = JSON.parse(await readFile(join(repo, 'packages', name, 'package.json'), 'utf8'))
    for (const dependency of [...Object.keys(manifest.dependencies ?? {}), ...(name === 'core' ? ['@ctxmux/sdk'] : [])]) {
      if (dependency.startsWith('@agentmux/') || linked.has(dependency)) continue
      const destination = join(privateBuild, 'node_modules', dependency)
      if (dependency.startsWith('@')) await mkdir(join(privateBuild, 'node_modules', dependency.split('/')[0]), { recursive: true })
      await symlink(join(repo, 'packages', name, 'node_modules', dependency), destination)
      linked.add(dependency)
    }
  }
  await writeFile(join(privateBuild, 'package.json'), '{"type":"module"}\n')
  await writeFile(join(privateBuild, 'bin/agentmux'), "#!/usr/bin/env node\nimport '../dist/agentmux.js'\n")
  const cliBuild = await build({ entryPoints: [join(repo, 'packages/core/src/agentmux.ts')], outfile: join(privateBuild, 'dist/agentmux.js'),
    bundle: true, platform: 'node', format: 'esm', packages: 'external', alias: aliases, metafile: true, sourcemap: false })
  const cliInputs = Object.keys(cliBuild.metafile.inputs)
  for (const path of ['agentmux.ts', 'agentmux-cli-commands.ts', 'agent-native-session-confirmation.ts', 'rpc-native-codec.ts']) {
    if (!cliInputs.some(input => input.endsWith('/' + path))) throw new Error('Private actual CLI did not load source: ' + path)
  }
  await writeFile(join(evidence, 'cli-source-inputs.json'), JSON.stringify({ inputs: cliInputs, artifactSHA256: sha(await readFile(join(privateBuild, 'dist/agentmux.js'))) }, null, 2))
  const storeBuild = await build({ entryPoints: [join(repo, 'packages/core/src/agent-session-store.ts')], outfile: join(privateBuild, 'dist/store.js'),
    bundle: true, platform: 'node', format: 'esm', packages: 'external', alias: aliases, metafile: true })
  if (!Object.keys(storeBuild.metafile.inputs).some(input => input.endsWith('packages/core/src/agent-session-store.ts'))) throw new Error('Private restore did not load owning source')
  await writeFile(join(evidence, 'restart-source-inputs.json'), JSON.stringify({ inputs: Object.keys(storeBuild.metafile.inputs), artifactSHA256: sha(await readFile(join(privateBuild, 'dist/store.js'))) }, null, 2))
  for (const input of [...cliInputs, ...Object.keys(storeBuild.metafile.inputs)]) {
    const path = relative(repo, resolve(repo, input))
    if (!/^packages\/(core|demand|relay)\/(src\/|package\.json$)/u.test(path)) throw new Error('Private bundle escaped current workspace source: ' + path)
    candidates.set(path, sha(await readFile(join(repo, path))))
  }
  for (const mutation of ['', 'diagnose-before-source-fact', 'drop-source-save-diagnostic', 'mislabel-source-cas-stale', 'skip-candidate', 'promote-claude-sidechain', 'ignore-observation-version', 'keep-unknown-source', 'keep-old-interaction', 'discard-confirmation-history', 'replay-old-prompt', 'forget-historical-source', 'overwrite-confirmed-source-with-unknown', 'hide-history-save-failure', 'skip-history-save-failure-source-fence', 'disconnect-rpc', '']) {
    const name = mutation || (receipts.length ? 'control-after-mutants' : 'control'), loaded = join(evidence, name + '.loaded.jsonl')
    await writeFile(loaded, '')
    let result
    try { const value = await exec(process.execPath, [join(repo, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'packages/core/test/fixtures/native-session-change/vitest.owning.config.mts'],
      { cwd: repo, env: { ...process.env, AGENTMUX_TEST_OBJECT_CLI: join(privateBuild, 'bin/agentmux'), AMX_SOURCE_CHANGE_MUTATION: mutation,
        AMX_SOURCE_CHANGE_LOADED: loaded, AMX_SOURCE_CONFIRM_STORE_MODULE: join(privateBuild, 'dist/store.js') }, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }); result = { code: 0, ...value } }
    catch (error) { result = { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' } }
    await writeFile(join(evidence, name + '.log'), result.stdout + result.stderr)
    const loadedFacts = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
    if (!loadedFacts.length || !loadedFacts.some(fact => fact.path === 'packages/core/src/client.ts')) throw new Error('Empty or stale source test load')
    for (const fact of loadedFacts) {
      const candidate = candidates.get(fact.path)
      if (candidate && candidate !== fact.originalSHA256) throw new Error('Source changed during the same candidate gate: ' + fact.path)
      candidates.set(fact.path, fact.originalSHA256)
    }
    if (mutation && !loadedFacts.some(fact => fact.mutation === mutation)) throw new Error('Mutation did not load')
    if ((!mutation && result.code !== 0) || (mutation && result.code === 0)) throw new Error('Unexpected control/mutant result: ' + name + '\n' + result.stdout + result.stderr)
    if (mutation) {
      assert.ok(Number.isInteger(result.code) && result.code > 0)
      assert.match(result.stdout + result.stderr, /AssertionError/)
      assert.match(result.stdout + result.stderr, /Tests\s+[1-9]\d* failed/)
    } else assert.match(result.stdout + result.stderr, /Tests\s+[1-9]\d* passed/)
    receipts.push({ name, code: result.code, loaded: loadedFacts.length, changed: loadedFacts.filter(fact => fact.mutation) })
    process.stdout.write(name + ': ' + (result.code === 0 ? 'green' : 'red') + '\n')
  }
  // Native confirmation's durable ACK depends on the same Store/Registry owner as lifecycle writes.
  const durabilityDirectory = join(evidence, 'durability')
  const durabilityRun = await exec(process.execPath, [join(repo, 'packages/core/scripts/verify-session-durability.mjs'), durabilityDirectory],
    { cwd: repo, env: process.env, timeout: 180000, maxBuffer: 4 * 1024 * 1024 })
  await writeFile(join(evidence, 'durability-gate.log'), durabilityRun.stdout + durabilityRun.stderr)
  const durabilityPath = join(durabilityDirectory, 'receipt.json'), durabilityBytes = await readFile(durabilityPath)
  const durabilityReceipt = JSON.parse(durabilityBytes)
  assert.equal(durabilityReceipt.status, 'passed')
  assert.equal(durabilityReceipt.receipts.length, 4)
  assert.ok(Object.keys(durabilityReceipt.candidateSources).length > 0)
  for (const [path, hash] of Object.entries(durabilityReceipt.candidateSources)) {
    if (candidates.has(path)) assert.equal(hash, candidates.get(path), 'Durability gate consumed another candidate: ' + path)
    assert.equal(sha(await readFile(join(repo, path))), hash, 'Durability source drift: ' + path)
    candidates.set(path, hash)
  }
  for (const [path, hash] of Object.entries(durabilityReceipt.verificationInputs)) {
    assert.equal(sha(await readFile(join(repo, path))), hash, 'Durability verification drift: ' + path)
    verificationInputs[path] = hash
  }
  const scan = await exec('rg', ['-n', 'confirmAgentNativeSession|parseAgentNativeSessionConfirmation|agent.native.confirm|nativeSessionTransition|discoverClaudeNativeSession', 'packages/core/src'], { cwd: repo })
  const rows = scan.stdout.trim().split('\n').filter(row => !/\/types.ts:|\/index.ts:|\/agent-native-session-confirmation.ts:|\/public-rpc.ts:|\/hosted-client-contract.ts:/u.test(row))
  if (!rows.some(row => row.startsWith('packages/core/src/public-rpc-service.ts:')) || !rows.some(row => row.startsWith('packages/core/src/agentmux-cli-commands.ts:')) ||
    !rows.some(row => row.startsWith('packages/core/src/providers/claude.ts:'))) throw new Error('Missing nonempty production consumers')
  await writeFile(join(evidence, 'production-consumers.txt'), rows.join('\n') + '\n')
  for (const [path, hash] of candidates) if (sha(await readFile(join(repo, path))) !== hash) throw new Error('Source changed after gate: ' + path)
  for (const [path, hash] of Object.entries(verificationInputs)) if (sha(await readFile(join(repo, path))) !== hash) throw new Error('Verification inputs changed during gate: ' + path)
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify({ source: 'actual current source + private actual CLI bundle', userRuntimeTouched: false,
    receipts, candidateSources: Object.fromEntries(candidates), verificationInputs, productionConsumers: rows.length,
    durability: { receipt: durabilityPath, sha256: sha(durabilityBytes), status: 'passed', mutations: durabilityReceipt.receipts.length,
      controls: durabilityReceipt.runs.filter(run => run.code === 0).map(run => run.name) },
    boundaries: { runtime: 'Actual private native PIDs/process groups/FDs and input bytes, with mocked Runtime adapter status/ACK; no user Runtime or upstream auth is touched.',
      currentMain: 'Unique declared main record opened in the actual Run process group; legitimate launchers may own the child writer. A foreign main writer in that group can still be misattributed without Provider-specific positive executable/parent-lineage proof.',
      interaction: 'Private echo permission contribution retains real Provider discovery/history, exact tool/option/Run/response and real process input; its frame uses actual private pipe output with a fixture screen adapter. This does not authenticate or certify an upstream CLI menu.',
      restoration: 'Independent Node process reads the actual source-bundled durable Store; Desktop workface/restart and visual consumption belong to T-002.' },
    redLines: { physicalCapability: 'Only stale/unknown exact adoption or typed old-source responses are rejected; healthy raw input reaches the private real process.',
      processVsFlow: 'Bypassing the target guard could write an old permission into another current conversation; no healthy Run is disabled.',
      inBandRecovery: 'Native CLI remains usable; inspect/refresh and exact user adoption reconcile the current binding.',
      obtainablePrerequisite: 'Provider must prove one current main; absent/sidechain/ambiguous evidence stays unknown with no adopt capability.' } }, null, 2) + '\n')
} finally { await rm(privateBuild, { recursive: true, force: true }) }
