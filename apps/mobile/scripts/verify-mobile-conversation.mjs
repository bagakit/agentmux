#!/usr/bin/env node
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const mobile = join(root, 'apps/mobile')
const flags = new Set(process.argv.slice(2))
const correction = flags.has('--delivery-correction')
const output = join(root, '.tmp/agentmux-private-mobile-client/mobile-conversation', ...(correction ? ['delivery-correction'] : []))
const ts = createRequire(import.meta.url)(join(root, 'node_modules/typescript/lib/typescript.js'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function files(directory) {
  const result = []
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name)
    if (item.isDirectory()) result.push(...await files(path))
    else if (item.isFile()) result.push(path)
  }
  return result.sort()
}
async function bindings() {
  const paths = [
    ...await files(join(mobile, 'src/conversation')), join(mobile, 'src/platform/browser.tsx'),
    ...['conversation-fixture.tsx', 'conversation-surface.test.tsx', 'conversation-browser.test.tsx'].map(path => join(mobile, 'test', path)),
    ...await files(join(root, 'packages/client-ui/src')),
    ...['package.json', 'vitest.config.ts', 'vite.config.ts', 'tsconfig.json'].map(path => join(mobile, path)),
    fileURLToPath(import.meta.url), join(root, 'packages/client-ui/package.json'), join(root, 'packages/core/package.json'),
    ...['hosted', 'hosted-client', 'hosted-client-contract', 'hosted-value', 'client-event-publisher', 'errors',
      'agent-prompt-condition', 'session-user-messages', 'agent-message-render'].flatMap(name => [
        join(root, `packages/core/src/${name}.ts`), join(root, `packages/core/dist/${name}.js`)
      ]),
    ...(correction ? ['prompt-submission', 'client', 'agent-session-store'].map(name => join(root, `packages/core/src/${name}.ts`)) : [])
  ]
  return Object.fromEntries(await Promise.all(paths.map(async path => [relative(root, path), hash(await readFile(path))])))
}
function parse(path, bytes) { return ts.createSourceFile(path, bytes, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX) }
function count(source, predicate) {
  let hits = 0
  function visit(node) { if (predicate(node)) hits++; ts.forEachChild(node, visit) }
  visit(source); return hits
}
const jsx = name => node => (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText() === name
async function callers(base) {
  const app = parse('MobileApp.tsx', await readFile(join(base, 'apps/mobile/src/MobileApp.tsx'), 'utf8'))
  const main = parse('main.tsx', await readFile(join(base, 'apps/mobile/src/main.tsx'), 'utf8'))
  const surface = parse('MobileConversationSurface.tsx', await readFile(join(base, 'apps/mobile/src/conversation/MobileConversationSurface.tsx'), 'utf8'))
  const hook = parse('use-hosted-conversation.ts', await readFile(join(base, 'apps/mobile/src/conversation/use-hosted-conversation.ts'), 'utf8'))
  const result = { MobileConversationSurface: count(app, jsx('MobileConversationSurface')),
    createBrowserPlatform: count(main, node => ts.isCallExpression(node) && node.expression.getText() === 'createBrowserPlatform'),
    deliveryOutcome: count(surface, node => ts.isCallExpression(node) && node.expression.getText() === 'deliveryOutcome') }
  for (const name of ['ClientUiProvider', 'ConversationNativeThread', 'ConversationMessage', 'AgentInteractionCard', 'AgentComposer']) {
    result[name] = count(surface, jsx(name))
  }
  for (const [name, source] of [['submitAgentPrompt', surface], ['respondAgentInteraction', surface], ['sessionTimeline', hook], ['sessionHistoryPage', hook], ['observeSessionHistory', hook]]) {
    result[name] = count(source, node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === name)
  }
  for (const [name, hits] of Object.entries(result)) assert(hits > 0, `${name} has an actual product caller outside its definition and tests`)
  return result
}
async function callerBindings(base) {
  const result = {}
  for (const [path, matches] of [
    ['apps/mobile/src/MobileApp.tsx', jsx('MobileConversationSurface')],
    ['apps/mobile/src/main.tsx', node => ts.isCallExpression(node) && node.expression.getText() === 'createBrowserPlatform']
  ]) {
    const source = parse(path, await readFile(join(base, path), 'utf8')), blocks = []
    function visit(node) { if (matches(node)) blocks.push(hash(node.getText(source))); ts.forEachChild(node, visit) }
    visit(source); assert(blocks.length > 0, `${path} contains its actual owning consumer block`)
    result[path] = blocks
  }
  return result
}
function functionBody(path, bytes, name, replacement) {
  const source = parse(path, bytes)
  const declarations = source.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name && node.body)
  assert.equal(declarations.length, 1, `${name} mutation has one exact body`)
  const body = declarations[0].body
  return bytes.slice(0, body.getStart(source)) + replacement + bytes.slice(body.end)
}
function replaceOne(bytes, from, to) {
  const start = bytes.indexOf(from)
  assert(start >= 0 && bytes.indexOf(from, start + from.length) === -1, 'Mutation block is present once and nonempty')
  return bytes.slice(0, start) + to + bytes.slice(start + from.length)
}
await mkdir(output, { recursive: true })
if (!flags.has('--preparation')) {
  const receipt = { scope: 'T003 complete gate', taskDone: false, status: 'blocked',
    reason: 'No authenticated original-Host consumer and physical-phone input/permission receipt has been supplied. Preparation cannot satisfy this gate.' }
  await writeFile(join(output, 'complete-gate.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.error(receipt.reason)
  process.exit(1)
}
const before = await bindings()
const beforeCallers = await callerBindings(root)
const candidate = join(output, `candidate-${process.pid}`)
let result
try {
  // Only small owned source/config copies. Dependency and compiled-Core paths are readonly links;
  // no mutation writes into the active worktree, including during failure cleanup.
  await mkdir(join(candidate, 'apps/mobile'), { recursive: true })
  await mkdir(join(candidate, 'packages/client-ui'), { recursive: true })
  await mkdir(join(candidate, 'packages/core/src'), { recursive: true })
  await cp(join(mobile, 'src'), join(candidate, 'apps/mobile/src'), { recursive: true })
  await cp(join(mobile, 'test'), join(candidate, 'apps/mobile/test'), { recursive: true })
  await cp(join(root, 'packages/client-ui/src'), join(candidate, 'packages/client-ui/src'), { recursive: true })
  await cp(join(root, 'packages/client-ui/package.json'), join(candidate, 'packages/client-ui/package.json'))
  await cp(join(root, 'packages/core/package.json'), join(candidate, 'packages/core/package.json'))
  await cp(join(mobile, 'package.json'), join(candidate, 'apps/mobile/package.json'))
  await cp(join(mobile, 'vitest.config.ts'), join(candidate, 'apps/mobile/vitest.base.config.ts'))
  for (const name of ['agent-prompt-condition', 'session-user-messages', 'errors']) {
    await cp(join(root, `packages/core/src/${name}.ts`), join(candidate, `packages/core/src/${name}.ts`))
  }
  for (const path of ['node_modules', 'apps/mobile/node_modules', 'packages/client-ui/node_modules', 'packages/core/node_modules', 'packages/core/dist']) {
    await symlink(join(root, path), join(candidate, path), 'dir')
  }
  const aliases = [{ find: '@agentmux/client-ui', replacement: join(candidate, 'packages/client-ui/src/index.ts') }]
  // Derive every pure UI public leaf from its actual source. Exact aliases precede the root
  // alias: Vite must not externalize an owning pure leaf to old compiled dist.
  for (const path of await files(join(candidate, 'packages/client-ui/src'))) {
    const subpath = relative(join(candidate, 'packages/client-ui/src'), path)
    if (subpath.startsWith('lib/') && subpath.endsWith('.ts')) aliases.unshift({ find: `@agentmux/client-ui/${subpath.slice(4, -3)}`, replacement: path })
    else if (subpath.startsWith('components/') && subpath.endsWith('.tsx')) aliases.unshift({ find: `@agentmux/client-ui/${subpath.slice(0, -4)}`, replacement: path })
  }
  aliases.unshift({ find: '@agentmux/client-ui/platform', replacement: join(candidate, 'packages/client-ui/src/platform.tsx') })
  aliases.unshift(...['prompt-condition', 'session-user-messages'].map(name => ({ find: `@agentmux/core/${name}`,
    replacement: join(candidate, `packages/core/src/${name === 'prompt-condition' ? 'agent-prompt-condition' : name}.ts`) })))
  const config = join(candidate, 'apps/mobile/vitest.config.ts'), sourceProof = join(candidate, 'transformed.json')
  await writeFile(config, `import base from './vitest.base.config'\nimport { writeFileSync, readFileSync } from 'node:fs'\nimport { createHash } from 'node:crypto'\nconst seen = new Map()\nexport default { ...base, resolve: { ...base.resolve, alias: ${JSON.stringify(aliases)} }, plugins: [...base.plugins, { name: 'mobile-source-proof', enforce: 'pre', transform(code,id) { const path=id.split('?')[0]; if(path.startsWith(${JSON.stringify(candidate + '/')}) && /\\.(ts|tsx)$/.test(path)) { seen.set(path.slice(${candidate.length + 1}),createHash('sha256').update(readFileSync(path)).digest('hex')); writeFileSync(${JSON.stringify(sourceProof)}, JSON.stringify(Object.fromEntries(seen))) } } }] }\n`)
  const run = async (name, pattern) => {
    const report = join(output, `${name}.json`)
    const args = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
      'test/conversation-surface.test.tsx', 'test/conversation-browser.test.tsx', '--reporter=json', `--outputFile=${report}`]
    if (pattern) args.push(`--testNamePattern=${pattern}`)
    const process = spawnSync(globalThis.process.execPath, args, { cwd: join(candidate, 'apps/mobile'), encoding: 'utf8', maxBuffer: 1024 * 1024 })
    await writeFile(join(output, `${name}.log`), process.stdout + process.stderr)
    const value = JSON.parse(await readFile(report, 'utf8'))
    return { exit: process.status, value }
  }
  const selectedPattern = correction ? 'authoritative rejection|accepted payload|entirely unapplied|authoritative nonapplication' : undefined
  const baseline = await run('isolated-baseline', selectedPattern)
  assert.equal(baseline.exit, 0, 'Actual mounted baseline collected and passed')
  const declaredCounts = await Promise.all(['conversation-surface.test.tsx', 'conversation-browser.test.tsx'].map(async path => {
    const source = parse(path, await readFile(join(candidate, 'apps/mobile/test', path), 'utf8'))
    return count(source,
      node => ts.isCallExpression(node) && node.expression.getText() === 'it' &&
        (!selectedPattern || ts.isStringLiteral(node.arguments[0]) && new RegExp(selectedPattern).test(node.arguments[0].text)))
  }))
  const declaredTests = declaredCounts.reduce((sum, value) => sum + value, 0)
  assert(declaredTests > 0, 'Declared mounted/browser behavior collection is nonempty')
  assert.equal(baseline.value.numPassedTests, declaredTests, 'Every declared mounted and browser behavior actually collected')
  const actualSource = JSON.parse(await readFile(sourceProof, 'utf8'))
  for (const path of ['packages/client-ui/src/components/AgentComposer.tsx', 'packages/client-ui/src/components/ConversationNativeThread.tsx',
    'packages/client-ui/src/lib/composer-semantic-reference.ts', 'packages/core/src/agent-prompt-condition.ts',
    'packages/core/src/session-user-messages.ts', 'apps/mobile/src/conversation/MobileConversationSurface.tsx',
    'apps/mobile/src/conversation/delivery.ts']) {
    assert.equal(actualSource[path], before[path], `${path} actually transformed from bound source bytes`)
  }
  const actualCallers = await callers(candidate)
  const mutations = []
  if (flags.has('--mutation-and-callers')) {
    const cases = correction ? [
      { name: 'prompt-phase-not-applied-is-not-whole-intent', path: 'apps/mobile/src/conversation/delivery.ts', pattern: 'accepted payload when only',
        mutate: (_path, bytes) => replaceOne(bytes,
          "if (detail === 'not_applied' && operation === 'interaction') return 'rejected'",
          "if (detail === 'not_applied' && (operation === 'interaction' || code === 'AGENT_PROMPT_INPUT_NOT_APPLIED')) return 'rejected'") },
      { name: 'pending-interaction-is-not-whole-intent', path: 'apps/mobile/src/conversation/delivery.ts', pattern: 'accepted payload when a pending interaction',
        mutate: (_path, bytes) => replaceOne(bytes,
          "? ['INVALID_AGENT_PROMPT', 'AGENT_PROMPT_CANCELLED', 'AGENT_PROMPT_SUBMISSION_BUSY']",
          "? ['INVALID_AGENT_PROMPT', 'AGENT_PROMPT_CANCELLED', 'AGENT_PROMPT_SUBMISSION_BUSY', 'AGENT_INTERACTION_PENDING']") }
    ] : [
      { name: 'unknown-is-not-rejection', path: 'apps/mobile/src/conversation/delivery.ts', pattern: 'sends one captured condition|accepted payload',
        mutate: (path, bytes) => functionBody(path, bytes, 'deliveryOutcome', "{ return 'rejected' }") },
      { name: 'late-receipt-original-draft', path: 'apps/mobile/src/conversation/MobileConversationSurface.tsx', pattern: 'binds a late receipt',
        mutate: (_path, bytes) => replaceOne(bytes, "if (drafts.current.get(key) === original.draft) drafts.current.set(key, '')", "drafts.current.set(JSON.stringify(['draft', current.current.agentSessionId]), '')") },
      { name: 'native-window-nonempty', path: 'packages/client-ui/src/components/ConversationNativeThread.tsx', pattern: 'retains native source order',
        mutate: (_path, bytes) => replaceOne(bytes, `const records = page.items.filter((item) => {\n    if (seen.has(item.id)) return false\n    seen.add(item.id)\n    return true\n  })`, 'const records = page.items.filter(() => false)') },
      { name: 'semantic-reference-source-leaf', path: 'packages/client-ui/src/lib/composer-semantic-reference.ts', pattern: 'sends one captured condition',
        mutate: (path, bytes) => functionBody(path, bytes, 'expandSemanticReferences', '{ return draft }') },
      { name: 'original-sdk-condition-source', path: 'packages/core/src/agent-prompt-condition.ts', pattern: 'sends one captured condition',
        mutate: (path, bytes) => functionBody(path, bytes, 'agentPromptCondition', '{ return { expectedRun: { ...session.run }, afterSubmissionId: null } }') },
      { name: 'cold-draft-and-intent-hydration', path: 'apps/mobile/src/conversation/local-drafts.ts', pattern: 'durable draft|unconfirmed original permission',
        mutate: (path, bytes) => {
          const source = parse(path, bytes), owner = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'createLocalDrafts')
          const blocks = owner.body.statements.filter(node => ts.isTryStatement(node))
          assert.equal(blocks.length, 1, 'One complete hydration block')
          const block = blocks[0]
          return bytes.slice(0, block.getStart(source)) + 'void 0' + bytes.slice(block.end)
        } },
      { name: 'unreadable-draft-byte-preservation', path: 'apps/mobile/src/conversation/local-drafts.ts', pattern: 'unreadable original draft bytes',
        mutate: (_path, bytes) => replaceOne(bytes, 'if (!writable) return', 'writable = true') },
      { name: 'unmounted-original-receipt', path: 'apps/mobile/src/conversation/MobileConversationSurface.tsx', pattern: 'durable draft',
        mutate: (_path, bytes) => replaceOne(bytes, 'if (!mounted.current) return\n      confirmPrompt(originalKey, original)', 'confirmPrompt(originalKey, original)') }
    ]
    for (const item of cases) {
      const path = join(candidate, item.path), original = await readFile(path, 'utf8')
      await writeFile(path, item.mutate(item.path, original))
      const red = await run(`mutation-${item.name}`, item.pattern)
      const failures = red.value.testResults.flatMap(suite => suite.assertionResults.filter(value => value.status === 'failed'))
      assert(red.exit !== 0 && failures.length > 0 && failures.some(value => value.failureMessages.some(message => message.includes('AssertionError'))), `${item.name} fails a collected behavior assertion, not just loading`)
      const transformed = JSON.parse(await readFile(sourceProof, 'utf8'))
      assert.equal(transformed[item.path], hash(await readFile(path)), `${item.name} mutation actually consumed`)
      await writeFile(path, original)
      const green = await run(`restored-${item.name}`, item.pattern)
      assert.equal(green.exit, 0, `${item.name} restored behavior GREEN`)
      assert(green.value.numPassedTests > 0, `${item.name} restored behavior collection is nonempty`)
      mutations.push({ name: item.name, path: item.path, redAssertions: failures.map(value => value.fullName), restoredTests: green.value.numPassedTests })
    }
    if (!correction) {
      const app = join(candidate, 'apps/mobile/src/MobileApp.tsx'), original = await readFile(app, 'utf8')
      const source = parse('MobileApp.tsx', original)
      let node
      function find(value) { if (jsx('MobileConversationSurface')(value)) node = value; ts.forEachChild(value, find) }
      find(source); assert(node && ts.isJsxSelfClosingElement(node), 'Owning mounted consumer block exists')
      await writeFile(app, original.slice(0, node.getStart(source)) + '<div />' + original.slice(node.end))
      await assert.rejects(() => callers(candidate), /actual product caller/)
      await writeFile(app, original)
      await callers(candidate)
      mutations.push({ name: 'remove-owning-mounted-consumer', path: 'apps/mobile/src/MobileApp.tsx', red: 'AssertionError: actual product caller absent', restored: true })
    }
  }
  assert.deepEqual(await bindings(), before, 'Owned source and SDK/UI dependency bindings remain byte-identical; concurrent drift invalidates preparation')
  assert.deepEqual(await callerBindings(root), beforeCallers, 'Actual owning caller blocks remain byte-identical; unrelated shell edits do not invalidate this consumer slice')
  result = { schema: correction ? 'agentmux.mobile-conversation-delivery-correction.v1' : 'agentmux.mobile-conversation-preparation.v1',
    scope: correction ? 'Bounded T003 prompt phase classification correction; historical nine proofs retained' : 'Approved-scoped T003 provisional consumer',
    prepared: true, taskDone: false, authenticatedPhoneGate: 'not supplied; complete command remains nonzero',
    baseline: { selectedPattern, declared: declaredTests, tests: baseline.value.numTotalTests,
      passed: baseline.value.numPassedTests, skipped: baseline.value.numPendingTests },
    bindings: before, callerBindings: beforeCallers, transformedSource: actualSource, callers: actualCallers, mutations,
    limits: ['SDK fakes are test-only; no authenticated RPC/device bootstrap is fabricated.',
      'happy-dom proves mounted behavior, not physical-phone IME, touch, keyboard or permissions.',
      'Native history and captured inputs retain independent authoritative sources; no cross-source deduplication is invented.'] }
  await writeFile(join(output, correction ? 'delivery-correction-receipt.json' : 'preparation-receipt.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(`Prepared ${result.baseline.passed} mounted/platform behaviors; ${mutations.length} isolated RED/restored GREEN proofs. T003 complete gate remains blocked.`)
} finally { await rm(candidate, { recursive: true, force: true }) }
