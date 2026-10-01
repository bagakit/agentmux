import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const base = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const output = join(base, '.tmp/mote-default-context')
await mkdir(output, { recursive: true })
const attempt = await mkdtemp(join(output, 'attempt-'))
const isolated = join(attempt, 'source')
await mkdir(isolated)
const paths = {
  defaults: 'apps/desktop/src/shared/scratch-topics.ts',
  topics: 'apps/desktop/src/main/scratch-topics.ts',
  controller: 'apps/desktop/src/main/runtime-controller.ts'
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const original = Object.fromEntries(await Promise.all(Object.values(paths).map(async path => [path, await readFile(join(base, path))])))
const config = 'apps/desktop/scripts/fixtures/mote-default-context/vitest.owning.config.mts'
const tests = ['apps/desktop/test/mote-default-knowledge.test.ts', 'apps/desktop/test/space-role-soul-session.test.ts']
const receipt = { schema: 'agentmux.mote-default-context-verification.v1', passed: false,
  source: Object.fromEntries(Object.entries(original).map(([path, bytes]) => [path, digest(bytes)])),
  runs: [], callers: [], failure: null, transportBoundary: 'Real ScratchTopics, RuntimeController and current Core envelope/provider planning; isolated kernel transport, no live user Run.' }
const run = async (label, expected) => {
  const child = spawn(process.execPath, [join(base, 'node_modules/vitest/vitest.mjs'), 'run', '--config', join(isolated, config),
    'test/mote-default-knowledge.test.ts', 'test/space-role-soul-session.test.ts', '--maxWorkers=1'],
    { cwd: isolated, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => { stdout += bytes })
  child.stderr.on('data', bytes => { stderr += bytes })
  const status = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => done({ code, signal })) })
  await writeFile(join(attempt, label + '.stdout'), stdout)
  await writeFile(join(attempt, label + '.stderr'), stderr)
  const evidence = stdout + stderr
  const collected = /Tests\s+8 (?:passed|failed)/.test(evidence) || /Tests\s+\d+ failed \| \d+ passed \(8\)/.test(evidence)
  const assertion = /AssertionError:|expected .* to /.test(evidence)
  receipt.runs.push({ label, expected, ...status, collected, assertion })
  assert.equal(status.signal, null, 'Environment termination is not behavioral proof')
  assert.ok(collected, 'The owning tests were not all collected')
  if (expected === 'GREEN') assert.equal(status.code, 0, evidence)
  else { assert.notEqual(status.code, 0, 'The product mutant stayed green'); assert.ok(assertion, 'Setup/loading failures are not an assertion RED') }
  console.log(label + ': ' + expected)
}
const replaceOnce = (source, from, to) => {
  assert.equal(source.split(from).length, 2, 'A mutation must match one exact product anchor')
  return source.replace(from, to)
}
try {
  await cp(join(base, 'apps/desktop/src'), join(isolated, 'apps/desktop/src'), { recursive: true })
  for (const path of [...tests, config, 'apps/desktop/scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts', 'vitest.setup.ts']) {
    await mkdir(resolve(join(isolated, path), '..'), { recursive: true })
    await cp(join(base, path), join(isolated, path))
  }
  await symlink(join(base, 'packages'), join(isolated, 'packages'))
  await symlink(join(base, 'node_modules'), join(isolated, 'node_modules'))
  await symlink(join(base, 'apps/desktop/node_modules'), join(isolated, 'apps/desktop/node_modules'))
  await writeFile(join(isolated, 'package.json'), '{"type":"module"}')
  for (const path of Object.values(paths)) assert.equal(digest(await readFile(join(isolated, path))), receipt.source[path])

  const callerChecks = [
    { symbol: 'DEFAULT_MOTE_SOUL', definition: paths.defaults, caller: paths.topics, anchor: 'await ensureRegularFile(join(directory, MOTE_SOUL_PATH), DEFAULT_MOTE_SOUL)' },
    { symbol: 'DEFAULT_PMO_TEAMS_TOPIC_WIKI', definition: paths.defaults, caller: paths.topics, anchor: 'await writeRegularFile(join(directory, SCRATCH_TOPIC_WIKI_PATH), topicId === PMO_TEAMS_TOPIC_ID ? DEFAULT_PMO_TEAMS_TOPIC_WIKI : DEFAULT_TOPIC_WIKI)' },
    { symbol: 'prepareAgent', definition: paths.topics, caller: paths.controller, anchor: 'preparedTopic = await this.scratchTopics.prepareAgent(scratch, request.scratchTopicId, {' },
    { symbol: 'createAgentWithDelivery', definition: 'packages/core', caller: paths.controller, anchor: 'const receipt = await client.createAgentWithDelivery({' }
  ]
  for (const item of callerChecks) {
    assert.notEqual(item.caller, item.definition)
    assert.ok(!/test|\.test\./.test(item.caller), 'A test is not a product caller')
    const source = await readFile(join(base, item.caller), 'utf8')
    const lines = source.split('\n')
    const index = lines.findIndex(line => line.includes(item.anchor))
    assert.ok(index >= 0 && !lines[index].trim().startsWith('import '), 'External product caller was absent')
    receipt.callers.push({ symbol: item.symbol, path: item.caller, line: index + 1, source: lines[index].trim() })
  }
  assert.equal(receipt.callers.length, 4)
  await run('baseline', 'GREEN')
  const variants = [
    { id: 'knowledge-default', path: paths.defaults,
      from: 'Read back a saved change before saying it is remembered.', to: 'Assume a write succeeded without reading it back.' },
    { id: 'saved-personality-injection', path: paths.topics,
      from: '${snapshot.soul.content}', to: '' },
    { id: 'core-outbound-delivery', path: paths.controller,
      from: '...(preparedTopic ? { agentMuxNote: preparedTopic.prompt } : {}),', to: '...(preparedTopic ? { agentMuxNote: "" } : {}),' },
    { id: 'preserve-user-files', path: paths.topics,
      from: '    return false\n  }\n}\n\nasync function readRegularFile', to: '    await writeRegularFile(path, content)\n    return false\n  }\n}\n\nasync function readRegularFile' },
    { id: 'primary-duplicate-role', path: paths.defaults,
      from: 'export const DEFAULT_PMO_TEAMS_TOPIC_WIKI = `# Mote Guide\n',
      to: 'export const DEFAULT_PMO_TEAMS_TOPIC_WIKI = `# Mote Guide\n\n${MOTE_COORDINATION_ROLE}\n' },
    { id: 'explicit-reset-default', path: paths.topics,
      from: 'await writeRegularFile(join(directory, SCRATCH_TOPIC_WIKI_PATH), topicId === PMO_TEAMS_TOPIC_ID ? DEFAULT_PMO_TEAMS_TOPIC_WIKI : DEFAULT_TOPIC_WIKI)',
      to: 'await writeRegularFile(join(directory, SCRATCH_TOPIC_WIKI_PATH), DEFAULT_TOPIC_WIKI)' },
    { id: 'recovery-reloads-personality', path: paths.controller,
      from: '      : null\n    const result = await client.ensureAgentContinuity({',
      to: '      : null\n    if (scratch && scratchTopicId) await this.scratchTopics.prepareAgent(scratch, scratchTopicId, { providerId: stored.providerId, sessionId: control.agentSessionId })\n    const result = await client.ensureAgentContinuity({' }
  ]
  for (const variant of variants) {
    await writeFile(join(isolated, variant.path), replaceOnce(original[variant.path].toString('utf8'), variant.from, variant.to))
    try { await run(variant.id + '-red', 'RED') }
    finally {
      await writeFile(join(isolated, variant.path), original[variant.path])
      assert.equal(digest(await readFile(join(isolated, variant.path))), receipt.source[variant.path], 'Restoration changed the selected source')
    }
    await run(variant.id + '-restore', 'GREEN')
  }
  receipt.passed = true
} catch (error) {
  receipt.failure = error.stack
  process.exitCode = 1
} finally {
  for (const [path, bytes] of Object.entries(original)) assert.equal(digest(await readFile(join(base, path))), digest(bytes), 'The runner modified shared product source')
  await rm(isolated, { recursive: true, force: true })
  receipt.cleanup = { isolatedSourceRemoved: true, selectedProductUnmodified: true }
  await writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  await writeFile(join(output, 'last.json'), JSON.stringify({ receipt: join(attempt, 'receipt.json'), digest: digest(await readFile(join(attempt, 'receipt.json'))) }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, runs: receipt.runs.length, callers: receipt.callers.length, receipt: join(attempt, 'receipt.json') }))
}
