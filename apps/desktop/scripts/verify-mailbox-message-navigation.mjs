import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { runProbeProcess, listProbeProcesses, signalOwnedProbeProcess } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const mode = process.argv[2], exec = promisify(execFile), require = createRequire(import.meta.url)
assert.ok(['--mutations', '--native', '--source'].includes(mode), 'Choose one approved finite navigation proof')
const base = '87b105ef7e06a654b29efa0239b2ec5c971f7350'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const privateRoot = await mkdtemp(join(tmpdir(), 'amx-mailbox-navigation-'))
const evidence = join(root, '.tmp/mailbox-message-navigation', mode.slice(2) + '-' + globalThis.crypto.randomUUID())
const typedPaths = [
  'apps/desktop/src/renderer/src/components/SessionPane.tsx', 'apps/desktop/src/renderer/src/components/ActivityView.tsx',
  'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx', 'apps/desktop/src/renderer/src/components/SessionMailbox.tsx',
  'apps/desktop/src/renderer/src/components/ComposerOutbox.tsx', 'apps/desktop/src/renderer/src/lib/session-user-messages.ts',
  'apps/desktop/src/renderer/src/lib/mailbox-message-navigation.ts', 'packages/client-ui/src/components/ConversationMessage.tsx',
  'packages/client-ui/src/components/ConversationNativeThread.tsx', 'packages/client-ui/src/lib/conversation-message-location.ts'
]
const stylePaths = ['packages/client-ui/src/styles/composer.css', 'packages/client-ui/src/styles/conversation-message.css']
const productPaths = [...typedPaths, ...stylePaths]
const originals = Object.fromEntries(await Promise.all(productPaths.map(async path => [path, await readFile(join(root, path), 'utf8')])))
const result = { schema: 'agentmux.mailbox-message-navigation-proof.v1', mode, passed: false, worktreeBase: base,
  userRunTouched: false, sharedSourceWritten: false, aestheticReview: 'not-performed', mutations: [], cleanup: {} }
await mkdir(evidence, { recursive: true })

async function mounted(label, expectRed) {
  let code = 0, output = ''
  try { const run = await exec(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config',
    'apps/desktop/scripts/fixtures/mailbox-message-navigation/vitest.config.mts',
    'apps/desktop/test/mailbox-message-navigation.integration.test.tsx', '--maxWorkers=1'],
    { cwd: privateRoot, timeout: 60000, maxBuffer: 4 * 1024 * 1024 }); output = run.stdout + run.stderr }
  catch (error) { code = error.code; output = (error.stdout ?? '') + (error.stderr ?? '') }
  await writeFile(join(evidence, label + '.log'), output)
  const discovery = JSON.parse(await readFile(join(privateRoot, '.tmp/mailbox-message-navigation/mounted/discovery.json'), 'utf8'))
  assert.equal(discovery.passed, true); assert.equal(discovery.discovered.length, 1); assert.ok(discovery.discovered[0].tests > 0)
  if (expectRed) { assert.equal(typeof code, 'number'); assert.notEqual(code, 0); assert.match(output, /AssertionError:/, 'Actual mounted assertion, not import/timeout, must fail') }
  else assert.equal(code, 0, label + ': candidate/restored mounted assertions pass')
  return { code, assertionRed: expectRed, discovery, log: label + '.log' }
}

async function mutations() {
  for (const dir of ['apps/desktop/src', 'apps/desktop/test/helpers', 'apps/desktop/resources', 'packages/core/src', 'packages/demand/src', 'packages/layout/src', 'packages/client-ui/src'])
    await cp(join(root, dir), join(privateRoot, dir), { recursive: true })
  for (const file of ['package.json', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'vitest.setup.ts', 'apps/desktop/package.json',
    'apps/desktop/tsconfig.json', 'packages/core/package.json', 'packages/client-ui/package.json', 'packages/client-ui/tsconfig.json',
    'packages/demand/package.json', 'packages/layout/package.json', 'apps/desktop/test/mailbox-message-navigation.integration.test.tsx',
    'apps/desktop/scripts/fixtures/mailbox-message-navigation/vitest.config.mts', 'apps/desktop/scripts/fixtures/settings-overview/vitest.config.mts'])
    await cp(join(root, file), join(privateRoot, file))
  for (const path of ['node_modules', 'apps/desktop/node_modules', 'packages/core/node_modules', 'packages/demand/node_modules', 'packages/layout/node_modules', 'packages/client-ui/node_modules'])
    await symlink(join(root, path), join(privateRoot, path), 'dir')
  result.baseline = await mounted('baseline', false)
  const cases = [
    { name: 'native-namespace-removed', file: typedPaths[9], from: "JSON.stringify([sessionId, 'native', source.providerId, source.nativeSessionId, source.recordId])", to: "JSON.stringify([sessionId, 'native', source.recordId])" },
    { name: 'wrong-rendered-node', file: typedPaths[1], from: '.filter(node => node.dataset.messageSourceKey === revealRequest.sourceKey)', to: ".filter(node => node.dataset.messageId === 'same')" },
    { name: 'pending-navigation-enabled', file: typedPaths[4], from: '<button type="button" className="composer-mailbox__reveal" disabled>在对话中查看</button><span>尚未发送，暂无对话位置</span></span>}', to: '<button type="button" className="composer-mailbox__reveal" onClick={() => onSend?.(selected.id)}>在对话中查看</button><span>尚未发送，暂无对话位置</span></span>}' },
    { name: 'old-generation-accepted', file: typedPaths[0], from: 'generation !== navigation.current.generation', to: 'false' },
    { name: 'inflight-followed-by-extra-read', file: typedPaths[5], from: 'if (entry.inFlight) await entry.inFlight', to: "if (entry.inFlight) { await entry.inFlight; await fetchSessionHistoryPage(control, entry, 'earlier') }" },
    { name: 'terminal-unmounted-on-activity', file: typedPaths[0], from: ' || terminalLifetime.current.opened ? (', to: ' ? (' },
    { name: 'reveal-routed-to-other-presentation', file: typedPaths[0], from: 'revealRequest?.displayId === workbenchSessionStageHostId(target, linkOrigin.regionId!) ? revealRequest : null', to: 'revealRequest?.displayId !== workbenchSessionStageHostId(target, linkOrigin.regionId!) ? revealRequest : null' },
    { name: 'unavailable-reader-stage-accepted', file: typedPaths[0], from: "if (live.processState !== 'running') {", to: 'if (false) {' }
  ]
  assert.ok(cases.length > 0)
  for (const item of cases) {
    const original = originals[item.file]; assert.equal(original.split(item.from).length, 2, 'Unique nonempty production anchor: ' + item.name)
    const changed = original.replace(item.from, item.to)
    await writeFile(join(privateRoot, item.file), changed); const red = await mounted(item.name, true)
    await writeFile(join(privateRoot, item.file), original); const restored = await mounted(item.name + '-restored', false)
    result.mutations.push({ ...item, originalSha256: hash(original), mutatedSha256: hash(changed), red, restored, sharedSourceWritten: false })
  }
}

async function source() {
  const ts = await import('typescript')
  const app = ts.getParsedCommandLineOfConfigFile(join(root, 'apps/desktop/tsconfig.json'), {}, ts.sys)
  const shared = ts.getParsedCommandLineOfConfigFile(join(root, 'packages/client-ui/tsconfig.json'), {}, ts.sys)
  assert.ok(app.fileNames.length > 0 && shared.fileNames.length > 0)
  const paths = { '@agentmux/client-ui/components/*': ['packages/client-ui/src/components/*.tsx'],
    '@agentmux/client-ui/terminal/*': ['packages/client-ui/src/terminal/*.ts'],
    '@agentmux/client-ui/platform': ['packages/client-ui/src/platform.tsx'], '@agentmux/client-ui': ['packages/client-ui/src/index.ts'],
    '@agentmux/client-ui/*': ['packages/client-ui/src/lib/*.ts'], '@agentmux/layout': ['packages/layout/src/index.ts'] }
  for (const pkg of ['core', 'demand']) {
    for (const [key, entry] of Object.entries(JSON.parse(readFileSync(join(root, `packages/${pkg}/package.json`), 'utf8')).exports)) {
      if (typeof entry === 'object' && entry.import) paths[`@agentmux/${pkg}${key === '.' ? '' : key.slice(1)}`] =
        [`packages/${pkg}/` + entry.import.replace('./dist/', './src/').replace('./src/src/', './src/').replace(/\.js$/, '.ts')]
    }
  }
  const options = { ...app.options, baseUrl: root, paths }
  const roots = [...new Set([...app.fileNames, ...shared.fileNames])]
  const tracked = execFileSync('git', ['ls-tree', '-r', '--name-only', base], { cwd: root, encoding: 'utf8' }).trim().split('\n')
    .filter(path => /^(apps\/desktop|packages\/(core|demand|layout|client-ui))\//.test(path) && /\.(tsx?|json)$/.test(path))
  assert.ok(tracked.length > 0)
  // Virtual committed baseline: no second checkout, no shared Source writes, and no hand-written diagnostic allowlist.
  const blobs = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: tracked.map(path => `${base}:${path}\n`).join(''), maxBuffer: 64 * 1024 * 1024 })
  const baselineFiles = new Map(); let offset = 0
  for (const path of tracked) { const end = blobs.indexOf(10, offset), header = blobs.subarray(offset, end).toString().split(' '), size = Number(header.at(-1));
    assert.ok(Number.isFinite(size)); baselineFiles.set(join(root, path), blobs.subarray(end + 1, end + 1 + size).toString()); offset = end + 2 + size }
  const build = (baseline = false, override = new Map()) => {
    const host = ts.createCompilerHost(options), read = host.readFile, exists = host.fileExists
    host.readFile = file => override.has(file) ? override.get(file) : baseline && baselineFiles.has(file) ? baselineFiles.get(file) : read(file)
    host.fileExists = file => baselineFiles.has(file) || exists(file)
    host.getSourceFile = (file, version) => { const text = host.readFile(file); return text === undefined ? undefined : ts.createSourceFile(file, text, version, true) }
    const program = ts.createProgram(baseline ? roots.filter(file => baselineFiles.has(file)) : roots, options, host)
    const diagnostics = ts.getPreEmitDiagnostics(program).map(d => ({ file: d.file ? relative(root, d.file.fileName) : '<config>',
      line: d.file ? d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1 : 0,
      character: d.file ? d.file.getLineAndCharacterOfPosition(d.start ?? 0).character + 1 : 0, code: d.code,
      category: d.category, message: ts.flattenDiagnosticMessageText(d.messageText, '\n') }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    return { program, diagnostics }
  }
  const baseline = build(true), candidate = build()
  const owned = candidate.diagnostics.filter(d => typedPaths.includes(d.file)), others = candidate.diagnostics.filter(d => !typedPaths.includes(d.file))
  const baselineOthers = baseline.diagnostics.filter(d => !typedPaths.includes(d.file))
  for (const path of typedPaths) assert.ok(candidate.program.getSourceFile(join(root, path)), 'Complete Program consumes typed owner: ' + path)
  result.program = { appRootCount: app.fileNames.length, sharedRootCount: shared.fileNames.length, consumedSourceFiles: candidate.program.getSourceFiles().length,
    typedOwners: typedPaths, ownedDiagnostics: owned, otherDiagnostics: others, baselineOtherDiagnostics: baselineOthers,
    baselineAllDiagnostics: baseline.diagnostics, baseline: base }
  await writeFile(join(evidence, 'program.json'), JSON.stringify(result.program, null, 2))
  assert.equal(owned.length, 0, 'Every owned production typed Source has zero diagnostics')
  assert.deepEqual(others, baselineOthers, 'Every other diagnostic equals the complete fixed-base Program, item by item')
  const callerSpecs = [
    [typedPaths[0], 'AgentSessionComposer', 'onRevealMessage'], [typedPaths[2], 'SessionMailbox', 'onRevealMessage'],
    [typedPaths[3], 'ConversationMessage', 'messageActions'], [typedPaths[0], 'ActivityView', 'revealRequest'],
    [typedPaths[0], 'SessionActivityPresentation', 'activity'], [typedPaths[1], 'ConversationNativeThread', 'locatedMessageKey'],
    [typedPaths[8], 'ConversationMessage', 'located']
  ]
  result.callers = callerSpecs.map(([path, tag, prop]) => {
    const file = candidate.program.getSourceFile(join(root, path)), matches = []
    const visit = node => { if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(file) === tag &&
      node.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(file) === prop)) {
      matches.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, tag, prop }) }
      ts.forEachChild(node, visit) }
    visit(file); assert.ok(matches.length > 0, 'Actual external JSX production caller is nonempty: ' + tag + '.' + prop)
    return { file: path, matches }
  })
  const callFile = candidate.program.getSourceFile(join(root, typedPaths[3])), calls = []
  const visitCall = node => { if (ts.isCallExpression(node) && node.expression.getText(callFile) === 'onRevealMessage') calls.push(callFile.getLineAndCharacterOfPosition(node.pos).line + 1); ts.forEachChild(node, visitCall) }
  visitCall(callFile); assert.ok(calls.length > 0); result.callers.push({ file: typedPaths[3], callback: 'onRevealMessage', calls })
  const file = typedPaths[0], from = 'const sourceKey = conversationMessageSourceKey', original = originals[file]
  assert.equal(original.split(from).length, 2)
  const changed = original.replace(from, 'const sourceKey: number = conversationMessageSourceKey')
  const red = build(false, new Map([[join(root, file), changed]])), redOwned = red.diagnostics.filter(d => typedPaths.includes(d.file))
  assert.ok(redOwned.some(d => d.file === file && d.code === 2322), 'Actual production TypeScript bad change fails an assignment assertion')
  const restored = build(); assert.deepEqual(restored.diagnostics, candidate.diagnostics)
  result.mutations.push({ name: 'production-source-key-invalid-type', file, originalSha256: hash(original), mutatedSha256: hash(changed),
    assertionRed: true, redDiagnostics: redOwned, restoredDiagnosticsMatchCandidate: true, sharedSourceWritten: false })
  await writeFile(join(evidence, 'callers.json'), JSON.stringify(result.callers, null, 2))
}

async function compiled(dir) {
  const files = await readdir(dir, { recursive: true, withFileTypes: true }), hashes = {}
  for (const file of files) if (file.isFile()) { const path = join(file.parentPath, file.name); hashes[relative(dir, path)] = hash(await readFile(path)) }
  assert.ok(Object.keys(hashes).length > 0); return hashes
}

async function native(label, broken = '') {
  const { build } = await import('vite'), fixture = join(desktop, 'scripts/fixtures/mailbox-message-navigation')
  const directory = join(evidence, label), processRoot = join(privateRoot, label), outDir = join(processRoot, 'out')
  await mkdir(directory, { recursive: true }); await mkdir(processRoot, { recursive: true })
  const wrapper = join(processRoot, 'record-xterm.mjs'), main = join(processRoot, 'probe-main.cjs'), mainBytes = await readFile(join(fixture, 'main.cjs'))
  await writeFile(main, mainBytes)
  await writeFile(wrapper, `import xterm from ${JSON.stringify(require.resolve('@xterm/xterm'))};\nexport class Terminal extends xterm.Terminal{constructor(...args){super(...args);const entries=globalThis.resultReadyTerminals??=[];this.probeIdentity={id:entries.length,terminal:this,disposed:false};entries.push(this.probeIdentity)}dispose(){this.probeIdentity.disposed=true;return super.dispose()}}\n`)
  const loadedSourceInputs = {}, importedStyleInputs = {}, mutationRecords = []
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', resolve: { alias: [
    { find: /^@agentmux\/client-ui\/components\/(.+)$/, replacement: join(root, 'packages/client-ui/src/components/$1.tsx') },
    { find: /^@agentmux\/client-ui\/styles\/(.+)$/, replacement: join(root, 'packages/client-ui/src/styles/$1') },
    { find: /^@agentmux\/client-ui\/terminal\/(.+)$/, replacement: join(root, 'packages/client-ui/src/terminal/$1.ts') },
    { find: /^@agentmux\/client-ui\/platform$/, replacement: join(root, 'packages/client-ui/src/platform.tsx') },
    { find: /^@agentmux\/client-ui\/(.+)$/, replacement: join(root, 'packages/client-ui/src/lib/$1.ts') },
    { find: /^@agentmux\/client-ui$/, replacement: join(root, 'packages/client-ui/src/index.ts') },
    { find: /^@xterm\/xterm$/, replacement: wrapper },
    { find: /^@agentmux\/core\/control$/, replacement: join(root, 'packages/core/src/control.ts') },
    { find: /^@agentmux\/core\/terminal-continuation$/, replacement: join(root, 'packages/core/src/terminal-continuation.ts') }
  ] }, plugins: [{ name: 'mailbox-navigation-actual-source', enforce: 'pre', transform(source, id) {
    if ((id.startsWith(join(desktop, 'src') + '/') || id.startsWith(join(desktop, 'scripts/fixtures') + '/') || id.startsWith(join(root, 'packages/client-ui/src') + '/')) && !id.includes('?')) loadedSourceInputs[relative(root, id)] = hash(source)
    if (broken === 'position' && id === join(root, typedPaths[1])) {
      const from = "head.scrollIntoView({ block: 'center', behavior: 'instant' })"; assert.equal(source.split(from).length, 2)
      const changed = source.replace(from, 'void head')
      mutationRecords.push({ file: typedPaths[1], originalSha256: hash(source), mutatedSha256: hash(changed), from, to: 'void head', sharedSourceWritten: false })
      return changed
    }
  }, async generateBundle() { for (const path of this.getWatchFiles()) if ((path.startsWith(join(desktop, 'src') + '/') || path.startsWith(join(root, 'packages/client-ui/src') + '/')) && path.endsWith('.css')) importedStyleInputs[relative(root, path)] = hash(await readFile(path)) } }],
    css: { postcss: { plugins: [{ postcssPlugin: 'mailbox-navigation-actual-imported-css', async Once(sheet) {
      if (broken !== 'compact') return
      const file = join(root, stylePaths[1]), selector = ".log-turn[data-compact='true'] .log-turn__head", declarations = []
      // Imported CSS is consumed by PostCSS, rather than a separate Rollup transform.
      sheet.walkDecls('display', declaration => {
        if (declaration.source?.input.file === file && declaration.parent.selector === selector) declarations.push(declaration)
      })
      if (!declarations.length) return
      assert.equal(declarations.length, 1, 'Actual compact header display declaration is unique and nonempty')
      assert.equal(declarations[0].value, 'flex')
      const source = await readFile(file, 'utf8'), from = selector + ' { display: flex; }'
      assert.equal(source.split(from).length, 2)
      const to = selector + ' { display: grid; grid-template-columns: minmax(0, 1fr) repeat(4, auto); }', changed = source.replace(from, to)
      declarations[0].value = 'grid'
      declarations[0].cloneAfter({ prop: 'grid-template-columns', value: 'minmax(0, 1fr) repeat(4, auto)' })
      await writeFile(join(directory, 'original.css'), source); await writeFile(join(directory, 'mutated.css'), changed)
      mutationRecords.push({ file: stylePaths[1], originalSha256: hash(source), mutatedSha256: hash(changed),
        astDeclaration: { selector, property: 'display', originalValue: 'flex', mutatedValue: 'grid' }, from, to, sharedSourceWritten: false })
    } }] } },
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' },
    build: { outDir, emptyOutDir: true, commonjsOptions: { include: [/node_modules/, /xterm-locked-925/] } } })
  assert.equal(mutationRecords.length, broken ? 1 : 0, 'Requested actual Source/style mutation applies exactly once')
  for (const path of typedPaths.filter(path => path !== 'apps/desktop/src/renderer/src/lib/mailbox-message-navigation.ts'))
    assert.equal(loadedSourceInputs[path], hash(originals[path]), 'Actual runtime Source consumed: ' + path)
  for (const path of stylePaths) assert.equal(importedStyleInputs[path], hash(originals[path]), 'Actual style consumed: ' + path)
  const identity = { loadedSourceInputs, importedStyleInputs, compiledFiles: await compiled(outDir), privateMainSha256: hash(mainBytes),
    terminalWrapperSha256: hash(await readFile(wrapper)), mutationRecords, electronVersion: require('electron/package.json').version,
    runtimeScope: 'Existing compiled Runtime package and exact current public control/terminal-continuation Source entries; private preview does not certify a live CLI/Runtime.' }
  await writeFile(join(directory, 'compiled.json'), JSON.stringify(identity, null, 2))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const lines = [], outcome = await runProbeProcess(require('electron'), [main, join(outDir, 'index.html'), processRoot, directory, label === 'candidate' ? 'capture' : 'verify'],
    { temporaryRoot: processRoot, cwd: root, env, timeoutMs: 60000, onLine: line => lines.push(line) })
  await writeFile(join(directory, 'process.log'), lines.join('\n'))
  const rendered = JSON.parse(await readFile(join(directory, 'render.json'), 'utf8'))
  assert.equal(outcome.timedOut, false); assert.equal(outcome.interruption, null)
  assert.equal((await listProbeProcesses(-1, processRoot)).length, 0); await rm(processRoot, { recursive: true, force: true })
  return { directory: relative(root, directory), outcome, rendered, identity, privateProcessRootRemoved: true }
}

try {
  result.sourceCommit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
  result.productSources = Object.fromEntries(Object.entries(originals).map(([path, bytes]) => [path, hash(bytes)]))
  if (mode === '--mutations') await mutations()
  else if (mode === '--source') await source()
  else {
    result.candidate = await native('candidate'); assert.equal(result.candidate.outcome.exitCode, 0, result.candidate.rendered.failure?.message); assert.equal(result.candidate.rendered.passed, true)
    const red = await native('position-red', 'position'); assert.equal(red.outcome.exitCode, 1); assert.equal(red.rendered.failure.name, 'AssertionError'); assert.match(red.rendered.failure.message, /exact target.*viewport/i)
    const compactRed = await native('compact-identity-red', 'compact'); assert.equal(compactRed.outcome.exitCode, 1); assert.equal(compactRed.rendered.failure.name, 'AssertionError'); assert.match(compactRed.rendered.failure.message, /compact identity.*readable width/i)
    const restored = await native('position-restored'); assert.equal(restored.outcome.exitCode, 0, restored.rendered.failure?.message); assert.equal(restored.rendered.passed, true)
    result.mutations.push({ name: 'actual-exact-position-disabled', red, restored, sharedSourceWritten: false })
    result.mutations.push({ name: 'actual-compact-identity-squeezed', red: compactRed, restored, sharedSourceWritten: false })
    assert.equal(result.candidate.rendered.scenes.length, 3)
    assert.ok(result.candidate.rendered.frames.length > 0)
    await writeFile(join(evidence, 'review.md'), '# Mailbox message navigation — actual Native review inputs\n\n' +
      'Scope: exact current desktop/shared Source in private Workbench; no live user CLI, Runtime restart, package or aesthetic approval.\n\n' +
      'The real existing View toggle establishes both mode insets and visible-resume size reassertion. Navigation preserves each corresponding mode geometry; hidden Terminal identity, rows, cursor and bytes stay exact. Returning to Terminal uses its original instance and trusted keyboard input.\n\n' +
      result.candidate.rendered.frames.map(frame => `- ${frame.scene.width}px ${frame.scene.appearance} ${frame.scene.mode}: [${frame.file}](candidate/${frame.file}), SHA256 ${frame.sha256}`).join('\n') + '\n\n' +
      'Inspect every complete original PNG independently. Machine position, final activeElement, source/dispatch, read, xterm, neighbor and mutation facts are in receipt.json and candidate/render.json; actual loaded Source/style and compiled hashes are in candidate/compiled.json.\n')
  }
  for (const [path, original] of Object.entries(originals)) assert.equal(hash(await readFile(join(root, path))), hash(original), 'Owned Source unchanged by private proof: ' + path)
  result.passed = true
} catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack }; throw error }
finally {
  const before = await listProbeProcesses(-1, privateRoot); for (const pid of before) await signalOwnedProbeProcess(pid, privateRoot, 'SIGKILL')
  result.cleanup = { before, after: await listProbeProcesses(-1, privateRoot) }; assert.equal(result.cleanup.after.length, 0)
  await rm(privateRoot, { recursive: true, force: true }); result.cleanup.temporaryRootRemoved = true
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ passed: result.passed, evidence: relative(root, evidence), receipt: relative(root, join(evidence, 'receipt.json')), failure: result.failure?.message ?? null }))
}
