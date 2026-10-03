import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const root = fileURLToPath(new URL('../../../', import.meta.url)), ts = createRequire(import.meta.url)('typescript')
const base = 'apps/desktop/src/renderer/src/', evidence = join(root, '.tmp/host-identity')
await mkdir(evidence, { recursive: true })
const sha = data => createHash('sha256').update(data).digest('hex')
const files = ['components/HostBadge.tsx','components/FocusProjectLanes.tsx','components/TopRowChrome.tsx','components/WorkspaceBoard.tsx','components/ProjectGroupsTree.tsx','components/WorkspaceSidebar.tsx','lib/region-execution-host.ts','styles/host-identity.css','styles/board.css','styles/index.css'].map(f => base + f)
async function hashes() { return Object.fromEntries(await Promise.all(files.map(async f => [f, sha(await readFile(join(root, f)))]))) }
const verificationFiles = [...files, 'apps/desktop/test/host-identity.test.tsx', 'apps/desktop/test/vitest.host-identity.config.mts', 'apps/desktop/scripts/verify-host-identity.mjs']
async function verificationHashes() { return Object.fromEntries(await Promise.all(verificationFiles.map(async file => [file, sha(await readFile(join(root, file)))]))) }
const receipt = { verificationInputs: await verificationHashes(), passed: false, boundary: 'Actual mounted product components and original Store; preview API facts, no live SSH/Agent or lifecycle claim. Visual review is separately consumed.', inputHashes: await hashes(), callers: [], mutants: [] }
async function run(name, mutation, testcase) {
  const mutantPath = join(evidence, 'current-mutant.json')
  if (mutation) await writeFile(mutantPath, JSON.stringify(mutation))
  const args = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'apps/desktop/test/vitest.host-identity.config.mts', '--configLoader', 'runner', '--no-cache', '--reporter=json', '--outputFile', join(evidence, `${name}.json`)]
  if (testcase) args.push('-t', testcase)
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false', AGENTMUX_HOST_IDENTITY_MUTANT: mutation ? mutantPath : '' }, stdio: ['ignore','pipe','pipe'] })
    let log = ''; child.stdout.on('data', data => log += data); child.stderr.on('data', data => log += data)
    child.once('error', reject); child.once('exit', code => resolve({ code, log }))
  })
  await writeFile(join(evidence, `${name}.log`), result.log)
  const report = JSON.parse(await readFile(join(evidence, `${name}.json`), 'utf8'))
  return { exitCode: result.code, passed: report.numPassedTests, failed: report.numFailedTests, pending: report.numPendingTests, report: `${name}.json` }
}
try {
  if (!process.argv.includes('--source-only')) {
    const source = JSON.parse(await readFile(join(evidence, 'source-proof.json'), 'utf8'))
    assert.equal(source.passed, true); assert.deepEqual(source.verificationInputs, receipt.verificationInputs)
    assert.equal(source.baseline.exitCode, 0); assert.equal(source.restored.exitCode, 0)
    assert.ok(source.baseline.passed >= 8 && source.mutants.length === 10 && source.callers.length === 5)
    for (const mutant of source.mutants) assert.ok(mutant.failed > 0 && mutant.exitCode !== 0)
    const review = JSON.parse(await readFile(join(evidence, 'visual-review.json'), 'utf8'))
    assert.equal(review.verdict, 'accepted'); assert.ok(review.images.length > 0)
    assert.equal(review.nativeLayout.baselinePassed, true); assert.equal(review.nativeLayout.mutantKilled, true)
    for (const [file, hash] of Object.entries(receipt.inputHashes)) assert.equal(review.inputHashes[file], hash, `Review must consume this candidate: ${file}`)
    for (const image of review.images) assert.equal(sha(await readFile(image.path)), image.sha256)
    receipt.baseline = source.baseline; receipt.restored = source.restored; receipt.mutants = source.mutants; receipt.callers = source.callers; receipt.visual = review; receipt.passed = true
    console.log(JSON.stringify({ passed: true, consumedSource: true, tests: source.baseline.passed, mutants: source.mutants.length, visual: review.verdict }))
  } else {
  for (const file of files.filter(f => /components\/(?!HostBadge)/.test(f))) {
    const source = await readFile(join(root, file), 'utf8'), ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const calls = []; function visit(node) {
      if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(ast) === 'HostBadge') calls.push({ jsx: 'HostBadge', position: node.pos })
      ts.forEachChild(node, visit)
    } visit(ast); assert.ok(calls.length, `${file} must actually render the production HostBadge`); receipt.callers.push({ file, calls })
  }
  receipt.baseline = await run('baseline'); assert.equal(receipt.baseline.exitCode, 0); assert.ok(receipt.baseline.passed >= 8)
  const mutations = [
    { id: 'hide-folder-machine-icon', target: base + 'components/WorkspaceSidebar.tsx', before: '<HostBadge context="Host" compact host={hostIdentityProjection(section.hostId, config?.hosts.find(host => host.id === section.hostId))} />', after: '<Folders size={14} />', testcase: 'Folder sections identify' },
    { id: 'display-host-as-execution', target: base + 'lib/region-execution-host.ts', before: "session.kind === 'agent' ? session.control.hostId : session.hostId", after: 'session.hostId', testcase: 'shared identity preserves' },
    { id: 'wrong-config-identity', target: base + 'lib/region-execution-host.ts', before: 'configured?.id === id', after: 'true', testcase: 'retains exact machine identity' },
    { id: 'unknown-as-local', target: base + 'lib/region-execution-host.ts', before: "kind: host?.kind ?? 'unknown'", after: "kind: host?.kind ?? 'local'", testcase: 'retains exact machine identity' },
    { id: 'hide-focus-host', target: base + 'components/FocusProjectLanes.tsx', before: '<HostBadge context="Host" host={hostIdentityProjection(lane.hostId, hosts?.find(host => host.id === lane.hostId))} />', after: '', testcase: 'Focus distinguishes' },
    { id: 'breadcrumb-opaque-id', target: base + 'components/TopRowChrome.tsx', before: 'hosts?.find(host => host.id === remoteHost)', after: 'undefined', testcase: 'breadcrumb consumes' },
    { id: 'board-wrong-host', target: base + 'components/WorkspaceBoard.tsx', before: 'hostIdentityProjection(hostId, hosts?.find(host => host.id === hostId))', after: "hostIdentityProjection('local', hosts?.find(host => host.id === 'local'))", testcase: 'Board presents' },
    { id: 'group-wrong-host', target: base + 'components/ProjectGroupsTree.tsx', before: 'hostIdentityProjection(member.hostId, hosts?.find(host => host.id === member.hostId))', after: "hostIdentityProjection('local', hosts?.find(host => host.id === 'local'))", testcase: 'mixed Group members' },
    { id: 'hide-unknown-context', target: base + 'components/HostBadge.tsx', before: "if (context === 'Execution Host' && host.kind === 'local') return null", after: "if (context === 'Execution Host') return null", testcase: 'suppresses only confirmed local' },
    { id: 'hide-local-host-globally', target: base + 'components/HostBadge.tsx', before: "if (context === 'Execution Host' && host.kind === 'local') return null", after: "if (host.kind === 'local') return null", testcase: 'mixed Group members' }
  ]
  for (const mutation of mutations) {
    const source = await readFile(join(root, mutation.target), 'utf8'); assert.ok(source.includes(mutation.before), mutation.id)
    const result = await run(mutation.id, mutation, mutation.testcase)
    assert.notEqual(result.exitCode, 0, mutation.id); assert.ok(result.failed > 0, 'A loaded owning assertion must fail, not just compilation or collection')
    receipt.mutants.push({ ...mutation, ...result })
  }
  receipt.restored = await run('restored'); assert.equal(receipt.restored.exitCode, 0)
  assert.deepEqual(await hashes(), receipt.inputHashes, 'Production bytes stay unchanged during loaded mutations')
  assert.deepEqual(await verificationHashes(), receipt.verificationInputs)
  receipt.passed = true
  }
} finally { await writeFile(join(evidence, process.argv.includes('--source-only') ? 'source-proof.json' : 'delivery-proof.json'), JSON.stringify(receipt, null, 2) + '\n') }
console.log(JSON.stringify({ passed: receipt.passed, tests: receipt.baseline.passed, mutants: receipt.mutants.length, consumers: receipt.callers.length, visual: receipt.visual?.verdict ?? 'not-consumed' }))
