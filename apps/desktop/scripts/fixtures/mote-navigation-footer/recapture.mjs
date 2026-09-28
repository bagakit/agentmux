import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { listProbeProcesses, runProbeProcess } from '../../probe-process.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const pmo = 'apps/desktop/src/renderer/src/styles/pmo-teams-topic.css'
const uiOwners = ['App.tsx', 'components/SettingsPanel.tsx', 'components/PmoTeamsTopicFloatingPanel.tsx',
  'lib/pmo-teams-topic-floating.ts', 'components/TopRowChrome.tsx', 'components/PmoTeamsTopicEntry.tsx', 'styles/agent.css']
  .map(file => 'apps/desktop/src/renderer/src/' + file)
const names = ['narrow-long-names-all-motes-cards', 'narrow-avatars-custom-original-draft']
const archiveFiles = async directory => {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  const files = entries.filter(entry => entry.isFile()).map(entry => relative(directory, join(entry.parentPath, entry.name))).sort()
  assert.ok(files.length > 0, 'The actual archive must be nonempty')
  return Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(join(directory, file)))])))
}
const ruleFacts = root => {
  const facts = new Map()
  root.walkRules(rule => {
    const parents = []
    for (let node = rule.parent; node?.type !== 'root'; node = node.parent) {
      if (node.type === 'atrule') parents.unshift('@' + node.name + ' ' + node.params)
    }
    const key = JSON.stringify([parents, rule.selector])
    assert.ok(!facts.has(key), 'Changed CSS rule facts must have unique selector/context keys')
    facts.set(key, { context: parents, selector: rule.selector, declarations: rule.nodes.map(node => node.toString()).join(';') })
  })
  assert.ok(facts.size > 0, 'The stylesheet rule projection must be nonempty')
  return facts
}

export async function recapture({ desktop, repository, fixture, driver }, args) {
  assert.equal(args.length, 6, 'Use --reuse <compiled-receipt.json> --recapture narrow --candidate <manifest.json>')
  assert.deepEqual([args[0], args[2], args[3], args[4]], ['--reuse', '--recapture', 'narrow', '--candidate'])
  const parentFile = resolve(repository, args[1]), candidateFile = resolve(repository, args[5])
  const require = createRequire(join(desktop, 'package.json'))
  const postcss = createRequire(require.resolve('vite/package.json'))('postcss')
  const privateRoot = await mkdtemp(join(tmpdir(), 'agentmux-mote-presentation-recapture-'))
  const evidence = join(repository, '.tmp/mote-navigation-footer', `attempt-${Date.now()}`)
  const result = { schema: 'agentmux.mote-navigation-footer-css-derived.v1', passed: false,
    captureOnly: true, aestheticReview: 'not-performed', userAppOrRunTouched: false, stage: 'parent-archive-binding',
    limitations: [
      'No Vite Renderer rebuild. Parent compilation plus one exact whole raw CSS block replacement; capture drivers have separate provenance.',
      'All original actual interactions/assertions replayed in one private Renderer; only two affected narrow images are new.',
      'The six parent wide/Settings images retain their original reviewed scope and are not new screenshots of this CSS candidate.',
      'Controlled public data and Renderer pixels do not attest native/OS/IME, attachment, SDK/Core Run, ordinary recovery or the current whole working tree.',
      'No formal Core/desktop build, package, installation or user App restart.'
    ] }
  await mkdir(evidence, { recursive: true })
  let candidateRows = [], drivers = []
  try {
    const parentBytes = await readFile(parentFile), parent = JSON.parse(parentBytes)
    const captureFile = join(dirname(parentFile), 'receipt.json'), captureBytes = await readFile(captureFile)
    const capture = JSON.parse(captureBytes)
    assert.equal(capture.passed, true, 'Only a successful immutable original capture is reusable')
    assert.deepEqual(capture.inputFreshnessAtFinish.changed, [])
    assert.deepEqual(capture.inputs, parent.inputs); assert.deepEqual(capture.compiled, parent.compiled)
    assert.equal(Object.keys(parent.inputs).length, 502)
    assert.equal(Object.keys(parent.compiled).length, 103)
    assert.equal(Object.keys(parent.stylesheets).length, 43)
    assert.deepEqual(Object.keys(parent.stylesheets).sort(), [...parent.watchedStylesheets].sort())
    assert.deepEqual(await archiveFiles(parent.originalInputs), parent.inputs, 'Every original archived input byte agrees')
    assert.deepEqual(await archiveFiles(parent.compiledRenderer), parent.compiled, 'Every actual compiled output byte agrees')
    for (const [file, digest] of Object.entries(parent.stylesheets)) assert.equal(parent.inputs[file], digest)
    result.parent = { compiledReceipt: parentFile, compiledReceiptSha256: hash(parentBytes),
      captureReceipt: captureFile, captureReceiptSha256: hash(captureBytes), counts: { inputs: 502, compiled: 103, styles: 43 } }
    const candidateBytes = await readFile(candidateFile), candidate = JSON.parse(candidateBytes)
    candidateRows = candidate.files
    assert.equal(candidateRows.length, 15, 'The coherent product/test/config candidate is explicit and nonempty')
    const candidateInputs = Object.fromEntries(candidateRows.map(row => [row.path, row.sha256]))
    assert.equal(Object.keys(candidateInputs).length, candidateRows.length)
    for (const row of candidateRows) assert.equal(hash(await readFile(join(repository, row.path))), row.sha256, 'Candidate inputs agree before capture')
    for (const file of uiOwners) assert.equal(candidateInputs[file], parent.inputs[file], 'Only the authorized pmo CSS may change the Renderer product candidate')
    const oldCss = (await readFile(join(parent.originalInputs, pmo))).toString('utf8')
    const newBytes = await readFile(join(repository, pmo)), newCss = newBytes.toString('utf8')
    assert.equal(hash(newBytes), candidateInputs[pmo])
    assert.ok(oldCss.trim().length > 0 && newCss.trim().length > 0)
    assert.notEqual(hash(newBytes), parent.inputs[pmo], 'Recapture must consume an actual repaired stylesheet')
    const roots = [oldCss, newCss].map(css => postcss.parse(css, { from: pmo }))
    for (const root of roots) {
      assert.ok(root.nodes.length > 0, 'PostCSS must consume actual original rules')
      root.walkAtRules('import', () => { throw new Error('New CSS dependencies need ordinary compilation') })
      root.walkDecls(decl => assert.ok(!/url\s*\(/i.test(decl.value), 'CSS asset rewriting cannot be skipped'))
    }
    const oldRules = ruleFacts(roots[0]), newRules = ruleFacts(roots[1])
    result.changedRules = [...new Set([...oldRules.keys(), ...newRules.keys()])]
      .filter(key => JSON.stringify(oldRules.get(key)) !== JSON.stringify(newRules.get(key)))
      .map(key => ({ before: oldRules.get(key) ?? null, after: newRules.get(key) ?? null }))
    assert.ok(result.changedRules.length > 0)
    const matches = []
    for (const file of Object.keys(parent.compiled).filter(file => file.endsWith('.css'))) {
      const css = (await readFile(join(parent.compiledRenderer, file))).toString('utf8')
      const occurrences = css.split(oldCss).length - 1
      if (occurrences) matches.push({ file, css, occurrences })
    }
    assert.equal(matches.length, 1, 'Exactly one compiled stylesheet consumes the entire original pmo source')
    assert.equal(matches[0].occurrences, 1, 'The full actual source block is a unique nonempty replacement anchor')
    result.stage = 'private-derived-css-archive'
    await cp(parent.compiledRenderer, join(evidence, 'renderer'), { recursive: true })
    await cp(parent.originalInputs, join(evidence, 'original-inputs'), { recursive: true })
    const compiledCssFile = matches[0].file, replaced = matches[0].css.replace(oldCss, newCss)
    assert.equal(replaced.replace(newCss, oldCss), matches[0].css, 'Every byte outside the authorized CSS block is unchanged')
    assert.equal(replaced.split(newCss).length - 1, 1)
    await writeFile(join(evidence, 'renderer', compiledCssFile), replaced)
    await writeFile(join(evidence, 'original-inputs', pmo), newBytes)
    result.inputs = { ...parent.inputs, [pmo]: hash(newBytes) }
    result.stylesheets = { ...parent.stylesheets, [pmo]: hash(newBytes) }
    result.watchedStylesheets = parent.watchedStylesheets
    result.compiled = { ...parent.compiled, [compiledCssFile]: hash(Buffer.from(replaced)) }
    result.compiledRenderer = join(evidence, 'renderer'); result.originalInputs = join(evidence, 'original-inputs')
    assert.deepEqual(await archiveFiles(result.compiledRenderer), result.compiled)
    assert.deepEqual(await archiveFiles(result.originalInputs), result.inputs)
    result.derivation = { kind: 'original-vite-compilation-plus-one-exact-raw-css-replacement',
      source: pmo, originalSha256: parent.inputs[pmo], replacementSha256: hash(newBytes),
      compiledCssFile, originalCompiledSha256: parent.compiled[compiledCssFile], replacementCompiledSha256: result.compiled[compiledCssFile],
      postcssSyntaxValidated: true, newImportsOrAssetUrls: false, exactUniqueWholeSourceAnchor: true,
      allOtherCompiledAndOriginalBytesIdentical: true, unchangedProductUiOwners: uiOwners }
    await mkdir(join(evidence, 'capture-driver'))
    const driverFiles = [driver, import.meta.filename, join(fixture, 'main.cjs'), join(fixture, 'scenario.md'), join(desktop, 'scripts/probe-process.mjs')]
    drivers = await Promise.all(driverFiles.map(async file => {
      const bytes = await readFile(file), copy = join(evidence, 'capture-driver', relative(desktop, file))
      await mkdir(dirname(copy), { recursive: true }); await writeFile(copy, bytes)
      return { path: file, archived: copy, sha256: hash(bytes) }
    }))
    result.captureDrivers = drivers
    await writeFile(join(evidence, 'capture-driver/candidate.json'), candidateBytes)
    result.candidate = { path: candidateFile, sha256: hash(candidateBytes), inputs: candidateRows }
    await writeFile(join(evidence, 'parent-compiled-receipt.json'), parentBytes)
    const derived = { schema: result.schema, stage: 'css-derived-archive-only', inputs: result.inputs,
      stylesheets: result.stylesheets, watchedStylesheets: result.watchedStylesheets, compiled: result.compiled,
      compiledRenderer: result.compiledRenderer, originalInputs: result.originalInputs,
      sourceScope: result.derivation.kind, derivation: result.derivation, parent: result.parent,
      captureDrivers: drivers, candidate: result.candidate, changedRules: result.changedRules, limitations: result.limitations }
    await writeFile(join(evidence, 'compiled-receipt.json'), JSON.stringify(derived, null, 2))
    console.log(JSON.stringify({ stage: 'css-derived-archive-only', receipt: join(evidence, 'compiled-receipt.json'), compiledRenderer: result.compiledRenderer }))
    result.stage = 'single-private-narrow-recapture'
    const outDir = join(privateRoot, 'renderer'); await cp(result.compiledRenderer, outDir, { recursive: true })
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const logs = [], main = drivers.find(row => row.path === join(fixture, 'main.cjs')).archived
    result.exit = await runProbeProcess(require('electron'), [main, join(outDir, 'index.html'), privateRoot, evidence, JSON.stringify(names)], {
      temporaryRoot: privateRoot, cwd: repository, env, timeoutMs: 60000, onLine: line => logs.push(line) })
    await writeFile(join(evidence, 'renderer.log'), logs.join('\n'))
    result.renderer = JSON.parse(await readFile(join(evidence, 'renderer.json'), 'utf8'))
    assert.equal(result.exit.timedOut, false); assert.equal(result.exit.exitCode, 0, result.renderer.failure?.message)
    assert.equal(result.renderer.passed, true)
    assert.deepEqual(result.renderer.frames.map(frame => frame.name), names)
    assert.equal(result.renderer.replayedFrames.length, 8)
    for (const frame of result.renderer.frames) assert.equal(hash(await readFile(join(evidence, frame.file))), frame.sha256)
    for (const row of candidateRows) assert.equal(hash(await readFile(join(repository, row.path))), row.sha256, 'Coherent owned inputs agree after capture')
    for (const row of drivers) {
      assert.equal(hash(await readFile(row.path)), row.sha256, 'The actual capture driver remained unchanged')
      assert.equal(hash(await readFile(row.archived)), row.sha256)
    }
    assert.deepEqual(await archiveFiles(result.compiledRenderer), result.compiled)
    assert.deepEqual(await archiveFiles(result.originalInputs), result.inputs)
    assert.equal(hash(await readFile(parentFile)), result.parent.compiledReceiptSha256)
    result.inheritedFrames = capture.renderer.frames.filter(frame => !names.includes(frame.name)).map(frame => ({
      name: frame.name, file: join(dirname(parentFile), frame.file), sha256: frame.sha256,
      scope: 'Original capture only; no new wide/Settings screenshot or independent CSS-candidate aesthetic approval.' }))
    result.passed = true; result.stage = 'two-narrow-frames-captured-independent-look-pending'
  } catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack } }
  finally {
    result.cleanup = { remaining: await listProbeProcesses(-1, privateRoot), privateRootRemoved: false }
    if (!result.cleanup.remaining.length) { await rm(privateRoot, { recursive: true }); result.cleanup.privateRootRemoved = true }
    const phase = await readFile(join(evidence, 'renderer.json'), 'utf8').catch(() => null)
    if (!result.renderer && phase) result.renderer = JSON.parse(phase)
    await writeFile(join(evidence, 'receipt.json'), JSON.stringify(result, null, 2))
    await writeFile(join(evidence, 'review.md'), [
      '# Mote narrow presentation — exact CSS-derived recapture', '',
      `Capture passed: ${result.passed}. Stage: ${result.stage}. Independent actual look is pending.`, '',
      'This is the original Vite compilation plus one uniquely matched actual pmo CSS source replacement, not a new Vite build.',
      'All original interactions/assertions replay; only these two complete Renderer frames are new:', '',
      ...(result.renderer?.frames ?? []).map(frame => `- [${frame.name}](${frame.file}) — ${frame.sha256}`), '',
      'Parent six frames keep their prior scope. Read changedRules, derivation, parent and captureDrivers in receipt.json; do not relabel parent wide images as new candidate captures.',
      'Renderer pixels/controlled data do not sign native/OS/IME, SDK/Core Run, ordinary restart or installation.'
    ].join('\n'))
  }
  console.log(JSON.stringify({ passed: result.passed, stage: result.stage, receipt: join(evidence, 'receipt.json'), cleanup: result.cleanup, failure: result.failure }))
  assert.equal(result.cleanup.remaining.length, 0); assert.equal(result.cleanup.privateRootRemoved, true)
  assert.equal(result.passed, true, result.failure?.message)
}
