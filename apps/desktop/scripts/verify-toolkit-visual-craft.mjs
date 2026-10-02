import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { captureCraft } from './fixtures/toolkit-visual-craft/capture.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), mode = process.argv[2]
assert.ok(process.argv.length === 3 && ['--owning', '--callers', '--capture', '--visual'].includes(mode), 'One explicit finite identity proof mode')
const base = resolve(root, ".bagakit/design/toolkit-visual-craft-fixture/formal"); await mkdir(base, { recursive: true })
const evidence = await mkdtemp(resolve(base, 'run-')), inputs = {}, results = [], exec = promisify(execFile)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const proofFiles = ['apps/desktop/scripts/verify-toolkit-visual-craft.mjs',
  ...['entry.tsx', 'index.html', 'main.cjs', 'checks.cjs', 'capture.mjs'].map(file => 'apps/desktop/scripts/fixtures/toolkit-visual-craft/' + file),
  ...['core-entry.ts', 'owner-entry.ts', 'entry.tsx', 'preload.cjs'].map(file => 'apps/desktop/scripts/fixtures/toolkit-custom-identity/' + file),
  'apps/desktop/scripts/fixtures/toolkit-custom-ui/tsconfig.owning.json', 'tsconfig.base.json']
async function bind(file) {
  const bytes = await readFile(resolve(root, file)); assert.ok(bytes.length, 'Nonempty actual input: ' + file)
  if (Object.hasOwn(inputs, file)) assert.equal(inputs[file].sha256, sha(bytes), 'Fixed candidate input: ' + file)
  else inputs[file] = { sha256: sha(bytes), bytes: bytes.length }
  return bytes
}
async function owning(name, mutation = null, target = 'all') {
  const directory = resolve(evidence, name); await mkdir(directory)
  const capture = await captureCraft({ root, evidence: directory, bind, proofFiles, mode: target, mutation })
  if (mutation) { assert.equal(capture.specificAssertionRED, true); assert.ok(capture.loadedCSS.some(item => item.changed > 0)) }
  const value = { name, mutation, target, specificAssertionRED: !!capture.specificAssertionRED, receipt: relative(root, resolve(directory, 'capture.json')) }
  results.push(value); console.log(JSON.stringify(value))
}
async function callers() {
  const require = createRequire(resolve(root, 'apps/desktop/package.json')), ts = require('typescript')
  const configFile = resolve(root, 'apps/desktop/scripts/fixtures/toolkit-custom-ui/tsconfig.owning.json')
  const config = ts.readConfigFile(configFile, ts.sys.readFile); assert.equal(config.error, undefined)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configFile)); assert.deepEqual(parsed.errors, [])
  const program = ts.createProgram(parsed.fileNames, parsed.options), checker = program.getTypeChecker(), edges = []
  const required = ['JSX ToolkitSettingsPane', 'JSX ToolkitToolEditor', 'JSX UserToolkitResult', 'JSX BuiltinPerformanceSettings', 'createAccountUsageTool', 'useToolkitDrafts', 'ToolkitDesktopApi.add', 'ToolkitDesktopApi.update', 'ToolkitDesktopApi.run', 'openToolkit']
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
  const entryFile = 'apps/desktop/src/renderer/src/main.tsx', indexFile = 'apps/desktop/src/renderer/src/styles/index.css', cssFile = 'apps/desktop/src/renderer/src/styles/settings-toolkit.css'
  const entry = ts.createSourceFile(entryFile, (await bind(entryFile)).toString(), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  assert.ok(entry.statements.some(node => ts.isImportDeclaration(node) && node.moduleSpecifier.text === './styles/index.css'), 'Actual production renderer consumes the full index cascade')
  const postcss = createRequire(require.resolve('vite'))('postcss'), index = postcss.parse((await bind(indexFile)).toString(), { from: indexFile })
  const stylesheetEdges = []; index.walkAtRules('import', rule => { if (/^["']\.\/settings-toolkit\.css["']/u.test(rule.params)) stylesheetEdges.push({ caller: indexFile, definition: cssFile, name: 'CSS toolkit consumer', line: rule.source.start.line }) })
  assert.equal(stylesheetEdges.length, 1, 'Production index cascade consumes the actual owning Toolkit CSS exactly once')
  await bind(cssFile); edges.push({ caller: entryFile, definition: indexFile, name: 'Production style cascade' }, ...stylesheetEdges)
  await writeFile(resolve(evidence, 'callers.json'), JSON.stringify(edges, null, 2) + '\n'); results.push({ edges })
}
async function visual() {
  const packet = JSON.parse(await bind(".bagakit/design/toolkit-visual-craft-fixture/qualification/current.json"))
  assert.equal(packet.schema, 'agentmux.toolkit-visual-craft-qualification.v1')
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
  for (const frame of capture.frames) {
    assert.ok(frame.requested.width > 0 && frame.requested.height > 0)
    assert.equal(frame.actualCSS.width, frame.contentSize.width); assert.equal(frame.actualCSS.height, frame.contentSize.height)
    assert.ok(frame.imageSize.width > 0 && frame.imageSize.height > 0 && frame.actualCSS.pixelRatio > 0)
    assert.ok(frame.pngPixels.width > 0 && frame.pngPixels.height > 0)
    assert.equal(frame.appearance.dataset, frame.theme); assert.equal(frame.appearance.colorScheme, frame.theme)
  }
  assert.equal(peer.sourceIdentity, capture.sourceIdentity); assert.equal(peer.verdict.toLowerCase(), 'pass'); assert.deepEqual(peer.mustFix, [])
  assert.equal(peer.images.length, 6); assert.equal(new Set(peer.images.map(image => image.file)).size, 6)
  for (const frame of capture.frames) {
    const image = peer.images.find(image => image.file === frame.file); assert.ok(image?.personallyViewedOriginal); assert.equal(image.sha256, frame.sha256)
    const png = await bind(relative(root, resolve(directory, frame.file))); assert.equal(sha(png), frame.sha256)
    assert.equal(png.readUInt32BE(16), frame.pngPixels.width); assert.equal(png.readUInt32BE(20), frame.pngPixels.height)
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
    for (const mutation of ['hierarchy', 'palette', 'nameFocus']) {
      await owning(mutation, mutation, mutation); await owning(mutation + '-restored', null, mutation)
    }
  } else if (mode === '--callers') await callers()
  else if (mode === '--capture') {
    const directory = resolve(evidence, 'capture'); await mkdir(directory)
    const capture = await captureCraft({ root, evidence: directory, bind, proofFiles }); results.push({ capture: relative(root, resolve(directory, 'capture.json')), sourceIdentity: capture.sourceIdentity })
  } else await visual()
  for (const [file, identity] of Object.entries(inputs)) assert.equal(sha(await readFile(resolve(root, file))), identity.sha256, 'Final candidate stays fixed: ' + file)
  await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify({ schema: 'agentmux.toolkit-visual-craft-proof.v1', completed: true, mode, inputs, results }, null, 2) + '\n')
  console.log(relative(root, evidence))
} catch (error) {
  await writeFile(resolve(evidence, 'failure.json'), JSON.stringify({ schema: 'agentmux.toolkit-visual-craft-proof.v1', completed: false, mode, inputs, results, error: String(error?.stack ?? error) }, null, 2) + '\n'); throw error
}
