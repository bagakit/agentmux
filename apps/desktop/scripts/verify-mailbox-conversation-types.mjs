import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '../../..'), exec = promisify(execFile)
const baseline = 'dd5a6fccf54db4fdfc038866e4c05132ad92696a'
const configPath = join(root, 'apps/desktop/scripts/fixtures/mailbox-reading-flow/tsconfig.production.json')
const appConfig = join(root, 'apps/desktop/tsconfig.json')
const sourcePaths = ['apps/desktop/src/renderer/src/components/SessionMailbox.tsx',
  'apps/desktop/src/renderer/src/components/ComposerOutbox.tsx', 'apps/desktop/src/renderer/src/components/MailboxReading.tsx',
  'packages/client-ui/src/components/ConversationMessage.tsx', 'packages/client-ui/src/components/ConversationInputDetails.tsx',
  'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx', 'apps/desktop/src/renderer/src/components/SessionPane.tsx']
const stylePaths = ['packages/client-ui/src/styles/composer.css', 'packages/client-ui/src/styles/conversation-message.css', 'packages/client-ui/src/styles/markdown.css']
const ownedPaths = [...sourcePaths, ...stylePaths]
const hash = value => createHash('sha256').update(value).digest('hex')
const evidence = join(root, '.tmp/mailbox-reading-flow', 'types-' + globalThis.crypto.randomUUID())
const result = { schema: 'agentmux.mailbox-source-types.v1', passed: false, baseline, scope: 'Full Desktop Program regression comparison. All owned TSX diagnostics must be absent; all other diagnostics must match the fixed product baseline exactly. Existing Main/Core diagnostics are reported, never whole-app or Runtime qualification.', mutation: null }
await mkdir(evidence, { recursive: true })
const previous = Object.fromEntries(await Promise.all(ownedPaths.map(async file => [file, (await exec('git', ['show', baseline + ':' + file], { cwd: root, maxBuffer: 2 * 1024 * 1024 })).stdout])))
const current = Object.fromEntries(await Promise.all(ownedPaths.map(async file => [file, await readFile(join(root, file), 'utf8')])))
function parse(file) {
  const parsed = ts.getParsedCommandLineOfConfigFile(file, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => assert.fail(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\\n')) })
  assert.ok(parsed)
  assert.deepEqual(parsed.errors, [])
  return parsed
}
const config = parse(configPath), originalConfig = parse(appConfig)
assert.deepEqual([...config.fileNames].sort(), [...originalConfig.fileNames].sort(), 'The original full app include set is unchanged')
assert.ok(config.fileNames.length > 0)
function inspect(overrides = {}) {
  const host = ts.createCompilerHost(config.options), getSourceFile = host.getSourceFile.bind(host), read = host.readFile.bind(host)
  const replaced = new Set()
  host.readFile = file => overrides[relative(root, file)] ?? read(file)
  host.getSourceFile = (file, languageVersion, onError, fresh) => {
    const key = relative(root, file)
    if (!(key in overrides)) return getSourceFile(file, languageVersion, onError, fresh)
    replaced.add(key)
    return ts.createSourceFile(file, overrides[key], languageVersion, true)
  }
  const program = ts.createProgram(config.fileNames, config.options, host)
  const diagnostics = ts.getPreEmitDiagnostics(program).map(item => ({
    file: item.file ? relative(root, item.file.fileName) : null, code: item.code, category: item.category,
    start: item.start ?? null, length: item.length ?? null, message: ts.flattenDiagnosticMessageText(item.messageText, '\n')
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  const inputs = Object.fromEntries(program.getSourceFiles().map(file => [relative(root, file.fileName), hash(file.text)]))
  const appInputs = Object.keys(inputs).filter(file => file.startsWith('apps/desktop/'))
  assert.ok(appInputs.length > 0, 'Actual app Source reads are nonempty')
  for (const file of sourcePaths) assert.ok(inputs[file], 'Actual owned TSX consumed: ' + file)
  for (const file of sourcePaths.filter(file => file in overrides)) assert.ok(replaced.has(file), 'Virtual baseline or mutant actually consumed: ' + file)
  return { diagnostics, ownedDiagnostics: diagnostics.filter(item => sourcePaths.includes(item.file)), otherDiagnostics: diagnostics.filter(item => !sourcePaths.includes(item.file)), appDiagnostics: diagnostics.filter(item => item.file?.startsWith('apps/desktop/')), inputs, appInputs }
}
function qualify(candidate, reference) {
  assert.deepEqual(candidate.ownedDiagnostics, [], 'Every owned production TSX diagnostic must be absent')
  assert.deepEqual(candidate.otherDiagnostics, reference.otherDiagnostics, 'All other diagnostics must match the fixed product baseline exactly')
}
try {
  result.config = { path: relative(root, configPath), sha256: hash(await readFile(configPath)), originalPath: relative(root, appConfig), originalSha256: hash(await readFile(appConfig)), fileNames: config.fileNames.map(file => relative(root, file)), options: config.options, typescriptVersion: ts.version }
  result.sourceIdentities = Object.fromEntries(ownedPaths.map(file => [file, { baseline: hash(previous[file]), candidate: hash(current[file]), typed: sourcePaths.includes(file) }]))
  result.baselineProgram = inspect(previous)
  assert.deepEqual(result.baselineProgram.ownedDiagnostics, [], 'The fixed product baseline itself has no owned TSX diagnostics')
  result.candidateProgram = inspect()
  qualify(result.candidateProgram, result.baselineProgram)
  const file = sourcePaths[3], from = 'compact = false', to = "compact = 'invalid-type'"
  assert.equal(current[file].split(from).length, 2, 'The real production TS mutation block is unique and nonempty')
  const changed = current[file].replace(from, to)
  await writeFile(join(evidence, 'mutated-conversation-message.tsx'), changed)
  const mutant = inspect({ [file]: changed })
  assert.equal(mutant.inputs[file], hash(changed), 'The compiler consumes the mutated production Source')
  let rejection
  try { qualify(mutant, result.baselineProgram) } catch (error) { rejection = { name: error.name, message: error.message }; assert.equal(error.name, 'AssertionError') }
  assert.ok(rejection, 'A real product TS type error must reject the candidate')
  assert.ok(mutant.ownedDiagnostics.some(item => item.file === file), 'The rejection contains an actual product type diagnostic')
  result.restoredProgram = inspect()
  qualify(result.restoredProgram, result.baselineProgram)
  result.mutation = { file, from, to, originalSha256: hash(current[file]), mutatedSha256: hash(changed), red: { rejection, diagnostics: mutant.diagnostics }, restored: { passed: true, sha256: result.restoredProgram.inputs[file] }, sharedSourceWritten: false }
  for (const file of ownedPaths) assert.equal(hash(await readFile(join(root, file))), hash(current[file]), 'Owned product Source remains unchanged')
  result.passed = true
} catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack } }
await writeFile(join(evidence, 'receipt.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify({ passed: result.passed, evidence: relative(root, evidence), baseline, ownedDiagnostics: result.candidateProgram?.ownedDiagnostics, allRemainingDiagnostics: result.candidateProgram?.otherDiagnostics, qualification: 'This product introduces no type regression. All other diagnostics match the fixed baseline exactly and are reported above; this comparison does not qualify whole-app or Core/Runtime.', mutation: result.mutation?.red.rejection ?? null, failure: result.failure ?? null }, null, 2))
process.exitCode = result.passed ? 0 : 1
