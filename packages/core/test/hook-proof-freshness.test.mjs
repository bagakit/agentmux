import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const ownerPath = new URL('../scripts/verify-hook-carrier-baseline.mjs', import.meta.url)
const ownerSource = await readFile(ownerPath, 'utf8')
const parsed = ts.createSourceFile(ownerPath.pathname, ownerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
assert.equal(parsed.parseDiagnostics.length, 0, 'The current production verifier must parse')
const declarations = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'gate')
assert.equal(declarations.length, 1, 'Select the one actual cached gate owner')
const declaration = declarations[0], source = declaration.getText(parsed)
const sha = value => createHash('sha256').update(value).digest('hex')

function gateOwner(helpers, omitNativeInputCheck = false) {
  let body = source
  if (omitNativeInputCheck) {
    const checks = []
    const visit = node => {
      if (ts.isIfStatement(node) && node.expression.getText(parsed) === 'proof.inputs') checks.push(node)
      ts.forEachChild(node, visit)
    }
    visit(declaration)
    assert.equal(checks.length, 1, 'Mutate the exact current native-input check')
    const check = checks[0]
    body = body.slice(0, check.getStart(parsed) - declaration.getStart(parsed)) +
      body.slice(check.end - declaration.getStart(parsed))
  }
  return vm.compileFunction(`${body}\nreturn gate`, Object.keys(helpers), { filename: ownerPath.pathname })(...Object.values(helpers))
}

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'amx-hook-proof-freshness-'))
  try {
    const directory = join(root, 'gates'), native = join(root, 'installed-native-owner.py'), current = join(root, 'current-owner.mjs')
    const proof = join(root, 'native-proof.json'), gatePath = join(directory, 'hermes', 'positive', 'gate.json')
    const file = path => isAbsolute(path) ? path : join(root, path)
    const json = async path => JSON.parse(await readFile(file(path), 'utf8'))
    const snapshot = async paths => Object.fromEntries(await Promise.all([...new Set(paths)].sort().map(async path => [path, sha(await readFile(file(path)))])))
    const checks = [], artifacts = []
    const artifact = async path => artifacts.push({ path, sha256: sha(await readFile(file(path))) })
    const helpers = { assert, join, directory, file, json, snapshot, sha, readFile, artifact, checks }
    await mkdir(join(directory, 'hermes', 'positive'), { recursive: true })
    await writeFile(current, 'current production owner\n'); await writeFile(native, 'original native owner\n')
    await writeFile(proof, JSON.stringify({ passed: true, assertions: 1, inputs: await snapshot([native]) }))
    await writeFile(gatePath, JSON.stringify({ passed: true, inputs: await snapshot([current]),
      checks: [{ qualified: true, assertions: 1 }], artifacts: [{ path: proof, sha256: sha(await readFile(proof)) }] }))
    await run({ ...helpers, artifacts, native, current, proof, gatePath })
  } finally { await rm(root, { recursive: true, force: true }) }
}

async function refusesNativeDrift(gate) {
  await assert.rejects(() => gate('hermes', 'positive'), error => error instanceof assert.AssertionError &&
    error.message.includes('Stale referenced proof inputs:'), 'The cached gate must reread its original native input')
}

test('the current cached gate accepts unchanged current and native file bytes', () => fixture(async f => {
  await gateOwner(f)('hermes', 'positive')
  assert.deepEqual(f.checks, [{ label: 'hermes/positive', assertions: 1, qualified: true }])
  assert.equal(f.artifacts[0].path, f.gatePath)
}))

test('the current cached gate rejects changed current owner bytes', () => fixture(async f => {
  await writeFile(f.current, 'changed production owner\n')
  await assert.rejects(() => gateOwner(f)('hermes', 'positive'), error => error instanceof assert.AssertionError &&
    error.message.includes('Stale hermes/positive gate'))
}))

test('the cached gate checks artifact bytes before trying to parse changed JSON', () => fixture(async f => {
  await writeFile(f.proof, '{ invalid replacement JSON')
  await assert.rejects(() => gateOwner(f)('hermes', 'positive'), error => error instanceof assert.AssertionError && error.operator === 'strictEqual')
}))

test('the current cached gate rereads native bytes while both stored envelopes stay unchanged', () => fixture(async f => {
  const before = await f.snapshot([f.proof, f.gatePath])
  await writeFile(f.native, 'changed installed native owner\n')
  await refusesNativeDrift(gateOwner(f))
  assert.deepEqual(await f.snapshot([f.proof, f.gatePath]), before)
  assert.equal(f.checks.length, 0)
}))

test('the same native-drift oracle kills omission of the actual owner check semantically', () => fixture(async f => {
  await writeFile(f.native, 'changed installed native owner\n')
  await refusesNativeDrift(gateOwner(f))
  const mutant = gateOwner(f, true)
  await assert.rejects(() => refusesNativeDrift(mutant), error => error instanceof assert.AssertionError &&
    error.code === 'ERR_ASSERTION' && error.message.startsWith('Missing expected rejection:'))
}))
