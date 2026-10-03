import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const evidence = resolve(root, ".local/state/session-status-diagnosis-fixture/root-name-implementation")
await mkdir(evidence, { recursive: true })
const config = resolve(evidence, 'source-vitest.config.mts')
await writeFile(config, `import { defineConfig } from 'vitest/config';import { readFileSync,existsSync } from 'node:fs';import { resolve } from 'node:path';
const pkg=JSON.parse(readFileSync('packages/core/package.json','utf8'));
const alias=Object.entries(pkg.exports).flatMap(([key,value])=>{const replacement=resolve('packages/core',value.import.replace('./dist/','src/').replace(/\\.js$/,'.ts'));return existsSync(replacement)?[{find:key==='.'?'@agentmux/core':'@agentmux/core'+key.slice(1),replacement}]:[]}).sort((a,b)=>b.find.length-a.find.length);alias.unshift({find:'@agentmux/demand/goals',replacement:resolve('packages/demand/src/goals.ts')},{find:'@agentmux/demand',replacement:resolve('packages/demand/src/index.ts')});
export default defineConfig({resolve:{alias},define:{__AGENTMUX_WEB_PREVIEW__:'true'},test:{include:['apps/desktop/test/name-change-owners.test.ts'],setupFiles:[resolve('vitest.setup.ts')],testTimeout:20000}});`)
const cases = [
  { id: 'settings-explicit-intent', path: 'apps/desktop/src/main/settings-resources-control.ts', old: "Object.hasOwn(request.changes, 'label') ?", next: "false && Object.hasOwn(request.changes, 'label') ?", test: 'actual Settings resource adapter' },
  { id: 'config-owner-record', path: 'apps/desktop/src/main/config-owner.ts', old: 'return this.ports.nameAudit\n', next: 'return false && this.ports.nameAudit\n', test: 'actual serialized Config commit' },
  { id: 'trusted-context', path: 'apps/desktop/src/main/name-change-audit.ts', old: "request?.context ?? unknownNameContext('name-owner')", next: "unknownNameContext('name-owner')", test: 'actual serialized Config commit' },
  { id: 'owner-replay', path: 'apps/desktop/src/main/name-change-audit.ts', old: 'if (record.replayed) throw', next: 'if (false && record.replayed) throw', test: 'does not replay a previous operation' },
  { id: 'partial-result', path: 'apps/desktop/src/main/name-change-audit.ts', old: 'if (outcomes.some(outcome => outcome.status === \'rejected\')) throw', next: 'if (false && outcomes.some(outcome => outcome.status === \'rejected\')) throw', test: 'retains an applied name' },
  { id: 'topic-owner-record', path: 'apps/desktop/src/main/scratch-topics.ts', old: 'return this.nameAudit ? await this.nameAudit.run', next: 'return false && this.nameAudit ? await this.nameAudit.run', test: 'serializes Topic and Mote' },
  { id: 'browser-owner-record', path: 'apps/desktop/src/main/browser-task-assets.ts', old: 'return this.options.nameAudit\n', next: 'return false && this.options.nameAudit\n', test: 'captures a Browser task name' },
  { id: 'host-history-coverage', path: 'apps/desktop/src/main/name-history.ts', old: "if (!query.target || query.target.kind === 'demand')", next: "if (query.target?.kind === 'demand')", test: 'queries the actual Spatial and Demand' }
]
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const paths = [...new Set([...cases.map(item => item.path), 'apps/desktop/src/main/control-ipc-bridge.ts', 'apps/desktop/test/name-change-owners.test.ts'])]
const originals = new Map(await Promise.all(paths.map(async path => [path, await readFile(resolve(root, path))])))
const sourceHashes = Object.fromEntries([...originals].map(([path, bytes]) => [path, hash(bytes)]))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_') && key !== 'NODE_OPTIONS'))
function run(label, test) {
  const args = ['node_modules/vitest/vitest.mjs', 'run', '--config', config, '--maxWorkers=1', ...(test ? ['-t', test] : [])]
  const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout: 60000 })
  const output = (result.stdout ?? '') + (result.stderr ?? '')
  return { label, exitCode: result.status, passed: result.status === 0 && /Tests\s+\d+ passed/.test(output), assertionFailure: /AssertionError/.test(output), output }
}
const mutations = []
try {
  const baseline = run('baseline'); await writeFile(resolve(evidence, 'owner-baseline.log'), baseline.output)
  if (!baseline.passed) throw new Error('Owner baseline is not GREEN.')
  for (const item of cases) {
    const original = originals.get(item.path); const source = original.toString()
    if (source.split(item.old).length !== 2) throw new Error('Mutation anchor is not exact: ' + item.id)
    let red
    try {
      await writeFile(resolve(root, item.path), source.replace(item.old, item.next))
      red = run(item.id + '-red', item.test)
      await writeFile(resolve(evidence, item.id + '-red.log'), red.output)
      if (red.passed || !red.assertionFailure) throw new Error('Mutation did not produce Assertion RED: ' + item.id)
    } finally { await writeFile(resolve(root, item.path), original) }
    const restored = hash(await readFile(resolve(root, item.path))) === sourceHashes[item.path]
    const green = run(item.id + '-green', item.test)
    await writeFile(resolve(evidence, item.id + '-green.log'), green.output)
    if (!restored || !green.passed) throw new Error('Exact restore is not GREEN: ' + item.id)
    mutations.push({ id: item.id, path: item.path, red: true, restored, green: true, originalSha256: sourceHashes[item.path] })
  }
  const callers = [
    ['apps/desktop/src/main/settings-resources-control.ts', 'requested: typeof request.changes.label', 'explicit Settings label attempts'],
    ['apps/desktop/src/main/ipc.ts', 'const nameAudit = new NameChangeAudit(spatialState)', 'Main constructs the durable owner recorder'],
    ['apps/desktop/src/main/ipc.ts', 'args.scratchTopics.setNameAudit(nameAudit)', 'actual Topic/Mote owner'],
    ['apps/desktop/src/main/ipc.ts', 'nameAudit,', 'single serialized ConfigOwner'],
    ['apps/desktop/src/main/ipc.ts', '{ nameAudit }', 'Browser task asset owner'],
    ['apps/desktop/src/main/ipc.ts', "handle('files:move'", 'actual file/directory/URL shortcut move entry'],
    ['apps/desktop/src/main/ipc.ts', 'controlBridge.nameRequest(controlRequestId,', 'trusted admitted request through Renderer relay'],
    ['apps/desktop/src/main/ipc.ts', 'desktopNameHistory(spatialState, demands, query)', 'public typed host history']
  ]
  for (const [path, anchor] of callers) if (!(await readFile(resolve(root, path), 'utf8')).includes(anchor)) throw new Error('Missing production caller: ' + anchor)
  const final = run('restored-final'); await writeFile(resolve(evidence, 'owner-final.log'), final.output)
  if (!final.passed || mutations.length !== cases.length || callers.length === 0) throw new Error('Incomplete owner proof.')
  for (const path of paths) if (hash(await readFile(resolve(root, path))) !== sourceHashes[path]) throw new Error('Input changed during owner qualification: ' + path)
  await writeFile(resolve(evidence, 'owner-proof.json'), JSON.stringify({ passed: true, sourceHashes, mutations, callers, productionCallerHashes: Object.fromEntries(await Promise.all([...new Set(callers.map(([path]) => path))].map(async path => [path, hash(await readFile(resolve(root, path)))]))), userRuntimeTouched: false, scope: 'actual source owner classes, temporary durable Spatial/Demand/Topic and in-memory Browser owner fixture; Main IPC callers inspected; actual GUI qualification is separate', cleanup: { privateFixtures: 'test finally removed temporary owner roots', exactSourceRestored: true } }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, tests: 13, mutations: mutations.length, callers: callers.length, receipt: resolve(evidence, 'owner-proof.json') }))
} finally {
  for (const path of new Set(cases.map(item => item.path))) await writeFile(resolve(root, path), originals.get(path))
}
