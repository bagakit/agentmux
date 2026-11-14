import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { buildWorkspaceMoveHelper } from '../../host/scripts/build-workspace-move-helper.mjs'
import { acceptedPromotionMutations } from './fixtures/agent-promotion/owner-mutations.mjs'
const repository = resolve(import.meta.dirname, '../../..')
const checks = process.argv.find(arg => arg.startsWith('--checks='))?.slice('--checks='.length) ?? 'all'
assert.ok(['core', 'host', 'ui', 'all'].includes(checks), 'Choose a nonempty known verification scope')
const parent = join(repository, '.tmp/agent-mote-promotion'); await mkdir(parent, { recursive: true })
const output = await mkdtemp(join(parent, 'accepted-owner-')), results = [], sources = new Map()
let nativeHelper
const sha = value => createHash('sha256').update(value).digest('hex')
async function run(args, env = {}) {
  return await new Promise((yes, no) => {
    const child = spawn(process.execPath, args, { cwd: repository, env: { ...process.env, NODE_NO_WARNINGS: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
    child.once('error', no); child.once('close', code => yes({ code, stdout, stderr }))
  })
}
async function trace(path) {
  const rows = (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
  assert.ok(rows.length, 'The real original production owner must be loaded')
  for (const row of rows) { const file = row.path ?? row.file; assert.equal(sha(await readFile(join(repository, file))), row.originalSHA256 ?? row.original); sources.set(file, row.originalSHA256 ?? row.original) }
  const unique = new Map()
  for (const row of rows) unique.set(JSON.stringify([row.path ?? row.file, row.mutation, row.originalSHA256 ?? row.original, row.loadedSHA256 ?? row.loaded, row.role]), row)
  const loaded = [...unique.values()]; await writeFile(path, loaded.map(row => JSON.stringify(row)).join('\n') + '\n'); return loaded
}
async function core(mutation) {
  const name = 'core-' + (mutation ?? 'baseline'), loadedPath = join(output, name + '-loaded.jsonl'), reportPath = join(output, name + '.json')
  const response = await run(['node_modules/vitest/vitest.mjs', 'run', '--config', 'packages/core/test/agent-promotion.config.mts', '--reporter=json', '--outputFile', reportPath],
    { AGENT_PROMOTION_CORE_LOADED: loadedPath, ...(mutation ? { AGENT_PROMOTION_CORE_MUTANT: mutation } : {}) })
  await writeFile(join(output, name + '.log'), response.stdout + response.stderr)
  const report = JSON.parse(await readFile(reportPath, 'utf8')), loaded = await trace(loadedPath)
  if (!mutation) { assert.equal(response.code, 0, response.stdout + response.stderr); assert.ok(report.numPassedTests >= 6); assert.equal(report.numFailedTests, 0) }
  else { assert.equal(response.code, 1); assert.ok(report.numFailedTests > 0); assert.equal(report.numRuntimeErrorTestSuites ?? 0, 0); assert.ok(loaded.some(row => row.mutation === mutation && row.originalSHA256 !== row.loadedSHA256)) }
  results.push({ name, code: response.code, passed: report.numPassedTests, failed: report.numFailedTests, loaded }); console.log(name + ': verified')
}
if (checks === 'core' || checks === 'all') {
  await core(); if (!process.argv.includes('--baseline-only')) for (const mutation of ['source-zone-binding', 'foreign-receipt', 'omit-owner']) await core(mutation)
}
if (checks === 'host' || checks === 'all') {
  let helper = join(repository, 'apps/host/resources/bin/agentmux-workspace-move')
  try { assert.ok((await stat(helper)).size > 0) } catch { helper = (await buildWorkspaceMoveHelper()).output }
  assert.ok(helper, 'The original directory-identity helper is required')
  nativeHelper = { path: relative(repository, helper), sha256: sha(await readFile(helper)) }
  sources.set(nativeHelper.path, nativeHelper.sha256)
  const nativeSource = 'apps/host/native/workspace-move.c'; sources.set(nativeSource, sha(await readFile(join(repository, nativeSource))))
  const fixture = join(repository, 'apps/desktop/scripts/fixtures/agent-promotion'), loader = pathToFileURL(join(fixture, 'source-loader.mjs'))
  const registration = `import { register } from 'node:module'; register(${JSON.stringify(loader.href)}, ${JSON.stringify(import.meta.url)});`
  const cases = [null, ...(process.argv.includes('--baseline-only') ? [] : acceptedPromotionMutations)]
  for (const mutation of cases) {
    const name = mutation?.name ?? 'host-baseline', data = await mkdtemp(join(tmpdir(), 'amxp-')), loadedPath = join(output, name + '-loaded.jsonl')
    try {
      const response = await run(['--import', 'data:text/javascript,' + encodeURIComponent(registration), join(fixture, 'scenario.mjs'), data, mutation?.mode ?? 'baseline', helper],
        { AGENT_PROMOTION_HOST_LOADED: loadedPath, ...(mutation ? { AGENT_PROMOTION_HOST_MUTANT: mutation.name } : {}) })
      await writeFile(join(output, name + '.log'), response.stdout + response.stderr)
      const loaded = await trace(loadedPath)
      if (!mutation) { assert.equal(response.code, 0, response.stdout + response.stderr); await writeFile(join(output, 'host-result.json'), await readFile(join(data, 'result.json'))) }
      else { assert.notEqual(response.code, 0, 'Production mutation survived: ' + mutation.name); assert.match(response.stderr, /AssertionError \[ERR_ASSERTION\]/u); assert.doesNotMatch(response.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module|SyntaxError/u); assert.ok(loaded.some(row => row.role === 'host' && row.path === mutation.path && row.originalSHA256 !== row.loadedSHA256), 'The actual Host must load the changed owner') }
      results.push({ name, code: response.code, loaded }); console.log(name + ': verified')
    } finally { await rm(data, { recursive: true, force: true }) }
  }
  assert.equal(sha(await readFile(helper)), nativeHelper.sha256, 'The original Native helper changed during this measurement')
}
// UI composition belongs to its current shared Takeover owner, not the retired dialog.
if (checks === 'ui' || checks === 'all') {
  for (const mutation of [undefined, 'settings-save', 'header-menu', 'shared-owner']) {
    const name = 'ui-' + (mutation ?? 'baseline'), response = await run(['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/test/agent-promotion-ui.config.mts'], mutation ? { AGENT_PROMOTION_UI_MUTATION: mutation } : {})
    await writeFile(join(output, name + '.log'), response.stdout + response.stderr)
    if (!mutation) assert.equal(response.code, 0, response.stdout + response.stderr)
    else { assert.equal(response.code, 1); assert.match(response.stdout + response.stderr, /AssertionError/u); assert.doesNotMatch(response.stdout + response.stderr, /Cannot find module|SyntaxError|No test files found/u) }
    results.push({ name, code: response.code }); console.log(name + ': verified')
  }
}
for (const file of ['apps/desktop/scripts/verify-agent-promotion.mjs', 'apps/desktop/scripts/fixtures/agent-promotion/scenario.mjs', 'apps/desktop/scripts/fixtures/agent-promotion/host.ts', 'apps/desktop/scripts/fixtures/agent-promotion/source-loader.mjs', 'apps/desktop/scripts/fixtures/agent-promotion/owner-mutations.mjs', 'packages/core/test/agent-promotion.test.ts', 'packages/core/test/agent-promotion.config.mts', 'packages/core/package.json', 'apps/host/package.json', 'pnpm-lock.yaml']) sources.set(file, sha(await readFile(join(repository, file))))
await writeFile(join(output, 'receipt.json'), JSON.stringify({ passed: true, checks, runtime: { node: process.version, platform: process.platform, arch: process.arch }, ...(nativeHelper ? { nativeHelper } : {}), results, sourceDigests: Object.fromEntries(sources), boundary: 'Original accepted v1 operations through actual source CLI and persistent Host owners. No new-admission fixture, copied dependencies, bundled product, user Agent or installed App.' }, null, 2) + '\n')
console.log('evidence: ' + relative(repository, output))
