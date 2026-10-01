import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { captureIdentity } from './fixtures/toolkit-custom-identity/capture.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), mode = process.argv[2]
assert.ok(process.argv.length === 3 && ['--owning', '--callers', '--capture', '--visual'].includes(mode), 'One explicit finite identity proof mode')
const base = resolve(root, ".bagakit/design/toolkit-custom-identity-fixture/formal"); await mkdir(base, { recursive: true })
const evidence = await mkdtemp(resolve(base, 'run-')), inputs = {}, results = [], exec = promisify(execFile)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const proofFiles = ['apps/desktop/scripts/verify-toolkit-custom-identity.mjs', 'apps/desktop/test/toolkit-custom-identity.test.tsx',
  ...['core-entry.ts', 'owner-entry.ts', 'entry.tsx', 'preload.cjs', 'main.cjs', 'index.html', 'capture.mjs', 'vitest.config.mts'].map(file => 'apps/desktop/scripts/fixtures/toolkit-custom-identity/' + file),
  'apps/desktop/scripts/fixtures/toolkit-preferences/vitest.config.mts', 'apps/desktop/scripts/fixtures/toolkit-custom-ui/tsconfig.owning.json', 'apps/desktop/scripts/fixtures/toolkit-custom/tsconfig.owning.json',
  'vitest.setup.ts', 'tsconfig.base.json']
async function bind(file) {
  const bytes = await readFile(resolve(root, file)); assert.ok(bytes.length, 'Nonempty actual input: ' + file)
  if (Object.hasOwn(inputs, file)) assert.equal(inputs[file].sha256, sha(bytes), 'Fixed candidate input: ' + file)
  else inputs[file] = { sha256: sha(bytes), bytes: bytes.length }
  return bytes
}
async function owning(name, mutant = 'baseline', pattern) {
  const directory = resolve(evidence, name); await mkdir(directory)
  const outputFile = resolve(directory, 'results.json'), args = ['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/scripts/fixtures/toolkit-custom-identity/vitest.config.mts', '--reporter=json', '--outputFile=' + outputFile,
    ...(pattern ? ['--testNamePattern', pattern] : [])]
  let output, exitCode = 0
  try { output = await exec(process.execPath, args, { cwd: root, env: { ...process.env, AGENTMUX_TOOLKIT_IDENTITY_EVIDENCE: directory, AGENTMUX_TOOLKIT_IDENTITY_MUTANT: mutant }, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 }) }
  catch (error) { exitCode = error.code; output = error; if (!Number.isInteger(exitCode)) throw error }
  await writeFile(resolve(directory, 'command.log'), String(output.stdout) + String(output.stderr))
  const report = JSON.parse(await readFile(outputFile)), tests = report.testResults.flatMap(suite => suite.assertionResults).filter(test => ['passed', 'failed'].includes(test.status))
  assert.ok(tests.length > 0, 'Real owning collection is nonempty')
  const failures = tests.filter(test => test.status === 'failed')
  if (mutant === 'baseline') { assert.equal(exitCode, 0); assert.deepEqual(failures, []) }
  else {
    assert.notEqual(exitCode, 0); assert.equal(failures.length, 1); assert.ok(failures[0].fullName.includes(pattern))
    assert.ok(failures[0].failureMessages.some(message => /AssertionError/u.test(message)), 'SpecificAssertionRED, never a setup/compile failure')
  }
  const loaded = (await readFile(resolve(directory, 'loaded-source.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse)
  assert.ok(loaded.length > 0)
  if (mutant !== 'baseline') assert.ok(loaded.some(item => item.applied && item.originalSHA256 !== item.consumedSHA256))
  for (const item of loaded) assert.equal(sha(await bind(item.path)), item.originalSHA256)
  const result = { name, mutant, passed: tests.length - failures.length, failed: failures.length, exitCode, report: relative(root, outputFile) }
  results.push(result); console.log(JSON.stringify(result))
}
async function callers() {
  const require = createRequire(resolve(root, 'apps/desktop/package.json')), ts = require('typescript')
  const configFile = resolve(root, 'apps/desktop/scripts/fixtures/toolkit-custom-ui/tsconfig.owning.json')
  const config = ts.readConfigFile(configFile, ts.sys.readFile); assert.equal(config.error, undefined)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configFile)); assert.deepEqual(parsed.errors, [])
  const program = ts.createProgram(parsed.fileNames, parsed.options), checker = program.getTypeChecker(), edges = []
  const required = ['JSX ToolkitSettingsPane', 'JSX ToolkitToolEditor', 'JSX UserToolkitResult', 'createAccountUsageTool', 'useToolkitDrafts', 'ToolkitDesktopApi.add', 'ToolkitDesktopApi.update', 'ToolkitDesktopApi.run', 'openToolkit']
  function symbol(node) { let value = checker.getSymbolAtLocation(node); if (value?.flags & ts.SymbolFlags.Alias) value = checker.getAliasedSymbol(value); return value }
  for (const tree of program.getSourceFiles()) {
    const caller = relative(root, tree.fileName)
    if (!caller.startsWith('apps/desktop/src/renderer/src/') || !/\.[jt]sx?$/u.test(caller)) continue
    const visit = node => {
      const nameNode = ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node) ? node.tagName
        : ts.isCallExpression(node) ? ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression : null
      if (nameNode) {
        const value = symbol(nameNode)
        for (const declaration of value?.getDeclarations() ?? []) {
          const definition = relative(root, declaration.getSourceFile().fileName), parent = declaration.parent
          const name = ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node) ? 'JSX ' + value.name
            : ts.isInterfaceDeclaration(parent) ? parent.name.text + '.' + value.name : value.name
          if (required.includes(name) && caller !== definition && definition.startsWith('apps/desktop/src/')) edges.push({ caller, definition, name, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 })
        }
      }
      ts.forEachChild(node, visit)
    }; visit(tree)
  }
  assert.ok(edges.length > 0, 'Production external caller scan collected real calls')
  for (const name of required) assert.ok(edges.some(edge => edge.name === name), 'Definition/import/test/fixture-excluded caller: ' + name)
  assert.ok(edges.some(edge => edge.name === 'ToolkitDesktopApi.run' && edge.caller.endsWith('/toolkit/UserToolkitResult.tsx')), 'The real result consumer calls the existing Run API')
  for (const edge of edges) { await bind(edge.caller); await bind(edge.definition) }
  await writeFile(resolve(evidence, 'callers.json'), JSON.stringify(edges, null, 2) + '\n'); results.push({ edges })
}
async function visual() {
  const packet = JSON.parse(await bind(".bagakit/design/toolkit-custom-identity-fixture/qualification/current.json"))
  assert.equal(packet.schema, 'agentmux.toolkit-custom-identity-qualification.v1')
  async function read(ref) { assert.ok(ref?.path && /^[a-f0-9]{64}$/u.test(ref.sha256)); const bytes = await bind(ref.path); assert.equal(sha(bytes), ref.sha256); return JSON.parse(bytes) }
  const capture = await read(packet.capture), peer = await read(packet.visual)
  assert.equal(capture.completed, true); assert.deepEqual(capture.drift, []); assert.deepEqual(capture.remainingPrivateProcesses, []); assert.equal(capture.privateRootRemoved, true)
  assert.deepEqual(capture.phases.map(phase => phase.stage), ['control', 'restart'])
  for (const phase of capture.phases) { assert.equal(phase.exitCode, 0); assert.equal(phase.timedOut, false); assert.equal(phase.interruption, null) }
  const directory = dirname(resolve(root, packet.capture.path))
  const control = JSON.parse(await bind(relative(root, resolve(directory, 'control-scene.json')))), restart = JSON.parse(await bind(relative(root, resolve(directory, 'restart-scene.json'))))
  assert.equal(control.completed, true); assert.equal(restart.completed, true); assert.notEqual(control.pid, restart.pid)
  assert.equal(control.actualConfigStoreReadback, true); assert.equal(restart.restart.actualConfigStoreReadback, true)
  assert.deepEqual(control.definition, restart.restart.definition); assert.deepEqual(restart.restart.executionCalls, [])
  assert.equal(capture.frames.length, 6); assert.deepEqual(control.frames, capture.frames)
  assert.equal(peer.sourceIdentity, capture.sourceIdentity); assert.equal(peer.verdict.toLowerCase(), 'pass'); assert.deepEqual(peer.mustFix, [])
  assert.equal(peer.images.length, 6); assert.equal(new Set(peer.images.map(image => image.file)).size, 6)
  for (const frame of capture.frames) {
    const image = peer.images.find(image => image.file === frame.file); assert.ok(image?.personallyViewedOriginal); assert.equal(image.sha256, frame.sha256)
    assert.equal(sha(await bind(relative(root, resolve(directory, frame.file)))), frame.sha256)
  }
  assert.ok(Object.keys(capture.inputs).length > 0); assert.ok(capture.compiled.length > 0)
  for (const [file, identity] of Object.entries(capture.inputs)) assert.equal(sha(await bind(file)), identity.sha256, 'Current actual Source/CSS equals this visual candidate')
  for (const artifact of capture.compiled) assert.equal(sha(await bind(relative(root, resolve(directory, artifact.file)))), artifact.sha256)
  results.push({ sealed: true, capture: packet.capture, visual: packet.visual })
}
try {
  for (const file of proofFiles) await bind(file)
  if (mode === '--owning') {
    await owning('baseline')
    for (const [mutant, pattern] of [['default', 'chooses Custom first'], ['pattern', 'a starting point can become an unrelated'], ['retarget', 'preserves dirty fields']]) {
      await owning(mutant, mutant, pattern); await owning(mutant + '-restored', 'baseline', pattern)
    }
  } else if (mode === '--callers') await callers()
  else if (mode === '--capture') {
    const directory = resolve(evidence, 'capture'); await mkdir(directory)
    const capture = await captureIdentity({ root, evidence: directory, bind, proofFiles }); results.push({ capture: relative(root, resolve(directory, 'capture.json')), sourceIdentity: capture.sourceIdentity })
  } else await visual()
  for (const [file, identity] of Object.entries(inputs)) assert.equal(sha(await readFile(resolve(root, file))), identity.sha256, 'Final candidate stays fixed: ' + file)
  await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify({ schema: 'agentmux.toolkit-custom-identity-proof.v1', completed: true, mode, inputs, results }, null, 2) + '\n')
  console.log(relative(root, evidence))
} catch (error) {
  await writeFile(resolve(evidence, 'failure.json'), JSON.stringify({ schema: 'agentmux.toolkit-custom-identity-proof.v1', completed: false, mode, inputs, results, error: String(error?.stack ?? error) }, null, 2) + '\n'); throw error
}
