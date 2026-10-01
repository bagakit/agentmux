import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import ts from 'typescript'
import { sourceAliases } from './fixtures/local-link-preview-maintenance/vitest.owning.config.mts'

const root = resolve(import.meta.dirname, '../../..')
let consume = false, lane, output, phase = 'all'
for (let index = 2; index < process.argv.length; index++) {
  const [flag, inline] = process.argv[index].split('=')
  if (flag === '--receipt') { assert.equal(inline, undefined); consume = true; continue }
  assert(['--lane', '--output', '--phase'].includes(flag), `Unknown argument: ${flag}`)
  const value = inline ?? process.argv[++index]; assert(value && !value.startsWith('--'))
  if (flag === '--lane') lane = value
  else if (flag === '--output') output = value
  else phase = value
}
assert(['markdown', 'attachment'].includes(lane), 'Select an explicit owning lane')
assert(['all', 'source', 'native'].includes(phase))
output ??= `.tmp/local-link-preview-maintenance/${lane}`
const evidence = resolve(root, output), receiptPath = resolve(evidence, 'source-receipt.json')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const bind = path => ({ path, sha256: sha(readFileSync(resolve(root, path))) })
const relative = path => path.replace(`${root}/`, '')
const base = 'apps/desktop/src/', renderer = base + 'renderer/src/'
const shared = 'packages/client-ui/src/'
const markdown = shared + 'lib/markdown-file-reference.ts', terminal = shared + 'lib/terminal-path-link.ts'
const agent = shared + 'components/AgentMarkdown.tsx', image = shared + 'components/ConversationImage.tsx'
const fileView = renderer + 'components/FileSurfaceView.tsx', session = renderer + 'components/SessionPane.tsx'
const store = renderer + 'store.ts', reader = base + 'main/pasted-image-read.ts'
const sourcePaths = lane === 'markdown' ? [markdown, terminal, agent, shared + 'lib/agent-markdown.ts', fileView,
  renderer + 'components/FilePreviewPane.tsx', session, store, renderer + 'lib/session-project-file-context.ts']
  : [image, agent, session, reader, base + 'main/pasted-directory.ts', base + 'main/ipc.ts', base + 'preload/index.ts', base + 'shared/contracts.ts']
const testNames = lane === 'markdown' ? ['markdown-file-reference.test.tsx', 'markdown-local-link-preview.test.tsx', 'file-preview-open.test.tsx',
  'terminal-path-link.test.ts', 'agent-markdown.test.ts', 'agent-markdown-image.test.ts']
  : ['conversation-image-decode-failure.test.tsx', 'conversation-image-thumbnail.test.tsx', 'conversation-image-lightbox.test.tsx', 'pasted-image-read.test.ts']
const testPaths = testNames.map(name => 'apps/desktop/test/' + name)
const config = 'apps/desktop/scripts/fixtures/local-link-preview-maintenance/vitest.owning.config.mts'
const compilerConfig = `apps/desktop/.tmp/local-link-preview-maintenance/${lane}/tsconfig.owning.json`
const compiler = () => ({ extends: '../../../tsconfig.json', compilerOptions: { baseUrl: '../../../../..',
  paths: Object.fromEntries(sourceAliases.map(item => [item.find, [relative(item.replacement)]])) } })
const helpers = [config, 'apps/desktop/scripts/fixtures/bookmark-local-link/vitest.owning.config.mts', 'vitest.setup.ts',
  'packages/client-ui/package.json', 'packages/client-ui/src/platform.tsx',
  'apps/desktop/src/renderer/src/components/DesktopClientUiProvider.tsx', 'apps/desktop/test/helpers/client-ui-render.tsx',
  'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/tsconfig.json', 'tsconfig.base.json', compilerConfig,
  'packages/core/package.json', 'packages/core/vendor/ctxmux/darwin-arm64/manifest.json', 'packages/core/vendor/ctxmux/darwin-arm64/ctxmux-sdk-0.0.0.tgz',
  'packages/core/node_modules/@ctxmux/sdk/package.json',
  ...readdirSync(resolve(root, 'packages/core/node_modules/@ctxmux/sdk/dist'), { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => relative(resolve(entry.parentPath, entry.name))).sort()]
const producer = 'apps/desktop/scripts/verify-local-link-preview-maintenance.mjs'
const schema = 'agentmux.local-link-preview-maintenance-source.v1'
const mutants = lane === 'markdown' ? [
  { id: 'omit-uri-decode', path: markdown, owner: 'classifyMarkdownLinkHref', from: 'decoded = decodeURIComponent(trimmed)', to: 'decoded = trimmed', test: 'clicks real parsed image', file: 'markdown-local-link-preview.test.tsx' },
  { id: 'decode-uri-twice', path: markdown, owner: 'classifyMarkdownLinkHref', from: 'decoded = decodeURIComponent(trimmed)', to: 'decoded = decodeURIComponent(decodeURIComponent(trimmed))', test: 'clicks real parsed image', file: 'markdown-local-link-preview.test.tsx' },
  { id: 'reinterpret-encoded-separator', path: markdown, owner: 'classifyMarkdownLinkHref', from: ' || /%(?:2f|5c)/i.test(trimmed)', to: '', test: 'refuses an ambiguous', file: 'markdown-file-reference.test.tsx' },
  { id: 'drop-decoded-scheme-control-guard', path: markdown, owner: 'classifyMarkdownLinkHref', from: "  if (scheme.test(decoded) || /[\\u0000-\\u001f\\u007f-\\u009f\\\\]/u.test(decoded)) return null", to: '', test: 'refuses an ambiguous', file: 'markdown-file-reference.test.tsx' },
  { id: 'drop-relative-root-fence', path: markdown, owner: 'classifyMarkdownLinkHref', from: 'if (!segments.length) return null; segments.pop()', to: 'segments.pop()', test: 'normalizes decoded dot segments', file: 'markdown-file-reference.test.tsx' },
  { id: 'drop-source-directory', path: markdown, owner: 'classifyMarkdownLinkHref', from: 'candidate = `${directory}/${core}`', to: 'candidate = core', test: 'encoded Markdown image and bookmark clicks', file: 'file-preview-open.test.tsx' },
  { id: 'disconnect-real-markdown-image-entry', path: agent, owner: 'Inline', from: 'const fileHref = context.openWorkspaceFile ? classifyMarkdownLinkHref(node.href, context.workspaceRoot, context.homeDir, context.sourcePath) : null', to: 'const fileHref = null', test: 'clicks real parsed image', file: 'markdown-local-link-preview.test.tsx' }
] : [
  { id: 'drop-thumbnail-decode-error', path: image, owner: 'ConversationImage', from: 'alt={path} onError={decodeFailed} />', to: 'alt={path} />', occurrence: 0, test: 'readable bytes fail thumbnail decode', file: 'conversation-image-decode-failure.test.tsx' },
  { id: 'drop-full-image-decode-error', path: image, owner: 'ConversationImage', from: 'alt={path} onError={decodeFailed} />', to: 'alt={path} />', occurrence: 1, test: 'invalid open lightbox', file: 'conversation-image-decode-failure.test.tsx' },
  { id: 'label-prior-bytes-as-current-source', path: image, owner: 'ConversationImage', from: 'loaded?.path === path && loaded.reader === readPastedImage && failed !== loaded', to: 'loaded && failed !== loaded', test: 'before passive effects', file: 'conversation-image-decode-failure.test.tsx' },
  { id: 'apply-late-prior-image-read', path: image, owner: 'ConversationImage', from: '        if (!alive) return', to: '', test: 'late prior read', file: 'conversation-image-decode-failure.test.tsx' },
  { id: 'apply-retained-prior-decode-error', path: image, owner: 'ConversationImage', from: 'if (currentImage.current === loaded) setFailed(loaded)', to: 'setFailed(loaded)', test: 'isolates retained decode', file: 'conversation-image-decode-failure.test.tsx' },
  { id: 'apply-retained-prior-dialog-change', path: image, owner: 'ConversationImage', from: 'if (currentImage.current === loaded) setOpen(next ? loaded : null)', to: 'setOpen(next ? loaded : null)', test: 'isolates retained decode', file: 'conversation-image-decode-failure.test.tsx' }
]

function inputs(receipt) {
  assert.equal(receipt.schema, schema); assert.equal(receipt.status, 'passed'); assert.equal(receipt.lane, lane)
  assert.deepEqual(receipt.sourceBindings.map(item => item.path), sourcePaths)
  assert.deepEqual(receipt.testBindings.map(item => item.path), [...testPaths, ...helpers])
  for (const item of [...receipt.sourceBindings, ...receipt.testBindings, receipt.verificationBinding]) assert.equal(bind(item.path).sha256, item.sha256, `Qualified input changed: ${item.path}`)
  assert.equal(receipt.verificationBinding.path, producer); assert.equal(receipt.sourceDigest, sha(JSON.stringify(receipt.sourceBindings)))
  assert.deepEqual(JSON.parse(readFileSync(resolve(root, compilerConfig))), compiler())
}
function report(run, green) {
  const bytes = readFileSync(resolve(root, run.report)); assert.equal(sha(bytes), run.reportSha256); assert.equal(bind(run.log).sha256, run.logSha256)
  const actual = JSON.parse(bytes), failures = actual.testResults.flatMap(file => file.assertionResults.filter(test => test.status === 'failed'))
  assert(actual.numTotalTests > 0 && actual.testResults.length > 0, 'Loaded collection is nonempty')
  assert.equal(run.tests, actual.numTotalTests); assert.equal(run.passed, actual.numPassedTests)
  if (green) { assert.equal(run.exitCode, 0); assert.equal(actual.numFailedTests, 0); assert.equal(failures.length, 0); assert(actual.numPassedTests > 0) }
  else { assert.notEqual(run.exitCode, 0); assert(failures.length > 0, 'Tool/collection failure cannot replace Assertion RED'); assert(failures.some(test => test.failureMessages.some(message => /AssertionError|expected .*to /s.test(message)))) }
}
function callers() {
  const owners = lane === 'markdown' ? [['classifyMarkdownLinkHref', markdown], ['resolveWorkspaceRelativePath', terminal], ['openFile', store]]
    : [['ConversationImage', image], ['readPastedImage', reader]]
  return owners.map(([symbol, definition]) => {
    const uses = []
    for (const path of sourcePaths.filter(path => path !== definition)) {
      const parsed = ts.createSourceFile(path, readFileSync(resolve(root, path), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      function visit(node) {
        const expression = ts.isCallExpression(node) ? node.expression : ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node) ? node.tagName : null
        const name = expression && (ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) ? expression.name.text : null)
        if (name === symbol) uses.push({ path, line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1, use: node.getText(parsed).slice(0, 240) })
        ts.forEachChild(node, visit)
      }
      visit(parsed)
    }
    assert(uses.length > 0, `${symbol}: no product caller outside its definition/import/tests`)
    return { symbol, definition, uses }
  })
}
function productionBlock(mutant, original) {
  const parsed = ts.createSourceFile(mutant.path, original, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), matches = []
  function visit(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === mutant.owner) matches.push(node); ts.forEachChild(node, visit) }
  visit(parsed); assert.equal(matches.length, 1, `Unique actual owner: ${mutant.owner}`)
  return { text: matches[0].getText(parsed), start: matches[0].getStart(parsed) }
}
function runTests(label, paths = testPaths, name) {
  const log = resolve(evidence, `${label}.log`), destination = resolve(evidence, `${label}.vitest.json`)
  const args = ['run', '--config', config, ...paths, '--reporter=json', `--outputFile=${destination}`]
  if (name) args.push('-t', name)
  const result = spawnSync(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), ...args], { cwd: root, encoding: 'utf8', timeout: 150000 })
  writeFileSync(log, `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\n${result.error}` : ''}`)
  assert(!result.error, `${label}: actual test process must complete`)
  const bytes = readFileSync(destination), actual = JSON.parse(bytes)
  return { label, command: [process.execPath, 'node_modules/vitest/vitest.mjs', ...args].join(' '), exitCode: result.status,
    tests: actual.numTotalTests, passed: actual.numPassedTests, report: relative(destination), reportSha256: sha(bytes), log: relative(log), logSha256: sha(readFileSync(log)) }
}
function consumeSource() {
  const receipt = JSON.parse(readFileSync(receiptPath)); inputs(receipt); report(receipt.baseline, true); report(receipt.restored, true)
  assert.deepEqual(receipt.mutations.map(item => item.id), mutants.map(item => item.id))
  for (const item of receipt.mutations) {
    assert.equal(item.status, 'assertion-red-exact-restore-green'); assert.equal(item.originalSha256, receipt.sourceBindings.find(binding => binding.path === item.path).sha256)
    assert.notEqual(item.originalSha256, item.mutatedSha256); report(item.red, false); report(item.restored, true)
  }
  assert.deepEqual(receipt.callers, callers()); assert.equal(receipt.typecheck.exitCode, 0); assert.equal(bind(receipt.typecheck.log).sha256, receipt.typecheck.logSha256)
  assert.equal(receipt.typecheck.command, `node_modules/.bin/tsc --noEmit -p ${compilerConfig}`)
  return receipt
}
function qualifySource() {
  mkdirSync(evidence, { recursive: true }); mkdirSync(resolve(root, compilerConfig, '..'), { recursive: true })
  writeFileSync(resolve(root, compilerConfig), `${JSON.stringify(compiler(), null, 2)}\n`)
  const sourceBindings = sourcePaths.map(bind), testBindings = [...testPaths, ...helpers].map(bind), verificationBinding = bind(producer)
  const baseline = runTests('source-baseline'); report(baseline, true)
  const mutations = []
  for (const mutant of mutants) {
    const path = resolve(root, mutant.path), original = readFileSync(path)
    assert.equal(sha(original), sourceBindings.find(item => item.path === mutant.path).sha256, 'Candidate changed; preserve concurrent work')
    const block = productionBlock(mutant, original.toString()), positions = [...block.text.matchAll(new RegExp(mutant.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))].map(match => match.index)
    assert(block.start >= 0 && block.text.length > 0); assert.equal(positions.length, mutant.occurrence === undefined ? 1 : 2, 'Nonempty precise production anchor: ' + mutant.id)
    const at = block.start + positions[mutant.occurrence ?? 0], mutated = original.toString().slice(0, at) + mutant.to + original.toString().slice(at + mutant.from.length)
    let red; writeFileSync(path, mutated)
    try { red = runTests('mutation-' + mutant.id, ['apps/desktop/test/' + mutant.file], mutant.test); report(red, false) }
    finally { assert.equal(sha(readFileSync(path)), sha(mutated), 'Concurrent edit detected; never overwrite it'); writeFileSync(path, original); assert.equal(sha(readFileSync(path)), sha(original)) }
    const restored = runTests('restore-' + mutant.id, ['apps/desktop/test/' + mutant.file], mutant.test); report(restored, true)
    mutations.push({ id: mutant.id, path: mutant.path, status: 'assertion-red-exact-restore-green', originalSha256: sha(original), mutatedSha256: sha(mutated), productionBlock: { text: block.text, sha256: sha(block.text) }, red, restored })
    process.stdout.write(`${lane}/${mutant.id}: Assertion RED / exact restore GREEN\n`)
  }
  const restored = runTests('source-final-restored'); report(restored, true)
  const productCallers = callers(), typecheck = spawnSync(resolve(root, 'node_modules/.bin/tsc'), ['--noEmit', '-p', compilerConfig], { cwd: root, encoding: 'utf8', timeout: 150000 })
  const typecheckLog = relative(resolve(evidence, 'source-typecheck.log')); writeFileSync(resolve(root, typecheckLog), `${typecheck.stdout ?? ''}${typecheck.stderr ?? ''}${typecheck.error ?? ''}`)
  assert(!typecheck.error && typecheck.status === 0, 'Current product typecheck must pass')
  const receipt = { schema, status: 'passed', lane, feature: 'f-2j88fzs9q', task: lane === 'markdown' ? 'T-001' : 'T-002', recordedAt: new Date().toISOString(), sourceBindings, testBindings, verificationBinding,
    sourceDigest: sha(JSON.stringify(sourceBindings)), baseline, mutations, restored, callers: productCallers,
    typecheck: { command: `node_modules/.bin/tsc --noEmit -p ${compilerConfig}`, exitCode: typecheck.status, log: typecheckLog, logSha256: bind(typecheckLog).sha256 },
    boundary: 'Owning production modules are loaded through source aliases. Mounted React clicks and controlled image error events prove the Renderer contracts. Actual Chromium decode/pixels, bounded production file readers and restart are separately bound by the finite Native receipt. No installed App, OS screenshot, GPU or healthy native Run claim.', packaging: 'not-requested-not-run', installation: 'not-requested-not-run' }
  inputs(receipt); writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`); return receipt
}
let source
if (phase !== 'native') source = consume ? consumeSource() : qualifySource()
if (phase !== 'source') {
  const { runNative, consumeNative } = await import('./fixtures/local-link-preview-maintenance/native-proof.mjs')
  await (consume ? consumeNative : runNative)({ root, evidence, lane })
}
console.log(JSON.stringify({ status: 'passed', lane, phase, mode: consume ? 'read-only-current-proof' : 'qualified', receipt: relative(phase === 'native' ? resolve(evidence, 'capture-receipt.json') : receiptPath), sourceDigest: source?.sourceDigest }))
