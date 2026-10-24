import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '../../..')
const run = (args, env = process.env) => spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
const arguments_ = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'apps/desktop/test/native-package.config.mts']
const baseline = run(arguments_)
process.stdout.write(baseline.stdout); process.stderr.write(baseline.stderr)
assert.equal(baseline.status, 0, 'Native package source behavior must pass')
for (const [mutation, title] of Object.entries({ binary: 'packager verifies exact', profile: 'release wrapper refuses', leaf: 'native signature qualification', bundle: 'native signature qualification' })) {
  const result = run([...arguments_, '-t', title], { ...process.env, NATIVE_PACKAGE_MUTATION: mutation })
  assert.notEqual(result.status, 0, `Surviving native package mutation: ${mutation}`)
  assert.match(result.stdout + result.stderr, /AssertionError|promise resolved|promise rejected|expected.*to/i, `Mutation must fail in its behavior assertion, not source loading: ${result.stdout}\n${result.stderr}`)
  console.log(`killed: native package ${mutation}`)
}
// Check real packaging consumers as well as injected-runner behavior; these are different proofs.
const packagePath = join(root, 'apps/desktop/scripts/package-macos.mjs')
const source = await readFile(packagePath, 'utf8')
const tree = ts.createSourceFile(packagePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
assert.equal(tree.parseDiagnostics.length, 0)
const main = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'main')
assert.ok(main?.body)
const calls = []
function visit(node) {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.push({ name: node.expression.text, position: node.getStart(tree), args: node.arguments.map(a => a.getText(tree)) })
  ts.forEachChild(node, visit)
}
visit(main.body)
const one = name => { const found = calls.filter(call => call.name === name); assert.equal(found.length, 1, `Expected actual ${name} consumer`); return found[0] }
const copy = one('copyRuntimeApplication'), check = one('verifyNativeDesktopCopy'), sign = one('signMacosApplication'), verify = one('verifyNativeDesktopSigning')
assert.deepEqual(check.args, ['stagedApp', 'repositoryRoot']); assert.deepEqual(verify.args, ['stagedApp', 'signingPlan'])
assert.ok(copy.position < check.position && check.position < sign.position && sign.position < verify.position && verify.position < one('createDmg').position)
const scripts = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8')).scripts
assert.match(scripts.prebuild, /pnpm build:native-desktop(?: &&|$)/)
assert.match(scripts.predev, /pnpm build:native-desktop --development(?: &&|$)/)
console.log('Native package source fixtures and nonempty production wiring passed; stub compiler/signer is not Swift, code-signing or TCC proof.')
if (!process.argv.includes('--source-only')) {
  // The existing production entry owns the single real build/assembly/signature check. No install.
  const candidate = run([join(root, 'apps/desktop/scripts/package-macos.mjs'), '--app-only'])
  process.stdout.write(candidate.stdout); process.stderr.write(candidate.stderr)
  assert.equal(candidate.status, 0, 'Actual Native/Desktop application delivery failed')
}
