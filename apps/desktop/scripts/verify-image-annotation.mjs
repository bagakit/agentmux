import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
let slice, mutations = false
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--slice') { assert.equal(slice, undefined, 'Choose one verification slice'); slice = args[++index] }
  else if (args[index] === '--mutations') mutations = true
  else throw new Error('Unsupported image annotation proof option: ' + args[index])
}
assert.ok(['boundary', 'editing', 'documents'].includes(slice), 'Use --slice boundary|editing|documents')
const adapter = 'apps/desktop/src/renderer/src/components/browser-screenshot/ScreenshotEditor.tsx'
const component = 'apps/desktop/src/renderer/src/components/image-annotation/'
const host = 'apps/desktop/src/renderer/src/components/browser-screenshot/'
const specifications = {
  boundary: {
    tests: ['workface.test.tsx', 'native-overlay.test.tsx', 'toolbar.test.tsx', 'model.test.ts', 'compose.test.ts', 'context.test.ts']
      .map(name => 'apps/desktop/test/browser-screenshot-' + name),
    mutations: [{ label: 'adapter-cancel-omitted', source: adapter,
      find: 'function cancel() { operation.current += 1; props.onCancel() }', replace: 'function cancel() { operation.current += 1 }',
      test: 'apps/desktop/test/browser-screenshot-workface.test.tsx',
      consumer: 'Cancel exits the real editor and restores the same Browser bounds', failure: /null|Screenshot editor|image-annotation-editor/i }]
  },
  editing: {
    tests: [...['geometry.test.ts', 'view.test.ts', 'editing.test.tsx'].map(name => 'apps/desktop/test/image-annotation-' + name), 'apps/desktop/test/browser-screenshot-workface.test.tsx'],
    mutations: [{ label: 'selected-corner-resize-omitted', source: component + 'selection-geometry.ts',
      find: 'const from = { ...original.from }, to = { ...original.to }', replace: 'return original; const from = { ...original.from }, to = { ...original.to }',
      test: 'apps/desktop/test/image-annotation-editing.test.tsx', consumer: 'resizes an existing rectangle and arrow endpoint through real handles and preserves their IDs through Undo', failure: /actual selected corner must resize/ },
    { label: 'wheel-anchor-omitted', source: component + 'view.ts',
      find: 'return { scale, x: anchor.x - point.x * scale, y: anchor.y - point.y * scale }', replace: 'return { scale, x: view.x, y: view.y }',
      test: 'apps/desktop/test/image-annotation-editing.test.tsx', consumer: 'anchors wheel zoom, pans with Space, and completes drawing in original pixels without changing export dimensions', failure: /actual wheel zoom must preserve/ },
    { label: 'existing-text-replacement-omitted', source: component + 'ImageAnnotationEditor.tsx',
      find: 'else if (text !== draft.shape.text) edit(doc => replaceShape(doc, { ...draft.shape, text }))', replace: 'else if (text !== draft.shape.text) { /* private mutation omits the existing object edit */ }',
      test: 'apps/desktop/test/image-annotation-editing.test.tsx', consumer: 'edits existing text by button and double click, cancels without replacing it, then commits one object and undoes it', failure: /actual existing text must be replaced/ },
    { label: 'paint-frame-coalescing-omitted', source: component + 'ImageAnnotationEditor.tsx',
      find: 'if (paintFrame.current) return', replace: 'if (false) return',
      test: 'apps/desktop/test/browser-screenshot-workface.test.tsx', consumer: 'coalesces continuous drawing on one frame while Copy consumes all samples and the final endpoint exactly once', failure: /actual continuous samples must share/ },
    { label: 'committed-layer-cache-omitted', source: component + 'ImageAnnotationEditor.tsx',
      find: 'if (!previous || previous.document !== state.documentState || previous.view !== currentView || previous.size !== state.size ||',
      replace: 'if (true || !previous || previous.document !== state.documentState || previous.view !== currentView || previous.size !== state.size ||',
      test: 'apps/desktop/test/browser-screenshot-workface.test.tsx', consumer: 'coalesces continuous drawing on one frame while Copy consumes all samples and the final endpoint exactly once', failure: /actual unchanged document must reuse/ },
    { label: 'edge-text-ui-clamping-omitted', source: component + 'ImageAnnotationEditor.tsx',
      find: 'left: Math.max(0, Math.min(size.width - textEditorWidth, view.x + pendingText.shape.at.x * scale))',
      replace: 'left: view.x + pendingText.shape.at.x * scale',
      test: 'apps/desktop/test/image-annotation-editing.test.tsx', consumer: 'keeps an existing edge text editor inside the viewport at actual size and high zoom without changing its image coordinates or font', failure: /actual input width stays within/ }]
  },
  documents: {
    tests: ['apps/desktop/test/image-annotation-documents.test.ts', 'apps/desktop/test/image-annotation-file-dialog.test.tsx', 'apps/desktop/test/image-annotation-host.test.tsx', 'apps/desktop/test/image-annotation-file-menu.test.tsx'],
    mutations: [{ label: 'document-shapes-discarded', source: component + 'document.ts',
      find: 'const shapes = object.shapes.map(shape), ids = new Set(shapes.map(item => item.id))', replace: 'const shapes: ScreenshotShape[] = [], ids = new Set(shapes.map(item => item.id))',
      test: 'apps/desktop/test/image-annotation-documents.test.ts', consumer: 'round trips every shape, exact pixels, IDs, crop and historical metadata without serializing runtime identity or Undo', failure: /pen|shapes/ },
    { label: 'owner-file-write-omitted', source: host + 'document-files.ts',
      find: 'return await files.write(input.workspaceId, { path: input.path, content, expectedRevision: input.expectedRevision })', replace: "return { status: 'written', revision: 'private-unapplied-write' }",
      test: 'apps/desktop/test/image-annotation-documents.test.ts', consumer: 'writes and reopens through the actual WorkspaceFiles owner, retaining revision conflicts and the original file', failure: /called 1 times|called.*once|Number of calls|0 times/i },
    { label: 'modal-duplicate-submit-guard-omitted', source: host + 'AnnotationFileDialog.tsx',
      find: 'closed.current || pending.current || !submittedPath.length', replace: 'closed.current || !submittedPath.length',
      test: 'apps/desktop/test/image-annotation-file-dialog.test.tsx', consumer: 'submits the exact whitespace-bearing path once despite rapid repeated submit events', failure: /once|1|2/i },
    { label: 'hidden-host-operation-invalidation-omitted', source: adapter,
      find: 'if (props.active === false) operation.current += 1', replace: 'if (false) operation.current += 1',
      test: 'apps/desktop/test/image-annotation-host.test.tsx', consumer: 'invalidates a pending full image decode when its Pane is hidden and preserves the original editor after showing it', failure: /same|expected|to be/i },
    { label: 'saved-editor-navigation-ownership-omitted', source: 'apps/desktop/src/renderer/src/components/BrowserPane.tsx',
      find: "onOriginalOpened={() => setScreenshot(current => current ? { kind: 'open', key: current.key } : null)}", replace: 'onOriginalOpened={() => {}}',
      test: 'apps/desktop/test/image-annotation-host.test.tsx', consumer: 'keeps a reopened file editor and its historical source across background Browser navigation', failure: /null/ }]
  }
}
const specification = specifications[slice], tests = specification.tests
const owningConfig = 'apps/desktop/test/vitest.image-annotation.config.mts'
const require = createRequire(resolve('package.json'))
const cli = require.resolve('vitest/vitest.mjs')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const work = await mkdtemp(join(tmpdir(), 'agentmux-image-annotation-'))
const out = resolve('.local/browser-image-annotation/' + slice)
await mkdir(out, { recursive: true }); await rm(join(out, 'receipt.json'), { force: true })
const directories = [component, host].map(directory => directory.replace(/\/$/, ''))
const inputs = [...tests, ...(slice === 'documents' ? [component + 'document.ts', component + 'drawing-model.ts', component + 'types.ts', host + 'document-files.ts',
  adapter, component + 'ImageAnnotationEditor.tsx', component + 'AnnotationNotes.tsx', component + 'AnnotationToolbar.tsx', component + 'AnnotationOriginalMenu.tsx', component + 'view.ts', component + 'selection-geometry.ts', component + 'image-annotation.css',
  'apps/desktop/src/renderer/src/components/BrowserPane.tsx', host + 'context.ts', host + 'compose.ts',
  host + 'AnnotationFileDialog.tsx', 'apps/desktop/src/renderer/src/components/WindowOverlayHost.tsx', 'apps/desktop/test/helpers/client-ui-render.tsx',
  'apps/desktop/src/main/workspace-files.ts', 'apps/desktop/native/workspace-move.c', 'apps/desktop/scripts/build-workspace-move-helper.mjs',
  'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/shared/workspace-file-bytes.ts'] : [adapter, 'apps/desktop/src/renderer/src/components/BrowserPane.tsx',
  'apps/desktop/src/renderer/src/styles/browser.css', 'apps/desktop/test/helpers/client-ui-render.tsx']),
  'apps/desktop/scripts/verify-image-annotation.mjs', owningConfig, 'apps/desktop/scripts/radix-overlay-aliases.ts',
  'apps/desktop/electron.vite.config.ts', 'vitest.config.ts', 'vitest.dist-freshness.ts']
for (const directory of directories) for (const name of await readdir(directory)) {
  const file = directory + '/' + name
  if (/\.(?:tsx?|css)$/.test(name) && !inputs.includes(file)) inputs.push(file)
}
const sourceInputs = Object.fromEntries(await Promise.all(inputs.map(async path => [path, sha(await readFile(path))])))
const source = Object.fromEntries(await Promise.all(specification.mutations.map(async mutation => [mutation.source, await readFile(mutation.source, 'utf8')])))
const evidence = { slice, passed: false, sourceInputs, cases: [] }
function child(argv) {
  return new Promise((done, reject) => {
    const processChild = spawn(process.execPath, [cli, ...argv], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', expired = false, escalation
    processChild.stdout.on('data', data => { output += data }); processChild.stderr.on('data', data => { output += data })
    const timer = setTimeout(() => { expired = true; processChild.kill('SIGTERM'); escalation = setTimeout(() => processChild.kill('SIGKILL'), 1000) }, 45000)
    processChild.once('error', error => { clearTimeout(timer); clearTimeout(escalation); reject(error) })
    processChild.once('exit', (code, signal) => {
      clearTimeout(timer); clearTimeout(escalation)
      expired ? reject(new Error('The exact private Vitest child timed out and exited')) : done({ code, signal, output })
    })
  })
}
async function run(label, mutation) {
  const report = join(work, label + '.json'), config = join(work, label + '.config.mjs')
  const mutant = join(work, label + '.tsx'), loaded = join(work, label + '.loaded.json')
  let mutationSource
  if (mutation) {
    const original = source[mutation.source]
    assert.equal(original.split(mutation.find).length - 1, 1, 'The exact source mutation must be unique: ' + label)
    mutationSource = original.replace(mutation.find, mutation.replace)
    await writeFile(mutant, mutationSource)
    await writeFile(config, `import base from ${JSON.stringify(pathToFileURL(resolve(owningConfig)).href)};
import { readFileSync, writeFileSync } from 'node:fs'; import { createHash } from 'node:crypto';
export default {...base,plugins:[...(base.plugins??[]),{name:'private-original-annotation-mutation',enforce:'pre',load(id){
 if(id.split('?')[0]!==${JSON.stringify(resolve(mutation.source))})return;
 const code=readFileSync(${JSON.stringify(mutant)},'utf8');
 writeFileSync(${JSON.stringify(loaded)},JSON.stringify({source:${JSON.stringify(mutation.source)},sha256:createHash('sha256').update(code).digest('hex')}));
 return {code,map:null};}}]};`)
  }
  const selected = mutation ? [mutation.test] : tests
  const result = await child(['run', ...selected, '--config', mutation ? config : owningConfig, ...(mutation ? ['-t', mutation.consumer] : []),
    '--maxWorkers=1', '--reporter=json', '--outputFile', report])
  const raw = JSON.parse(await readFile(report, 'utf8').catch(error => {
    throw new Error('The owning test produced no fresh result: ' + result.output.replaceAll(process.cwd(), '<repository>'), { cause: error })
  }))
  const assertions = raw.testResults.flatMap(suite => suite.assertionResults)
  if (mutation) {
    const consumed = JSON.parse(await readFile(loaded, 'utf8'))
    assert.deepEqual(consumed, { source: mutation.source, sha256: sha(mutationSource) }, 'The original owner loads the exact private mutation')
    const cases = assertions.filter(row => row.title === mutation.consumer)
    assert.equal(cases.length, 1, 'The actual annotation consumer is unique and nonempty')
    assert.equal(result.code, 1); assert.equal(cases[0].status, 'failed')
    assert.match(cases[0].failureMessages.join('\n'), mutation.failure, 'The loaded mutant fails at its actual consumer')
    evidence.cases.push({ label, result: 'RED', consumer: mutation.consumer, mutation: { source: mutation.source, sha256: sha(mutationSource) } })
  } else {
    assert.equal(result.code, 0, result.output.replaceAll(process.cwd(), '<repository>'))
    assert.ok(assertions.length > 0, 'The real mounted/model suites are nonempty')
    assert.deepEqual(assertions.map(row => row.status), assertions.map(() => 'passed'))
    const observed = raw.testResults.map(suite => relative(process.cwd(), suite.name))
    assert.deepEqual([...observed].sort(), [...tests].sort(), 'Each requested original suite executes')
    evidence.cases.push({ label, result: 'GREEN', tests: assertions.length, suites: observed,
      consumers: assertions.map(row => row.fullName) })
  }
  console.log(slice + ' ' + label + ': ' + (mutation ? 'expected RED' : 'GREEN'))
}
try {
  if (slice === 'documents') {
    const built = await new Promise((done, reject) => {
      const child = spawn(process.execPath, ['apps/desktop/scripts/build-workspace-move-helper.mjs'], { cwd: process.cwd(), stdio: 'inherit' })
      let expired = false, escalation
      const timer = setTimeout(() => { expired = true; child.kill('SIGTERM'); escalation = setTimeout(() => child.kill('SIGKILL'), 1000) }, 20000)
      child.once('error', error => { clearTimeout(timer); clearTimeout(escalation); reject(error) })
      child.once('exit', code => { clearTimeout(timer); clearTimeout(escalation); expired ? reject(new Error('The exact private helper build child timed out and exited')) : done(code) })
    })
    assert.equal(built, 0, 'The actual WorkspaceFiles helper builds before physical file proof')
    evidence.nativeHelper = { source: 'apps/desktop/native/workspace-move.c', sha256: sha(await readFile('apps/desktop/resources/bin/agentmux-workspace-move')) }
  }
  await run('source')
  if (mutations) { for (const mutation of specification.mutations) await run(mutation.label, mutation); await run('restored-source') }
  if (slice === 'editing') {
    const result = await new Promise((done, reject) => {
      const child = spawn(process.execPath, ['apps/desktop/scripts/verify-browser-screenshot-model.mjs', ...(mutations ? ['--mutations'] : [])], { cwd: process.cwd(), env: process.env, stdio: 'inherit' })
      let expired = false, escalation
      const timer = setTimeout(() => { expired = true; child.kill('SIGTERM'); escalation = setTimeout(() => child.kill('SIGKILL'), 1000) }, 120000)
      child.once('error', error => { clearTimeout(timer); clearTimeout(escalation); reject(error) })
      child.once('exit', code => { clearTimeout(timer); clearTimeout(escalation); expired ? reject(new Error('The exact native Canvas proof runner timed out and exited')) : done(code) })
    })
    assert.equal(result, 0, 'The actual Electron Canvas proof completes with its own source mutations')
    const path = '.local/browser-screenshot-workface/model-proof/receipt.json', bytes = await readFile(path), receipt = JSON.parse(bytes)
    assert.equal(receipt.passed, true); assert.ok(receipt.cases.length > 0)
    evidence.nativeCanvas = { receipt: path, sha256: sha(bytes), ...receipt }
  }
  for (const [path, digest] of Object.entries(sourceInputs)) assert.equal(sha(await readFile(path)), digest, 'Proof input changed: ' + path)
  evidence.passed = true
  await writeFile(join(out, 'receipt.json'), JSON.stringify(evidence, null, 2))
} finally { await rm(work, { recursive: true, force: true }) }
