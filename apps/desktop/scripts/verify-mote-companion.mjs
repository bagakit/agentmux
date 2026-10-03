import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, realpathSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const task = process.argv[process.argv.indexOf('--task') + 1]
if (task !== 'outputs') {
  const commands = { cooperation: 'verify-mote-cooperation.mjs', memory: 'verify-mote-materials.mjs', ideas: 'verify-mote-ideas.mjs', integration: 'verify-mote-companion-integration.mjs' }
  assert.ok(commands[task], 'Select one implemented Task gate')
  const result = spawnSync(process.execPath, [path.join(root, 'apps/desktop/scripts', commands[task])], { cwd: root, stdio: 'inherit' })
  process.exit(result.status ?? 1)
}
const sourceFiles = ['packages/client-ui/src/lib/conversation-files.ts', 'packages/client-ui/src/components/ConversationFiles.tsx',
  'packages/client-ui/src/components/ConversationMessage.tsx', 'packages/client-ui/src/styles/conversation-message.css',
  'packages/client-ui/test/conversation-files.test.tsx', 'apps/desktop/scripts/fixtures/mote-companion/vitest.outputs.config.mts',
  'packages/client-ui/src/components/ConversationNativeThread.tsx', 'apps/desktop/src/renderer/src/components/SessionHistoryView.tsx']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const source = Object.fromEntries(sourceFiles.map(file => [file, hash(readFileSync(path.join(root, file)))]))
const directory = path.join(root, (".tmp/mote-companion/outputs-" + (globalThis.crypto.randomUUID()) + ""))
mkdirSync(directory, { recursive: true })
const receipt = { schema: 'agentmux.mote-companion.outputs.v1', passed: false, source, mutations: [], callers: {},
  boundary: 'Actual Source helper and mounted shared React consumer. No file IO, user App/Run, package or Native qualification. Actual private Renderer visual review is separate.' }
function run(cwd, label) {
  const result = spawnSync(process.execPath, [path.join(cwd, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'apps/desktop/scripts/fixtures/mote-companion/vitest.outputs.config.mts'],
    { cwd, encoding: 'utf8', timeout: 30000 })
  const log = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  writeFileSync(path.join(directory, `${label}.log`), log)
  assert.equal(result.error, undefined, `${label}: process completed`)
  assert.match(log, /Tests\s+.*12/u, `${label}: nonempty actual owning tests ran`)
  return { exitCode: result.status, assertions: log.includes('AssertionError') }
}
try {
  assert.equal(run(root, 'source').exitCode, 0)
  const checks = [
    ['conversationFiles', 'packages/client-ui/src/components/ConversationMessage.tsx'],
    ['ConversationFiles', 'packages/client-ui/src/components/ConversationMessage.tsx'],
    ['ConversationMessage', 'apps/desktop/src/renderer/src/components/ActivityView.tsx'],
    ['ConversationMessage', 'packages/client-ui/src/components/ConversationNativeThread.tsx']
  ]
  for (const [symbol, file] of checks) {
    const text = readFileSync(path.join(root, file), 'utf8')
    assert.match(text, new RegExp(`\\b${symbol}\\b`), `Definition-external production caller ${file}`)
    receipt.callers[file] = hash(text)
  }
  const cases = [
    { name: 'outside-destination', file: sourceFiles[0], before: 'if (!reference) return', after: "if (!reference) reference = {path: '../secret.txt', index: 0, length: 1}" },
    { name: 'quoted-example', file: sourceFiles[0], before: "else if (node.kind === 'list')", after: "else if (node.kind === 'quote') blocks(node.children)\n      else if (node.kind === 'list')" },
    { name: 'human-result-claim', file: sourceFiles[2], before: "speaker?.role === 'agent' && !isPeerAgent && !compact", after: "(speaker?.role === 'agent' || speaker?.role === 'human') && !isPeerAgent && !compact" },
    { name: 'lost-original-position', file: sourceFiles[1], before: 'openFile(reference.path, referenceRevealLocation(reference))', after: 'openFile(reference.path, undefined)' }
  ]
  for (const mutation of cases) {
    const isolated = path.join(directory, mutation.name)
    mkdirSync(isolated, { recursive: true })
    symlinkSync(realpathSync(path.join(root, 'node_modules')), path.join(isolated, 'node_modules'), 'dir')
    for (const folder of ['packages/client-ui/src', 'packages/client-ui/test']) cpSync(path.join(root, folder), path.join(isolated, folder), { recursive: true })
    symlinkSync(realpathSync(path.join(root, 'packages/client-ui/node_modules')), path.join(isolated, 'packages/client-ui/node_modules'), 'dir')
    for (const file of ['packages/core/src/agent-message-render.ts', 'packages/core/src/session-user-messages.ts', sourceFiles[5]]) {
      mkdirSync(path.dirname(path.join(isolated, file)), { recursive: true }); cpSync(path.join(root, file), path.join(isolated, file))
    }
    symlinkSync(realpathSync(path.join(root, 'packages/core/node_modules')), path.join(isolated, 'packages/core/node_modules'), 'dir')
    writeFileSync(path.join(isolated, 'package.json'), '{"type":"module"}')
    const original = readFileSync(path.join(isolated, mutation.file), 'utf8')
    assert.equal(original.split(mutation.before).length, 2, 'One exact real production mutation seam')
    writeFileSync(path.join(isolated, mutation.file), original.replace(mutation.before, mutation.after))
    const changed = run(isolated, mutation.name)
    assert.notEqual(changed.exitCode, 0, `${mutation.name}: actual implementation mutation must fail`)
    assert.equal(changed.assertions, true, `${mutation.name}: meaningful assertion failure, not compile/import failure`)
    receipt.mutations.push({ ...mutation, ...changed, restoredSource: source[mutation.file] })
    rmSync(isolated, { recursive: true })
  }
  assert.equal(run(root, 'restored').exitCode, 0)
  const types = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', 'packages/client-ui/tsconfig.json', '--noEmit'], { cwd: root, encoding: 'utf8', timeout: 30000 })
  writeFileSync(path.join(directory, 'types.log'), `${types.stdout ?? ''}\n${types.stderr ?? ''}`)
  assert.equal(types.status, 0, 'Shared consumer types')
  assert.deepEqual(Object.fromEntries(sourceFiles.map(file => [file, hash(readFileSync(path.join(root, file)))])), source)
  receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack } }
writeFileSync(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(path.relative(root, path.join(directory, 'receipt.json')))
if (!receipt.passed) { console.error(receipt.error); process.exitCode = 1 }
