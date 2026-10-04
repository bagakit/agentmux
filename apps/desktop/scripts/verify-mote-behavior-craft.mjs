import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

assert.ok(process.argv.includes('--header'), 'Choose the bounded header task')
const base = resolve(import.meta.dirname, '../../..'), output = join(base, '.tmp/mote-behavior-header')
await mkdir(output, { recursive: true })
const attempt = await mkdtemp(join(output, 'attempt-')), isolated = join(attempt, 'source')
const surface = 'apps/desktop/src/renderer/src/components/SurfaceToolDock.tsx'
const config = 'apps/desktop/scripts/fixtures/mote-companion-workflows/vitest.header.config.mts'
const test = 'apps/desktop/test/mote-file-header.test.tsx'
const variants = [
  { id: 'mote-collection-returned', from: '{canCollectKnowledge ? <button type="button" className="icon-button" aria-label="Collect sources', to: '{true ? <button type="button" className="icon-button" aria-label="Collect sources' },
  { id: 'mote-root-broadened', from: "rootPath={mote ? mote.rootPath : topicRoot ?? ''}", to: "rootPath={''}" },
  { id: 'unconfirmed-root-broadened', from: 'selectedTopicId && !mote && topicRoot === null ? <div', to: 'false ? <div' },
  { id: 'ordinary-collection-removed', from: '{canCollectKnowledge ? <button type="button" className="icon-button" aria-label="Collect sources', to: '{false ? <button type="button" className="icon-button" aria-label="Collect sources' },
  { id: 'retry-never-refreshes', from: 'refreshScratchTopics(scratch.id, true)', to: 'refreshScratchTopics(scratch.id)' },
  { id: 'all-files-control-returned', from: '<div className="workspace-tool-context__actions">', to: '<div className="workspace-tool-context__actions">{mote ? <button type="button">Show all files</button> : null}' }
]
const checks = [
  { symbol: 'SurfaceToolDock', definition: surface, caller: 'apps/desktop/src/renderer/src/App.tsx', anchor: '<SurfaceToolDock ' },
  { symbol: 'FileExplorer', definition: 'apps/desktop/src/renderer/src/components/FileExplorer.tsx', caller: surface, anchor: '<FileExplorer ' },
  { symbol: 'TopicKnowledgeCapture', definition: 'apps/desktop/src/renderer/src/components/TopicKnowledgeEditor.tsx', caller: surface, anchor: '<TopicKnowledgeCapture ' }
]
const files = [...new Set([surface, test, config, ...checks.flatMap(check => [check.definition, check.caller])])]
const originals = Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(join(base, file))])))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const receipt = { passed: false, source: Object.fromEntries(files.map(file => [file, sha(originals[file])])), runs: [], callers: [],
  boundary: 'Actual production WorkspaceFilesTool, original FileExplorer and knowledge dialog in isolated DOM. Controlled native/filesystem replies, original manual input retained. Actual Renderer image approval is separate; no user App, Runtime, package or install claim.' }
async function run(label, expected) {
  const child = spawn(process.execPath, [join(base, 'node_modules/vitest/vitest.mjs'), 'run', '--config', join(isolated, config), '--maxWorkers=1'], { cwd: isolated, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''; child.stdout.on('data', bytes => { log += bytes }); child.stderr.on('data', bytes => { log += bytes })
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => done({ code, signal })) })
  await writeFile(join(attempt, label + '.log'), log)
  const collected = /Tests\s+(?:5 (?:passed|failed)|\d+ failed \| \d+ passed \(5\))/.test(log), assertion = /AssertionError:|expected .* to /.test(log)
  receipt.runs.push({ label, expected, ...code, collected, assertion })
  assert.equal(code.signal, null); assert.ok(collected, 'Complete nonempty original assertions required')
  if (expected === 'GREEN') assert.equal(code.code, 0, log)
  else { assert.notEqual(code.code, 0, 'Production mutant survived'); assert.ok(assertion, 'Load or syntax failure is not behavioral RED') }
  console.log(label + ': ' + expected)
}
try {
  await mkdir(isolated)
  for (const path of ['apps/desktop/src', 'apps/desktop/test/fixtures', 'apps/desktop/test/helpers', 'packages/core/src']) await cp(join(base, path), join(isolated, path), { recursive: true })
  for (const path of [test, config, 'apps/desktop/scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts', 'packages/core/package.json', 'vitest.setup.ts', 'tsconfig.base.json', 'apps/desktop/tsconfig.json']) {
    await mkdir(dirname(join(isolated, path)), { recursive: true }); await cp(join(base, path), join(isolated, path))
  }
  for (const path of ['node_modules', 'apps/desktop/node_modules', 'apps/desktop/resources', 'packages/core/node_modules', 'packages/demand', 'packages/layout', 'packages/client-ui']) await symlink(join(base, path), join(isolated, path))
  await writeFile(join(isolated, 'package.json'), '{"type":"module"}')
  for (const check of checks) {
    assert.notEqual(check.definition, check.caller)
    const line = originals[check.caller].toString().split('\n').findIndex(line => line.includes(check.anchor) && !line.trim().startsWith('import '))
    assert.ok(line >= 0, check.symbol + ' needs an external production consumer'); receipt.callers.push({ ...check, line: line + 1 })
  }
  assert.ok(receipt.callers.length); await run('baseline', 'GREEN')
  for (const variant of variants) {
    const source = originals[surface].toString(); assert.equal(source.split(variant.from).length, 2, 'One exact loaded mutation anchor required')
    await writeFile(join(isolated, surface), source.replace(variant.from, variant.to))
    try { await run(variant.id + '-red', 'RED') } finally { await writeFile(join(isolated, surface), originals[surface]) }
    await run(variant.id + '-restored', 'GREEN')
  }
  receipt.passed = true
} catch (error) { receipt.error = error.stack; process.exitCode = 1 }
finally {
  receipt.sourceChanges = []
  for (const file of files) if (sha(await readFile(join(base, file))) !== receipt.source[file]) receipt.sourceChanges.push(file)
  if (receipt.sourceChanges.length) { receipt.passed = false; receipt.error = 'The owning candidate changed during verification'; process.exitCode = 1 }
  await rm(isolated, { recursive: true, force: true }); receipt.privateSourceRemoved = true
  await writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, runs: receipt.runs.length, callers: receipt.callers.length, receipt: join(attempt, 'receipt.json') }))
}
