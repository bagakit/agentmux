import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../../..')
const helper = 'packages/git/src/project-identity.ts'
const owner = 'packages/git/src/git-repository.ts'
const adapter = 'apps/desktop/src/main/git-service.ts'
const ipc = 'apps/desktop/src/main/ipc.ts', preload = 'apps/desktop/src/preload/index.ts'
const sidebar = 'apps/desktop/src/renderer/src/components/WorkspaceSidebar.tsx'
const associations = 'apps/desktop/src/renderer/src/hooks/useGitProjectAssociations.ts'
const sources = [helper, owner, adapter, ipc, preload, 'apps/desktop/src/shared/git-contracts.ts',
  'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/renderer/src/lib/api.ts']
const tests = ['apps/desktop/test/git-project-identity.test.ts', 'apps/desktop/test/git-project-identity-ipc.test.ts']
const captured = [helper, owner, adapter, ipc, preload, ...tests]
const inputs = [...sources, ...tests, sidebar, associations, 'apps/desktop/scripts/verify-git-project-identity.mjs',
  'vitest.config.ts', 'vitest.setup.ts', 'vitest.dist-freshness.ts', 'tsconfig.base.json', 'apps/desktop/tsconfig.json', 'pnpm-lock.yaml']
const dependencyInputs = ['packages/core/package.json', 'packages/core/src/index.ts', 'packages/core/src/execution-host.ts',
  'packages/core/dist/index.js', 'packages/core/dist/index.d.ts', 'packages/core/dist/execution-host.js', 'packages/core/dist/execution-host.d.ts',
  'packages/demand/package.json', 'packages/demand/src/index.ts', 'packages/demand/dist/src/index.js', 'packages/demand/dist/src/index.d.ts']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const read = file => fs.readFile(path.isAbsolute(file) ? file : path.join(root, file))
const json = async file => JSON.parse(await read(file))
const hashes = async (files = inputs) => Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await read(file))])))
const evidence = path.join(root, '.tmp/git-project-identity')
await fs.mkdir(evidence, { recursive: true, mode: 0o700 })
const run = path.join(evidence, ("run-" + (globalThis.crypto.randomUUID()) + "")); await fs.mkdir(run, { mode: 0o700 })
const receipt = { schema: 'agentmux.git-project-identity.source.v1', passed: false, sourceRoot: root, runRoot: run,
  sharedSourceModified: false, sharedDistModified: false, originalAppOrRunTouched: false, checks: [], errors: [],
  boundary: 'Private real-Git repositories and actual preload/Main bridge with unrelated native owners isolated. SSH transport, Sidebar presentation and ordinary Electron restart qualify separately.' }
const write = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })

async function execute(args, logPath) {
  const log = await fs.open(logPath, 'w', 0o600)
  try { return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env }, stdio: ['ignore', log.fd, log.fd] })
    child.once('error', reject); child.once('exit', (code, signal) => signal ? reject(Error(`Private test terminated by ${signal}`)) : resolve(code))
  }) } finally { await log.close() }
}

async function consumers() {
  const ts = createRequire(import.meta.url)('typescript')
  const required = [
    { definition: helper, file: owner, expression: 'normalizeGitProjectRemote' },
    { definition: owner, file: adapter, expression: 'this.repository(workspaceId, config).projectIdentity' },
    { definition: adapter, file: ipc, expression: 'git.projectIdentity' },
    { definition: ipc, file: preload, expression: 'ipcRenderer.invoke', channel: 'git:projectIdentity' },
    { definition: preload, file: associations, expression: 'api.git.projectIdentity' },
    { definition: associations, file: sidebar, expression: 'useGitProjectAssociations' }
  ], found = []
  for (const entry of required) {
    assert.notEqual(entry.definition, entry.file)
    const source = (await read(entry.file)).toString(), ast = ts.createSourceFile(entry.file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), hits = []
    const visit = node => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === entry.expression &&
        (!entry.channel || node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === entry.channel)) hits.push(node.getText(ast))
      ts.forEachChild(node, visit)
    }
    visit(ast)
    assert.ok(hits.length > 0, `A non-import production consumer is required: ${entry.expression} in ${entry.file}`)
    found.push({ ...entry, sourceSHA256: sha(source), hits })
  }
  return found
}

try {
  receipt.head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  receipt.inputsBefore = await hashes()
  receipt.dependencyInputsBefore = await hashes(dependencyInputs)
  const typeConfig = path.join(run, 'owning-types.json'), typeLog = path.join(run, 'owning-types.log')
  await write(typeConfig, { extends: path.join(root, 'apps/desktop/tsconfig.json'),
    compilerOptions: { types: ['node', path.join(root, 'apps/desktop/node_modules/vite/client')] },
    include: tests.map(file => path.join(root, file)) })
  const typeArgs = ['node_modules/typescript/bin/tsc', '--project', typeConfig, '--noEmit']
  const typeExit = await execute(typeArgs, typeLog)
  receipt.owningTypecheck = { command: [process.execPath, ...typeArgs], exitCode: typeExit, log: typeLog, logSHA256: sha(await read(typeLog)) }
  assert.equal(typeExit, 0, 'The actual owning source/test contracts must typecheck')
  const canonical = 'return `${url.hostname.toLowerCase()}${port}/${path}`'
  const host = 'const host = this.hostFor(workspace.hostId)'
  const source = "const source = names.includes('origin') ? 'origin' : names.length === 1 ? names[0]! : null"
  const port = "const port = url.port && url.port !== defaults[url.protocol] ? `:${url.port}` : ''"
  const failure = "return unavailable(scrubGitCredentials(error instanceof Error ? error.message : 'Repository source observation failed.'))"
  const mutations = [
    { id: 'retain-userinfo', target: helper, before: canonical,
      after: 'return `${url.username ? `${url.username}:${url.password}@` : ""}${url.hostname.toLowerCase()}${port}/${path}`',
      assertion: 'Repository source normalization must exclude credentials and preserve equivalent addresses' },
    { id: 'borrow-local-host', target: adapter, before: host,
      after: "const host = this.hostFor('local')",
      assertion: 'The exact Workspace Host must own the real-Git source read' },
    { id: 'borrow-upstream-source', target: owner, before: source,
      after: "const source = names.includes('upstream') ? 'upstream' : names.includes('origin') ? 'origin' : names.length === 1 ? names[0]! : null",
      assertion: 'A fork origin must not become its upstream Project' },
    { id: 'drop-custom-port', target: helper, before: port, after: "const port = ''",
      assertion: 'Different explicit source ports must remain different Project hints' },
    { id: 'flatten-unavailable', target: owner, before: failure,
      after: "return { kind: 'no-remote', hostId: workspace.hostId, repoPath: workspace.path }",
      assertion: 'A failed Git read must remain unavailable rather than no-remote' }
  ]
  const phases = [{ id: 'baseline', target: helper, before: canonical, after: canonical }]
  for (const mutation of mutations) phases.push(mutation, { ...mutation, id: 'restored-' + mutation.id, after: mutation.before, assertion: undefined })
  let names
  for (const phase of phases) {
    assert.deepEqual(await hashes(), receipt.inputsBefore, 'Owning Source/test/caller inputs changed')
    assert.deepEqual(await hashes(dependencyInputs), receipt.dependencyInputsBefore, 'Public package inputs changed during qualification')
    const original = (await read(phase.target)).toString()
    assert.equal(original.split(phase.before).length - 1, 1, 'Exactly one actual owning product block is required')
    const consumed = original.replace(phase.before, phase.after)
    const own = path.join(run, phase.id); await fs.mkdir(own, { mode: 0o700 })
    const config = path.join(own, 'readonly.config.mts'), report = path.join(own, 'vitest.json'), capture = path.join(own, 'consumed-source.json')
    const expected = Object.fromEntries(captured.map(file => [path.join(root, file), receipt.inputsBefore[file]]))
    const configSource = `import base from ${JSON.stringify(path.join(root, 'apps/desktop/test/git-workbench.config.mts'))};
import {defineConfig} from 'vitest/config';import {createHash} from 'node:crypto';import {readFileSync,writeFileSync} from 'node:fs';
const expected=${JSON.stringify(expected)},target=${JSON.stringify(path.join(root, phase.target))},before=${JSON.stringify(phase.before)},after=${JSON.stringify(phase.after)},loaded:Record<string,unknown>={};
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export default defineConfig({...base,root:${JSON.stringify(root)},plugins:[...(base.plugins??[]),{name:'readonly-git-project-identity',enforce:'pre',transform(code:string,id:string){
const file=id.split('?')[0];if(!(file in expected))return;
if(hash(readFileSync(file))!==expected[file]||hash(code)!==expected[file])throw Error('Frozen actual Source must equal the Vite input');
let consumed=code;if(file===target){if(code.split(before).length-1!==1)throw Error('Actual owning product block count differs');consumed=code.replace(before,after);}
loaded[file]={sourceSHA256:expected[file],viteInputSHA256:hash(code),consumedCodeSHA256:hash(consumed),bytes:Buffer.byteLength(consumed),changed:consumed!==code};
writeFileSync(${JSON.stringify(capture)},JSON.stringify(loaded,null,2));return{code:consumed,map:null};
}}],test:{...base.test,include:${JSON.stringify(tests)},passWithNoTests:false,fileParallelism:false,maxWorkers:1}});
`
    await fs.writeFile(config, configSource, { mode: 0o600 })
    await fs.writeFile(path.join(own, 'original-block.txt'), phase.before, { mode: 0o600 })
    await fs.writeFile(path.join(own, 'consumed-block.txt'), phase.after, { mode: 0o600 })
    const args = ['node_modules/vitest/vitest.mjs', 'run', ...tests, '--config', config, '--maxWorkers=1', '--reporter=json', '--outputFile=' + report]
    const exitCode = await execute(args, path.join(own, 'vitest.log'))
    const result = await json(report), loaded = await json(capture)
    assert.deepEqual(result.testResults.map(suite => path.relative(root, suite.name)).sort(), [...tests].sort())
    const cases = result.testResults.flatMap(suite => suite.assertionResults.map(item => ({ name: item.fullName, status: item.status,
      failureMessages: item.failureMessages ?? [] }))).sort((a, b) => a.name.localeCompare(b.name))
    assert.ok(cases.length > 0); assert.equal(cases.length, result.numTotalTests); assert.equal(result.numPendingTests, 0)
    names ??= cases.map(item => item.name); assert.deepEqual(cases.map(item => item.name), names)
    for (const file of captured) {
      const item = loaded[path.join(root, file)]; assert.ok(item?.bytes > 0, `Actual owning module must be consumed: ${file}`)
      assert.equal(item.sourceSHA256, receipt.inputsBefore[file]); assert.equal(item.viteInputSHA256, receipt.inputsBefore[file])
      assert.equal(item.consumedCodeSHA256, sha(file === phase.target ? consumed : await read(file)))
      assert.equal(item.changed, file === phase.target && phase.before !== phase.after)
    }
    const failed = cases.filter(item => item.status === 'failed')
    const check = { id: phase.id, target: phase.target, command: [process.execPath, ...args], exitCode, total: cases.length,
      passed: result.numPassedTests, failed: result.numFailedTests, cases, loaded, report, reportSHA256: sha(await read(report)),
      originalBlockSHA256: sha(phase.before), consumedBlockSHA256: sha(phase.after), qualifiedAssertionRed: false, qualifiedOriginalGreen: false }
    receipt.checks.push(check); await write(path.join(run, 'receipt.json'), receipt)
    if (phase.assertion) {
      assert.equal(exitCode, 1); assert.equal(result.success, false); assert.ok(failed.length > 0)
      assert.ok(failed.some(item => item.failureMessages.some(message => message.startsWith('AssertionError:') && message.includes(phase.assertion))),
        'The named product assertion must fail; fixture/setup failure cannot qualify')
      for (const item of failed) assert.ok(item.failureMessages.some(message => message.startsWith('AssertionError:') && tests.some(file => message.includes(path.join(root, file) + ':'))),
        'Module/setup/type/timeout failures cannot qualify as product assertion RED')
      check.qualifiedAssertionRed = true
    } else {
      assert.equal(exitCode, 0); assert.equal(result.success, true); assert.equal(result.numFailedTests, 0)
      assert.equal(result.numPassedTests, cases.length); assert.ok(cases.every(item => item.status === 'passed'))
      check.qualifiedOriginalGreen = true
    }
    assert.deepEqual(await hashes(), receipt.inputsBefore, 'Readonly transform changed an original input')
    process.stdout.write(`${phase.id}: ${check.passed}/${check.total} passed, ${check.failed} actual assertion failures\n`)
  }
  receipt.productionCallers = await consumers()
  receipt.inputsAfter = await hashes(); assert.deepEqual(receipt.inputsAfter, receipt.inputsBefore)
  receipt.dependencyInputsAfter = await hashes(dependencyInputs); assert.deepEqual(receipt.dependencyInputsAfter, receipt.dependencyInputsBefore)
  receipt.passed = true
} catch (error) { receipt.errors.push({ name: error.name, message: error.message, stack: error.stack }) }
finally {
  await write(path.join(run, 'receipt.json'), receipt)
  if (receipt.passed) await write(path.join(evidence, 'source-receipt.json'), receipt)
}
console.log(JSON.stringify({ passed: receipt.passed, receipt: path.join(run, 'receipt.json'), sha256: sha(await read(path.join(run, 'receipt.json'))),
  checks: receipt.checks.map(({ id, total, passed, failed }) => ({ id, total, passed, failed })), errors: receipt.errors }))
if (!receipt.passed) process.exitCode = 1
