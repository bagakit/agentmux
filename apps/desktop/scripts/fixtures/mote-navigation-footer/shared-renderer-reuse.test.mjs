import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const driver = resolve(import.meta.dirname, '../../verify-mote-navigation-footer.mjs')
const repository = resolve(import.meta.dirname, '../../../../..')
const source = await readFile(driver, 'utf8')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sourceStart = source.indexOf('const sharedRendererEntries =')
const sourceEnd = source.indexOf('const inputs =', sourceStart)
const compileStart = source.indexOf('    const aliases = []')
const compileEnd = source.indexOf(' })\n  }', compileStart)
assert.ok(sourceStart >= 0 && sourceEnd > sourceStart && compileStart >= 0 && compileEnd > compileStart, 'Both actual Source blocks must be nonempty')
assert.match(source.slice(sourceStart, sourceEnd), /async function verifySharedRendererReuse/)
assert.match(source.slice(compileStart, compileEnd), /await build/)
const evidence = resolve(repository, '.tmp/mote-shared-renderer-source', String(Date.now()))
await mkdir(evidence, { recursive: true })
const receipt = { schema: 'agentmux.mote-shared-renderer-source.v1', source: { path: relative(repository, driver), sha256: hash(source) }, actualCompileCapture: false, userAppOrRunTouched: false, cases: [], mutations: [] }

async function environment(text = source) {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-shared-renderer-source-'))
  const fixture = join(root, 'apps/desktop/scripts/fixtures/mote-navigation-footer'), compiled = join(root, 'compiled')
  const profile = join(root, 'dependency/profiling.js'), implementation = join(root, 'dependency/cjs/react-dom-profiling.profiling.js')
  for (const file of [profile, implementation]) { await mkdir(resolve(file, '..'), { recursive: true }); await writeFile(file, '/* immutable bounded library fixture */ ' + basename(file)) }
  const original = join(root, 'instrumentation'); await mkdir(original)
  const globals = { moteArchive: true, motePaperdoll: false, fixture, repository: root, require: { resolve: name => { assert.equal(name, 'react-dom/profiling'); return profile } }, readFile, hash, basename, join, relative, resolve, assert }
  const start = text.indexOf('const sharedRendererEntries ='), end = text.indexOf('const inputs =', start)
  assert.ok(start >= 0 && end > start)
  const scope = runInNewContext(text.slice(start, end) + '\n({ verifySharedRendererReuse, sharedRendererEntries, sharedRendererInputs, profilingFiles, parse: text => JSON.parse(text) })', globals)
  assert.equal(scope.sharedRendererInputs.length, 6)
  const model = { stage: 'compiled-only', rendererEntries: [...scope.sharedRendererEntries], inputs: {}, compiled: {}, compiledRenderer: compiled, instrumentation: { renderer: 'react-dom/profiling', sources: [] } }
  await mkdir(compiled)
  for (const path of scope.sharedRendererInputs) {
    const file = join(root, path); await mkdir(resolve(file, '..'), { recursive: true }); await writeFile(file, 'original current Source ' + path)
    model.inputs[path] = hash(await readFile(file))
  }
  for (const entry of scope.sharedRendererEntries) { await writeFile(join(compiled, entry), '<html>original compiled ' + entry + '</html>'); model.compiled[entry] = hash(await readFile(join(compiled, entry))) }
  for (const file of [profile, implementation]) {
    const bytes = await readFile(file), preserved = join(original, basename(file)); await writeFile(preserved, bytes)
    model.instrumentation.sources.push({ path: file, sha256: hash(bytes), preserved, consumed: true })
  }
  const candidate = scope.sharedRendererInputs.map(path => ({ path, sha256: model.inputs[path] }))
  const validate = value => scope.verifySharedRendererReuse(scope.parse(JSON.stringify(value)), candidate)
  return { root, fixture, profile, scope, model, candidate, validate, dispose: () => rm(root, { recursive: true, force: true }) }
}

async function guardCases(text, publish = false) {
  const env = await environment(text)
  const { model, validate } = env
  try {
    await validate(model)
    assert.deepEqual([...env.scope.sharedRendererEntries], ['archive.html', 'paperdoll.html'])
    if (publish) receipt.cases.push('nonempty two-entry current Source reuse accepted')
    for (const [name, change] of [
      ['single entry receipt', value => { value.rendererEntries.pop() }],
      ['paperdoll compiled entry absent', value => { delete value.compiled['paperdoll.html'] }],
      ['unprofiling graph', value => { value.instrumentation.renderer = 'react-dom/client' }],
      ['empty profiling originals', value => { value.instrumentation.sources = [] }],
      ['profiling original not consumed', value => { value.instrumentation.sources[0].consumed = false }],
      ['changed avatar shared contract', value => { value.inputs['apps/desktop/src/shared/mote-avatars.ts'] = 'old-source' }],
      ['changed original event owner', value => { value.inputs['apps/desktop/src/renderer/src/lib/session-events.ts'] = 'old-source' }],
      ['changed other entry Source', value => { value.inputs[env.scope.sharedRendererInputs[3]] = 'old-source' }]
    ]) {
      const changed = structuredClone(model); change(changed)
      await assert.rejects(() => validate(changed), { name: 'AssertionError' }, name)
      if (publish) receipt.cases.push(name)
    }
    for (const [name, file] of [['changed current profiling source', env.profile], ['corrupt preserved profiling original', model.instrumentation.sources[0].preserved]]) {
      const original = await readFile(file)
      await writeFile(file, Buffer.concat([original, Buffer.from(' changed bytes')]))
      await assert.rejects(() => validate(model), { name: 'AssertionError' }, name)
      if (publish) receipt.cases.push(name)
      await writeFile(file, original)
    }
    const avatar = join(env.root, 'apps/desktop/src/shared/mote-avatars.ts'), original = await readFile(avatar)
    await writeFile(avatar, Buffer.concat([original, Buffer.from(' changed after compilation')]))
    await assert.rejects(() => validate(model), { name: 'AssertionError' }, 'actual current avatar Source changed after original compilation')
    if (publish) receipt.cases.push('actual current Source bytes differ')
    await writeFile(avatar, original)
    await writeFile(join(model.compiledRenderer, 'paperdoll.html'), '<html>corrupt entry</html>')
    await assert.rejects(() => validate(model), { name: 'AssertionError' }, 'corrupt compiled entry original SHA')
    if (publish) receipt.cases.push('corrupt compiled entry SHA')
  } finally { await env.dispose() }
}

async function compileChoices(text, publish = false) {
  const start = text.indexOf('    const aliases = []'), end = text.indexOf(' })\n  }', start)
  assert.ok(start >= 0 && end > start)
  for (const mode of ['archive', 'paperdoll']) {
    const env = await environment(text)
    try {
      let configuration
      const invoke = runInNewContext('(async () => {\n' + text.slice(start, end + 3) + '\n})', {
        moteIdentity: false, moteArchive: mode === 'archive', motePaperdoll: mode === 'paperdoll', sharedRenderer: true,
        sharedRendererEntries: env.scope.sharedRendererEntries, fixture: env.fixture, repository,
        require: { resolve: () => env.profile }, readFile, join, assert, outDir: join(env.root, 'unused'),
        sourceBinding: { name: 'unused-no-vite' }, stylesheetBinding: { name: 'unused-no-postcss' },
        build: async options => { configuration = options }
      })
      await invoke()
      assert.deepEqual([...configuration.build.rollupOptions.input], ['archive.html', 'paperdoll.html'].map(name => join(env.fixture, name)))
      const profiling = configuration.resolve.alias.filter(row => row.find.test('react-dom/client'))
      assert.equal(profiling.length, 1); assert.equal(profiling[0].replacement, env.profile)
      if (publish) receipt.cases.push(mode + ' uses actual two-input maintained profiling choice without Vite')
    } finally { await env.dispose() }
  }
}

test('actual driver chooses one shared graph and rejects stale/partial original artifacts without compiling', async () => {
  await compileChoices(source, true); await guardCases(source, true)
})
test('direct original-driver mutations make the same nonempty Node-only acceptance red', async () => {
  const variants = [
    ['one compiler entry', "sharedRendererEntries.map(name => join(fixture, name))", "[join(fixture, 'archive.html')]", compileChoices],
    ['archive misses profiling alias', 'if (sharedRenderer) aliases.push', 'if (motePaperdoll) aliases.push', compileChoices],
    ['compiled paperdoll entry unchecked', 'for (const entry of sharedRendererEntries) {', "for (const entry of sharedRendererEntries.filter(entry => entry !== 'paperdoll.html')) {", guardCases],
    ['shared current Source unchecked', "assert.equal(parent.inputs[file], current, 'All current shared/task Renderer producers agree with reused original inputs: ' + file)", '', guardCases],
    ['compiled original SHA unchecked', "assert.equal(hash(bytes), parent.compiled[entry], 'The compiled entry original SHA agrees')", '', guardCases],
    ['current profiling Source unchecked', "assert.equal(hash(current), row.sha256, 'Current maintained profiling source agrees with the compilation')", '', guardCases],
    ['preserved profiling original unchecked', "assert.equal(hash(original), row.sha256, 'Original profiling bytes remain bound')", '', guardCases],
    ['unprofiling graph accepted', "assert.equal(parent.instrumentation?.renderer, 'react-dom/profiling', 'Shared compilation uses the maintained profiling renderer')", '', guardCases]
  ]
  assert.equal(variants.length, 8)
  for (const [name, anchor, replacement, acceptance] of variants) {
    assert.ok(source.includes(anchor), 'Actual mutation anchor exists: ' + name)
    const changed = source.replace(anchor, replacement); assert.notEqual(changed, source)
    let red
    try { await acceptance(changed) } catch (error) { red = error }
    assert.equal(red?.name, 'AssertionError', 'Actual acceptance must become an assertion failure: ' + name)
    await acceptance(source)
    receipt.mutations.push({ name, original: hash(source), mutated: hash(changed), red: { name: red.name, message: red.message }, restoredGreen: true })
    await writeFile(join(evidence, name.replaceAll(' ', '-') + '.source.mjs'), changed)
  }
  await compileChoices(source); await guardCases(source)
  assert.equal(hash(await readFile(driver)), hash(source), 'Author Source remains unchanged')
  receipt.passed = true
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, receipt: join(evidence, 'receipt.json'), assertions: receipt.cases.length, mutations: receipt.mutations.length }))
})
