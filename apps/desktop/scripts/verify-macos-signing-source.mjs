import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve, join } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '../../..')
const require = createRequire(import.meta.url)
const sourcePath = join(root, 'apps/desktop/scripts/macos-signing.mjs')
const testPath = join(root, 'apps/desktop/test/package-macos-signing.test.ts')
const packagePath = join(root, 'apps/desktop/scripts/package-macos.mjs')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

async function callers() {
  const source = await readFile(packagePath, 'utf8')
  const tree = ts.createSourceFile(packagePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  assert.equal(tree.parseDiagnostics.length, 0, 'Production package script failed to parse')
  const main = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'main')
  assert.ok(main?.body, 'No production main body')
  const calls = []
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.push({ name: node.expression.text, position: node.getStart(tree), args: node.arguments.map(argument => argument.getText(tree)) })
    ts.forEachChild(node, visit)
  }
  visit(main.body)
  const one = name => { const found = calls.filter(call => call.name === name); assert.equal(found.length, 1, `${name} needs one nonempty production caller`); return found[0] }
  const preflight = one('preflightMacosSigning'), sign = one('signMacosApplication'), verify = one('verifyMacosSigning')
  for (const call of calls.filter(call => ['sourceIdentity', 'copyRuntimeApplication', 'createDmg', 'installApplication'].includes(call.name) || call.name === 'run')) {
    assert.ok(preflight.position < call.position, `Signing qualification must precede ${call.name}`)
  }
  assert.deepEqual(sign.args, ['stagedApp', 'signingPlan'])
  assert.deepEqual(verify.args, ['stagedApp', 'signingPlan'])
  assert.ok(sign.position < verify.position, 'Application signing must precede verification')
  assert.ok(verify.position < one('createDmg').position, 'Signature verification must precede createDmg')
  assert.ok(verify.position < one('installApplication').position, 'Signature verification must precede installApplication')
  const importNode = tree.statements.find(node => ts.isImportDeclaration(node) && node.moduleSpecifier.text === './macos-signing.mjs')
  assert.ok(importNode?.importClause?.namedBindings && ts.isNamedImports(importNode.importClause.namedBindings))
  const imports = importNode.importClause.namedBindings.elements.map(node => node.name.text)
  for (const symbol of ['preflightMacosSigning', 'signMacosApplication', 'verifyMacosSigning']) assert.ok(imports.includes(symbol))
  return { nonempty: true, count: 3, file: 'apps/desktop/scripts/package-macos.mjs', sourceSha256: sha(source), calls: [preflight, sign, verify] }
}

const mutations = [
  ['stable-request-becomes-adhoc', "if (!/^[A-F0-9]{40}$/.test(fingerprint)) reject('Stable macOS delivery requires an exact certificate SHA1.')", "if (!/^[A-F0-9]{40}$/.test(fingerprint)) return Object.freeze({ kind: 'ad-hoc' })"],
  ['wrong-certificate-selected', 'match[1].toUpperCase() === fingerprint', 'true'],
  ['ambiguous-certificate-accepted', 'selected.length !== 1', 'selected.length === 0'],
  ['signer-validation-disabled', "identityValidation: plan.kind === 'certificate'", 'identityValidation: false'],
  ['implicit-hardening-enabled', 'hardenedRuntime: false', 'hardenedRuntime: true'],
  ['automatic-profile-enabled', 'preEmbedProvisioningProfile: false', 'preEmbedProvisioningProfile: true'],
  ['automatic-entitlements-enabled', 'preAutoEntitlements: false', 'preAutoEntitlements: true'],
  ['team-metadata-ignored', '!metadata.split(\'\\n\').includes(`TeamIdentifier=${plan.teamId}`)', 'false'],
  ['weak-identifier-only-source', 'hardenedRuntime: false, entitlements,', 'hardenedRuntime: false, entitlements, requirements: \'=designated => identifier "dev.agentmux.desktop"\','],
  ['native-boundary-test-omitted', "if (plan.kind === 'certificate') verification.push", 'if (false) verification.push'],
  ['native-requirement-treated-as-file', '`=identifier', '`identifier'],
  ['native-signature-not-verified', "await run('/usr/bin/codesign', [...verification, appPath])", '/* native verification omitted */'],
]

async function verifyMutations(evidence) {
  const original = await readFile(sourcePath), tests = await readFile(testPath)
  await mkdir(evidence, { recursive: true })
  const receipt = { scope: 'Source only; native runner and signer are test doubles, not lawful signing or OS acceptance', passed: false,
    inputs: { source: sha(original), tests: sha(tests), package: sha(await readFile(packagePath)) }, cases: [], artifacts: {} }
  const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
  const config = join(evidence, 'vitest.config.mjs')
  await writeFile(config, `export default { root: ${JSON.stringify(root)}, test: { environment: 'node', include: ['apps/desktop/test/package-macos-signing.test.ts'], maxWorkers: 1, fileParallelism: false, watch: false } }\n`)
  const run = async name => {
    const result = spawnSync(process.execPath, [vitest, 'run', '--config', config], { cwd: root, encoding: 'utf8', timeout: 30_000 })
    const log = `${result.stdout ?? ''}${result.stderr ?? ''}`
    await writeFile(join(evidence, name + '.log'), log)
    receipt.artifacts[name + '.log'] = sha(log)
    return { status: result.status, log }
  }
  try {
    const baseline = await run('candidate-owning')
    assert.equal(baseline.status, 0, baseline.log)
    assert.match(baseline.log, /Tests\s+[1-9]\d* passed/)
    for (const [name, before, after] of mutations) {
      const text = original.toString()
      assert.equal(text.split(before).length - 1, 1, `Nonunique mutation anchor: ${name}`)
      const changed = text.replace(before, after)
      try {
        await writeFile(sourcePath, changed)
        const red = await run(name)
        assert.ok(Number.isInteger(red.status) && red.status !== 0, `Mutation survived: ${name}`)
        assert.match(red.log, /AssertionError/, `Mutation failed outside behavior: ${name}`)
        assert.match(red.log, /Tests\s+[1-9]\d* failed/)
        receipt.cases.push({ name, mutatedSourceSha256: sha(changed), redExit: red.status })
      } finally { await writeFile(sourcePath, original) }
    }
    const restored = await run('restored-owning')
    assert.equal(restored.status, 0, restored.log)
    receipt.callers = await callers()
    receipt.passed = true
  } catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
  finally {
    await writeFile(sourcePath, original)
    receipt.restoredSourceSha256 = sha(await readFile(sourcePath))
    assert.equal(receipt.restoredSourceSha256, receipt.inputs.source)
    await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  }
  assert.equal(receipt.passed, true, receipt.failure?.message)
  console.log(JSON.stringify({ passed: true, sourceMutations: receipt.cases.length, productionCallers: receipt.callers.count, scope: 'Source only' }))
}

async function verifyCallerMutations(evidence) {
  const original = await readFile(packagePath)
  await mkdir(evidence, { recursive: true })
  const receipt = { scope: 'Production Source AST only; package script, build, signing and installation are never executed', passed: false,
    inputs: { package: sha(original), verifier: sha(await readFile(import.meta.filename)), node: process.version, typescript: ts.version }, cases: [], artifacts: {} }
  const run = async name => {
    const result = spawnSync(process.execPath, [import.meta.filename, 'callers'], { cwd: root, encoding: 'utf8', timeout: 10_000 })
    const log = `${result.stdout ?? ''}${result.stderr ?? ''}`
    await writeFile(join(evidence, name + '.log'), log)
    receipt.artifacts[name + '.log'] = sha(log)
    return { status: result.status, log }
  }
  const move = (source, line, anchor, after) => {
    for (const text of [line, anchor]) assert.equal(source.split(text).length - 1, 1, 'Production caller mutation needs a unique line')
    return source.replace(line, '').replace(anchor, after ? anchor + line : line + anchor)
  }
  const cases = [
    { name: 'preflight-after-first-production-build', expected: 'Signing qualification must precede run',
      change: source => move(source, "  await run('pnpm', ['--filter', '@agentmux/core...', 'build'], { cwd: repositoryRoot })\n", '  const signingPlan = await preflightMacosSigning()\n', false) },
    { name: 'verify-after-create-dmg', expected: 'Signature verification must precede createDmg',
      change: source => move(source, '    const signature = await verifyMacosSigning(stagedApp, signingPlan)\n', '    await createDmg(stagedApp, stagedDmg, temporaryRoot)\n', true) },
  ]
  try {
    const baseline = await run('candidate-callers')
    assert.equal(baseline.status, 0, baseline.log)
    assert.equal(JSON.parse(baseline.log).count, 3)
    for (const { name, expected, change } of cases) {
      const changed = change(original.toString())
      try {
        await writeFile(packagePath, changed)
        const red = await run(name)
        assert.ok(Number.isInteger(red.status) && red.status !== 0, `Production caller mutation survived: ${name}`)
        assert.match(red.log, /AssertionError/, `Production caller mutation failed outside assertion: ${name}`)
        assert.ok(red.log.includes(expected), `Production caller mutation missed its target assertion: ${name}`)
        receipt.cases.push({ name, mutatedPackageSha256: sha(changed), redExit: red.status, targetAssertion: expected })
      } finally { await writeFile(packagePath, original) }
    }
    const restored = await run('restored-callers')
    assert.equal(restored.status, 0, restored.log)
    receipt.callers = JSON.parse(restored.log)
    assert.equal(receipt.callers.count, 3)
    receipt.passed = true
  } catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
  finally {
    await writeFile(packagePath, original)
    receipt.restoredPackageSha256 = sha(await readFile(packagePath))
    assert.equal(receipt.restoredPackageSha256, receipt.inputs.package)
    await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  }
  assert.equal(receipt.passed, true, receipt.failure?.message)
  console.log(JSON.stringify({ passed: true, productionCallerMutations: receipt.cases.length, restoredProductionCallers: receipt.callers.count, scope: 'Source AST only' }))
}

const mode = process.argv[2]
if (mode === 'callers') console.log(JSON.stringify(await callers()))
else if (mode === 'mutations' || mode === 'caller-mutations') {
  const index = process.argv.indexOf('--evidence-dir')
  assert.ok(index >= 0 && process.argv[index + 1], 'An owned evidence directory is required')
  if (mode === 'caller-mutations') await verifyCallerMutations(resolve(process.argv[index + 1]))
  else await verifyMutations(resolve(process.argv[index + 1]))
} else throw Error('Expected callers, mutations or caller-mutations')
