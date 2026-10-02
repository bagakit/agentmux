import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve, relative } from 'node:path'
const root = resolve(import.meta.dirname, '../../../../..')
const evidence = join(root, '.tmp/ctxmux-p22-main-integration')
const hash = value => createHash('sha256').update(value).digest('hex')
await mkdir(evidence, { recursive: true })
const config = 'apps/desktop/scripts/fixtures/ctxmux-p22-qualification/vitest.main-integration.config.mts'
const wire = 'packages/core/test/p22-output-gap-wire.test.ts'
const title = 'rejects foreign-run Gap locally while retaining the actual Hosted input lease'
const mutations = [
  { name: 'hosted-local-evidence-validation', source: 'packages/core/src/hosted-client.ts', test: wire, title,
    before: 'try { parseOutputGapEvidence(event.evidence) }', after: 'try { /* mutation: forward invalid evidence */ }' },
  { name: 'hosted-unknown-scope', source: 'packages/core/src/hosted-client.ts', test: wire, title,
    before: "publisher.publish({ type: 'agent-error', code: 'CONTROL_PROTOCOL_ERROR',", after: "publisher.publish({ type: 'agent-error', ...(event.agentSessionId ? { agentSessionId: event.agentSessionId } : {}), code: 'CONTROL_PROTOCOL_ERROR'," },
  { name: 'platform-manifest-consumer', source: 'packages/core/src/runtime-paths.ts', test: 'packages/core/test/p22-artifact-contract.test.ts',
    title: 'binds the actual linux/x64 artifact through its production platform consumer',
    before: 'return ctxmuxArtifacts.manifests[artifactPlatform as keyof typeof ctxmuxArtifacts.manifests]',
    after: "return ctxmuxArtifacts.manifests['darwin-arm64']" },
  { name: 'independent-reader-fault-scope', source: 'packages/core/src/client.ts', test: 'packages/core/test/ctxmux-native-service.test.ts',
    title: 'keeps a real public raw reader live across independent input and derived-view faults',
    before: "      if (event.type === 'connection-state' && event.state !== 'restored') publisher.publish({",
    after: "      if (event.type === 'agent-error' && event.evidence?.run?.runId === session.run.runId) publisher.publish(event)\n      else if (event.type === 'connection-state' && event.state !== 'restored') publisher.publish({" },
  { name: 'independent-reader-own-fault', source: 'packages/core/src/ctxmux-run-adapter.ts', test: 'packages/core/test/ctxmux-native-service.test.ts',
    title: 'reports its own Attachment iterator failure through the public raw reader without stopping healthy lanes',
    before: "if (!closed) listener({ type: 'error', runId, error: translateCtxmuxError(error) })",
    after: 'if (!closed) this.errorListener?.(translateCtxmuxError(error), runId)' }
]
async function run(args, name, allowFailure = false) {
  const child = spawn('pnpm', args, { cwd: root, env: { ...process.env, FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk.toString(); assert(output.length < 8*1024*1024) })
  const code = await new Promise((done, fail) => { child.once('error', fail); child.once('exit', (code, signal) => signal ? fail(new Error(`Own proof ended by ${signal}`)) : done(code)) })
  const path = join(evidence, `${name}.log`); await writeFile(path, output)
  if (!allowFailure) assert.equal(code, 0, `Own proof failed: ${relative(root, path)}`)
  return { code, log: relative(root, path), logSha256: hash(output) }
}
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1].split(',') : null
const selected = mutations.filter(item => !only || only.includes(item.name))
assert(selected.length > 0)
const receipts = only ? JSON.parse(await readFile(join(evidence,'mutations.json'),'utf8')).mutations.filter(item => !only.includes(item.name)) : []
for (const item of selected) {
  const path = join(root, item.source), original = await readFile(path, 'utf8')
  assert.equal(original.split(item.before).length-1, 1, `Mutation must bind one actual consumer: ${item.name}`)
  const broken = original.replace(item.before, item.after)
  const redPath = join(evidence, `${item.name}-red.json`), greenPath = join(evidence, `${item.name}-green.json`)
  const command = ['exec', 'vitest', 'run', '--config', config, '--maxWorkers=1', item.test, '-t', item.title, '--reporter=json']
  let red
  try {
    await writeFile(path, broken)
    await run(['--filter', '@agentmux/core...', 'build'], `${item.name}-red-build`)
    red = await run([...command, `--outputFile=${redPath}`], `${item.name}-red`, true)
    const report = JSON.parse(await readFile(redPath, 'utf8'))
    const assertions = report.testResults.flatMap(suite => suite.assertionResults)
    const failed = assertions.filter(value => value.status === 'failed')
    assert.notEqual(red.code, 0); assert.equal(report.numFailedTests, 1); assert.equal(failed.length, 1)
    assert(failed[0].fullName.includes(item.title))
    assert(failed[0].failureMessages.some(message => message.includes('AssertionError:')), 'Timeout/setup failure cannot sign behavior RED')
  } finally {
    await writeFile(path, original)
    assert.equal(hash(await readFile(path)), hash(original))
    await run(['--filter', '@agentmux/core...', 'build'], `${item.name}-restored-build`)
  }
  const green = await run([...command, `--outputFile=${greenPath}`], `${item.name}-green`)
  const result = JSON.parse(await readFile(greenPath, 'utf8'))
  assert.equal(result.numPassedTests, 1); assert.equal(result.numFailedTests, 0)
  receipts.push({ ...item, before: undefined, after: undefined, sourceSha256: hash(original), mutatedSha256: hash(broken), restoredSha256: hash(await readFile(path)), testSha256: hash(await readFile(join(root,item.test))), red:true,green:true,
    redLog:red,greenLog:green, redReport:{path:relative(root,redPath),sha256:hash(await readFile(redPath))},greenReport:{path:relative(root,greenPath),sha256:hash(await readFile(greenPath))} })
  await writeFile(join(evidence,'mutations.json'),JSON.stringify({passed:false,mutations:receipts},null,2)+'\n')
  console.log(`${item.name}: behavior RED, exact restored GREEN`)
}
assert.equal(receipts.length, mutations.length)
await writeFile(join(evidence,'mutations.json'),JSON.stringify({passed:true,mutations:receipts},null,2)+'\n')
