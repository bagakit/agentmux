import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../../../../..')
const evidence = resolve(root, '.local/state/mobile-attachments/source-' + randomUUID())
mkdirSync(evidence, { recursive: true })
const configuration = 'apps/mobile/scripts/fixtures/mobile-attachments/vitest.config.mts'
const owning = ['apps/mobile/test/mobile-attachments.test.tsx', 'apps/mobile/test/file-upload-public.test.ts', 'apps/mobile/test/native-device.test.ts',
  'apps/desktop/test/composer-file-reference.test.ts', 'apps/desktop/test/composer-semantic-reference.test.tsx', 'apps/desktop/test/inline-composer.test.tsx']
const sha = text => createHash('sha256').update(text).digest('hex')
function run(name, args = [], mutant = null) {
  const proof = join(evidence, name + '.loaded.ndjson'), report = join(evidence, name + '.json')
  const env = { ...process.env, AGENTMUX_MOBILE_ATTACHMENTS_PROOF: proof, AGENTMUX_MOBILE_ATTACHMENTS_EVIDENCE: evidence }
  delete env.AGENTMUX_MOBILE_ATTACHMENTS_BASELINE; delete env.AGENTMUX_MOBILE_ATTACHMENTS_MUTANT
  if (mutant) env.AGENTMUX_MOBILE_ATTACHMENTS_MUTANT = JSON.stringify(mutant)
  const result = spawnSync(join(root, 'node_modules/.bin/vitest'), ['run', '--config', configuration, ...(args.length ? args : owning), '--reporter=json', '--outputFile=' + report],
    { cwd: root, env, encoding: 'utf8', timeout: 90000, maxBuffer: 16 * 1024 * 1024 })
  writeFileSync(join(evidence, name + '.log'), (result.stdout ?? '') + (result.stderr ?? ''))
  const tests = JSON.parse(readFileSync(report, 'utf8'))
  assert.ok(tests.numTotalTests > 0 && tests.testResults.length > 0, 'An empty collection is never green')
  const loaded = readFileSync(proof, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  if (mutant) {
    assert.notEqual(result.status, 0, 'The loaded semantic mutation must turn an owning assertion red')
    assert.ok(tests.testResults.flatMap(file => file.assertionResults).some(test => test.status === 'failed' && test.failureMessages.some(message => /AssertionError|expected .* to|promise resolved/u.test(message))), 'An environment/startup error is not a semantic mutation result')
    assert.ok(loaded.some(record => record.consumer === 'actual-loaded-mutant' && record.file === mutant.file && record.beforeSha256 !== record.afterSha256), 'The real production module must contain the loaded mutation')
  } else assert.equal(result.status, 0, 'Original Source owning tests must pass')
  return { name, exitCode: result.status, tests: tests.numTotalTests, failed: tests.numFailedTests, loadedProductionFiles: [...new Set(loaded.map(item => item.file))],
    ...(mutant ? { mutant: { file: mutant.file, before: mutant.before, after: mutant.after } } : {}) }
}
const mutations = [
  { name: 'owner-readback-content', file: 'apps/desktop/src/main/file-upload-owner.ts', before: 'if (bytes.byteLength !== identity.byteLength || digest(bytes) !== identity.revision)', after: 'if (false)',
    tests: ['apps/mobile/test/file-upload-public.test.ts', '-t', 'rejects content mismatch'] },
  { name: 'public-original-run', file: 'packages/core/src/public-rpc-service.ts', before: 'original.session.run.runId !== input.expectedRun.runId', after: 'false',
    tests: ['apps/mobile/test/file-upload-public.test.ts', '-t', 'checks the authoritative original'] },
  { name: 'mobile-original-run', file: 'apps/mobile/src/conversation/attachments.ts', before: 'upload.identity.expectedRun.runId === scope.runId', after: 'true',
    tests: ['apps/mobile/test/mobile-attachments.test.tsx', '-t', 'same exact target/content guard'] },
  { name: 'unknown-inspect-only', file: 'apps/mobile/src/conversation/MobileAttachments.tsx', before: "await originalClient.forwardRpc!('file.upload.inspect', upload.identity)", after: "await originalClient.forwardRpc!('file.upload', upload.identity as never)",
    tests: ['apps/mobile/test/mobile-attachments.test.tsx', '-t', 'reconciles a lost upload receipt'] },
  { name: 'later-message-retained', file: 'apps/mobile/src/conversation/MobileAttachments.tsx', before: 'originalPrompt !== current.current.promptOperationId', after: 'false',
    tests: ['apps/mobile/test/mobile-attachments.test.tsx', '-t', 'refuses a changed Runtime or Run'] }
]
const receipt = { passed: false, source: {}, tests: [], productionCallers: [], boundary: 'Loaded actual Source only; no model, user Runtime, physical device, package or install claim.' }
try {
  receipt.tests.push(run('original'))
  for (const { name, tests, ...mutant } of mutations) receipt.tests.push(run(name, tests, mutant))
  receipt.tests.push(run('restored'))
  const callers = [
    ['apps/desktop/src/main/ipc.ts', 'fileUploads: new FileUploadOwner'],
    ['packages/core/src/public-rpc-service.ts', 'this.ports.fileUploads.upload'],
    ['packages/core/src/agentmux-cli-commands.ts', "command('file.upload'"],
    ['packages/core/src/rpc-native-codec.ts', 'parseFileUploadResult'],
    ['apps/mobile/src/MobileApp.tsx', '<MobileConversationSurface'],
    ['apps/mobile/src/conversation/MobileConversationSurface.tsx', '<MobileAttachments'],
    ['apps/mobile/src/conversation/MobileAttachments.tsx', "forwardRpc!('file.upload'"],
    ['apps/mobile/src/platform/native/device.ts', 'file.blob.stream()'],
    ['apps/mobile/src/conversation/MobileConversationSurface.tsx', 'appendNamedFileReference'],
    ['apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx', '@agentmux/client-ui/composer-file-reference'],
    ['apps/desktop/src/renderer/src/components/NewTabSurface.tsx', '@agentmux/client-ui/composer-file-reference']
  ]
  assert.ok(callers.length > 0)
  for (const [file, anchor] of callers) {
    const source = readFileSync(join(root, file), 'utf8'); assert.ok(source.includes(anchor), 'Nonempty production caller: ' + file)
    receipt.productionCallers.push({ file, anchor }); receipt.source[file] = sha(source)
  }
  for (const file of ['apps/desktop/src/main/file-upload-owner.ts', 'packages/core/src/public-rpc-files.ts', 'packages/client-ui/src/lib/composer-file-reference.ts',
    'packages/client-ui/src/lib/composer-semantic-reference.ts', 'packages/client-ui/src/components/InlineComposer.tsx', 'apps/mobile/src/conversation/attachments.ts', 'apps/mobile/src/recovery/device-workface.ts']) receipt.source[file] = sha(readFileSync(join(root, file)))
  receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack } }
writeFileSync(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(relative(root, join(evidence, 'receipt.json')))
if (!receipt.passed) { console.error(receipt.error); process.exitCode = 1 }
