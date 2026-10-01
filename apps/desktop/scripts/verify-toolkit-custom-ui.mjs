import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const proofFiles = ['apps/desktop/scripts/verify-toolkit-custom-ui.mjs', 'apps/desktop/scripts/verify-toolkit-custom.mjs',
  'apps/desktop/scripts/fixtures/toolkit-custom-ui/vitest.config.mts', 'apps/desktop/scripts/fixtures/toolkit-custom-ui/tsconfig.owning.json',
  'apps/desktop/test/toolkit-custom-drafts.test.tsx', 'apps/desktop/test/toolkit-custom-ui.test.tsx',
  'apps/desktop/test/toolkit-custom-navigation.test.tsx', 'apps/desktop/test/toolkit-custom-cost.test.tsx']

/** UI owns its actual consumers and proof. Backend modes keep their original inputs and execution. */
export async function verifyToolkitCustomUi({ root, mode }) {
  assert.ok(['--ui', '--ui-mutations', '--ui-callers'].includes(mode), 'Explicit owning UI verification mode')
  const base = resolve(root, ".bagakit/design/toolkit-custom-ui-intake-fixture/formal")
  await mkdir(base, { recursive: true })
  const evidence = await mkdtemp(resolve(base, 'run-')), inputs = {}, results = [], exec = promisify(execFile)
  const receipt = { schema: 'agentmux.toolkit-custom-ui-proof.v1', mode, completed: false, evidence, inputs, results }
  async function bind(path) {
    const bytes = await readFile(resolve(root, path))
    assert.ok(bytes.length > 0, 'Nonempty actual proof input: ' + path)
    if (Object.hasOwn(inputs, path)) assert.equal(inputs[path], sha(bytes), 'Bound input changed: ' + path)
    else {
      inputs[path] = sha(bytes)
      const target = resolve(evidence, 'inputs', path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes)
    }
    return bytes
  }
  async function unchanged() {
    assert.ok(Object.keys(inputs).length > 0, 'Actual input collection is nonempty')
    for (const [path, digest] of Object.entries(inputs)) assert.equal(sha(await readFile(resolve(root, path))), digest, 'Owning UI input changed: ' + path)
  }
  async function run(name, mutant = 'baseline', pattern, cost = false) {
    const directory = resolve(evidence, name); await mkdir(directory)
    const json = resolve(directory, 'results.json'), env = { ...process.env, AGENTMUX_TOOLKIT_UI_EVIDENCE: directory, AGENTMUX_TOOLKIT_UI_MUTANT: mutant }
    delete env.AGENTMUX_TOOLKIT_PREFERENCES_MUTANT; delete env.AGENTMUX_TOOLKIT_UI_COST_PROOF
    if (cost) env.AGENTMUX_TOOLKIT_UI_COST_PROOF = '1'
    let output, exitCode = 0
    try { output = await exec(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/scripts/fixtures/toolkit-custom-ui/vitest.config.mts',
      '--reporter=json', '--outputFile=' + json, ...(pattern ? ['--testNamePattern', pattern] : [])], { cwd: root, env, timeout: 90000, maxBuffer: 8 * 1024 * 1024 }) }
    catch (error) { exitCode = error.code; output = error; if (!Number.isInteger(exitCode)) throw error }
    await writeFile(resolve(directory, 'command.log'), String(output.stdout) + String(output.stderr))
    const report = JSON.parse(await readFile(json)), tests = report.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === 'passed' || test.status === 'failed')
    assert.ok(tests.length > 0, 'Actually executed owning cases must be nonempty')
    const failures = tests.filter(test => test.status === 'failed')
    if (mutant === 'baseline') { assert.equal(exitCode, 0); assert.deepEqual(failures, []) }
    else {
      assert.notEqual(exitCode, 0); assert.equal(failures.length, 1)
      assert.ok(failures[0].fullName.includes(pattern), 'The loaded mutant fails its selected owning case')
      assert.ok(failures[0].failureMessages.some(message => /AssertionError/u.test(message)), 'Specific assertion RED, never setup failure')
    }
    const loaded = (await readFile(resolve(directory, 'loaded-source.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse)
    assert.ok(loaded.length > 0, 'Actual compiled product Source consumption is nonempty')
    if (mutant !== 'baseline') assert.ok(loaded.some(item => item.mutant === mutant && item.originalSHA256 !== item.consumedSHA256), 'The mutation changes actually compiled Source')
    for (const item of loaded) { await bind(item.path); assert.equal(inputs[item.path], item.originalSHA256, 'The loaded Source matches this candidate') }
    const result = { name, mutant, pattern: pattern ?? null, exitCode, passed: tests.length - failures.length, failed: failures.length, json: relative(root, json) }
    results.push(result); return result
  }
  try {
    for (const path of proofFiles) await bind(path)
    if (mode === '--ui-callers') {
      const require = createRequire(resolve(root, 'apps/desktop/package.json')), ts = require('typescript')
      const file = resolve(root, 'apps/desktop/scripts/fixtures/toolkit-custom-ui/tsconfig.owning.json')
      const config = ts.readConfigFile(file, ts.sys.readFile); assert.equal(config.error, undefined)
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(file))
      assert.equal(parsed.errors.length, 0)
      const program = ts.createProgram(parsed.fileNames, parsed.options), checker = program.getTypeChecker(), edges = []
      const jsxTargets = ['ToolkitStatusBar', 'SettingsPanel', 'ToolkitSettingsPane', 'ToolkitToolEditor', 'ToolkitPopover', 'UserToolkitResult', 'PerformancePanel']
      const calls = ['useToolkitDrafts', 'useToolkitScriptObservation', 'markWindowOverlayDismissal', 'wasWindowOverlayDismissed',
        'ToolkitDesktopApi.add', 'ToolkitDesktopApi.update', 'ToolkitDesktopApi.remove', 'ToolkitDesktopApi.get', 'ToolkitDesktopApi.run', 'ToolkitDesktopApi.stop', 'ToolkitDesktopApi.action', 'ToolkitDesktopApi.observe', 'openToolkit']
      function symbols(node) {
        let symbol = checker.getSymbolAtLocation(node)
        if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
        return symbol
      }
      function record(tree, node, symbol, name) {
        const caller = relative(root, tree.fileName)
        for (const declaration of symbol?.getDeclarations() ?? []) {
          const definition = relative(root, declaration.getSourceFile().fileName)
          if (definition !== caller && definition.startsWith('apps/desktop/src/')) edges.push({ caller, definition, symbol: name, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 })
        }
      }
      for (const tree of program.getSourceFiles()) {
        const path = relative(root, tree.fileName)
        if (!path.startsWith('apps/desktop/src/renderer/src/') || !/\.[jt]sx?$/u.test(path)) continue
        await bind(path)
        const visit = node => {
          if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
            const symbol = symbols(node.tagName)
            if (symbol && jsxTargets.includes(symbol.name)) record(tree, node, symbol, 'JSX ' + symbol.name)
          }
          if (ts.isCallExpression(node)) {
            const symbol = symbols(ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression)
            for (const declaration of symbol?.getDeclarations() ?? []) {
              const parent = declaration.parent, name = ts.isInterfaceDeclaration(parent) && parent.name ? parent.name.text + '.' + symbol.name : symbol.name
              if (calls.includes(name)) record(tree, node, symbol, name)
            }
          }
          if (ts.isArrayLiteralExpression(node)) for (const element of node.elements) {
            const symbol = symbols(element)
            if (symbol?.name === 'toolkitSettingsModule') record(tree, node, symbol, 'registered toolkitSettingsModule')
          }
          ts.forEachChild(node, visit)
        }
        visit(tree)
      }
      assert.ok(edges.length > 0, 'Actual external UI product call collection is nonempty')
      for (const target of [...jsxTargets.map(name => 'JSX ' + name), ...calls, 'registered toolkitSettingsModule']) assert.ok(edges.some(edge => edge.symbol === target), 'External product caller is nonempty: ' + target)
      for (const [caller, symbol] of [['App.tsx', 'JSX ToolkitStatusBar'], ['App.tsx', 'JSX SettingsPanel'], ['settings/modules/toolkit.tsx', 'JSX ToolkitSettingsPane'], ['toolkit/UserToolkitResult.tsx', 'ToolkitDesktopApi.action']]) {
        assert.ok(edges.some(edge => edge.caller.endsWith('/' + caller) && edge.symbol === symbol), 'Ordinary App/Settings/result connection is real: ' + caller)
      }
      await writeFile(resolve(evidence, 'callers.json'), JSON.stringify(edges, null, 2) + '\n'); results.push({ edges })
    } else if (mode === '--ui-mutations') {
      for (const [mutant, pattern] of [
        ['consumption', 'releases the old selected reader before subscribing the new one'],
        ['release', 'releases the old selected reader before subscribing the new one'],
        ['expectation', 'keeps same-field expectations and adopts an unauthored outside sibling'],
        ['focus', 'does not replace a focused result or its selection on hover'],
        ['action-target', 'shows only configured result actions and sends their captured revision'],
        ['pending-baseline', 'preserves the authored script baseline'],
        ['navigation-intent', 'returns to the same tool from library'],
        ['passive-escape', 'closes a passive hover without consuming the connected ordinary'],
        ['dismissal-marker', 'dismisses only the hover layer']
      ]) { await run(mutant, mutant, pattern); await run(mutant + '-restored', 'baseline', pattern) }
    } else {
      await run('owning'); await run('cost', 'baseline', undefined, true)
      // Native capture and independent image review are sealed once, then read without rebuilding.
      const packetPath = ".bagakit/design/toolkit-custom-ui-intake-fixture/qualification/current.json"
      const packet = JSON.parse(await bind(packetPath))
      assert.equal(packet.schema, 'agentmux.toolkit-custom-ui-qualification.v1')
      const readReceipt = async ref => { assert.ok(ref && typeof ref.path === 'string' && /^[a-f0-9]{64}$/u.test(ref.sha256)); const bytes = await bind(ref.path); assert.equal(sha(bytes), ref.sha256); return JSON.parse(bytes) }
      const native = await readReceipt(packet.native), raw = await readReceipt(packet.raw), visual = await readReceipt(packet.visual)
      assert.equal(native.completed, true); assert.equal(native.sourceCurrentReadbackExact, true)
      assert.ok(native.sdkClosure); assert.equal(native.sdkClosure.actualProtocol,native.sdkClosure.manifestProtocol)
      assert.equal(native.inputs[native.sdkClosure.archive].sha256,native.sdkClosure.archiveSHA256)
      assert.ok(native.compiled.some(item=>item.file===native.sdkClosure.entry&&item.sha256===native.sdkClosure.entrySHA256),'The executed private SDK entry belongs to this sealed compiled input')
      assert.deepEqual(native.changedAfterCapture, []); assert.deepEqual(native.remainingPrivateProcesses, []); assert.equal(native.privateRootRemoved, true)
      assert.ok(native.rawInputs?.length>0,'The actual capture raw input is nonempty')
      const nativeRaw=native.rawInputs.find(item=>item.phase==='toolkit')
      assert.ok(nativeRaw);assert.equal(nativeRaw.file,'toolkit-render.json');assert.equal(nativeRaw.sha256,packet.raw.sha256)
      assert.equal(resolve(root,packet.raw.path),resolve(dirname(resolve(root,packet.native.path)),nativeRaw.file),'Raw comes from this exact actual capture')
      assert.deepEqual(raw.frames,native.frames,'Raw and sealed complete-image collection are identical')
      assert.equal(raw.qualificationScope, 'toolkit-custom-ui'); assert.equal(raw.qualified, true)
      assert.equal(raw.desktop.settingsCliDurable, true); assert.equal(raw.desktop.capturedAction, true); assert.equal(raw.desktop.focusAndKeyboard, true)
      assert.equal(raw.desktop.originalWorkbenchExact, true); assert.equal(raw.desktop.singleModelCost, true)
      assert.equal(raw.geometry.length, 9, 'All actual width and appearance combinations are present')
      assert.equal(raw.monacoEscape.focusSame, true); assert.equal(raw.monacoEscape.inputConnected, true)
      assert.equal(raw.monacoEscape.settingsSame, true); assert.equal(raw.monacoEscape.settingsExpanded, 'true')
      assert.ok(raw.monacoEscape.keys.length > 0 && raw.monacoEscape.keys.some(event => event.key === 'Escape' && event.isTrusted && event.originalInputTarget), 'The original actual Monaco input received native Escape')
      assert.deepEqual(raw.triggerKeyboard.map(value => value.activation), ['Return', 'Space'], 'Both native keyboard activations exercised the real Toolkit trigger')
      assert.equal(raw.modelCost.inputs.unrelatedRunIds.length, 128); assert.equal(new Set(raw.modelCost.inputs.unrelatedRunIds).size, 128)
      assert.ok(raw.modelCost.inputs.unrelatedRunIds.every(id => id !== raw.terminalInput.control.runId), 'Cost subjects do not alias the original healthy Run')
      assert.equal(raw.stopRecovery.confirmed.state, 'succeeded'); assert.equal(raw.stopRecovery.confirmed.admission, null)
      assert.equal(raw.stopRecovery.confirmed.latestConfirmed.executionId, raw.stopRecovery.before.admission.executionId)
      assert.equal(raw.stopRecovery.stop.accepted, false); assert.ok(raw.stopRecovery.stop.error)
      assert.equal(raw.acceptedStop.confirmed.state, 'stopped'); assert.equal(raw.acceptedStop.confirmed.admission, null)
      assert.equal(raw.acceptedStop.confirmed.latestConfirmed.executionId, raw.acceptedStop.before.admission.executionId)
      assert.equal(raw.acceptedStop.stop.accepted, true)
      assert.equal(raw.restart.ordinaryGuiProcesses, 2); assert.equal(raw.restart.exactSurface, true); assert.equal(raw.restart.confirmedResultRetained, true)
      assert.equal(raw.restart.healthyRunSamePid, true); assert.equal(raw.restart.realInputAckReplay, true); assert.equal(raw.restart.actualTerminalAutomaticAttach, true)
      assert.equal(visual.sourceIdentity, native.sourceIdentity); assert.equal(visual.verdict, 'pass'); assert.deepEqual(visual.mustFix, [])
      assert.ok(native.frames.length > 0); assert.equal(visual.images.length, native.frames.length)
      for (const frame of native.frames) {
        const image = visual.images.find(image => image.file === frame.file)
        assert.ok(image && image.personallyViewedOriginal); assert.equal(image.sha256, frame.sha256)
        const bytes = await bind(relative(root, resolve(dirname(resolve(root, packet.native.path)), frame.file))); assert.equal(sha(bytes), frame.sha256)
      }
      assert.ok(Object.keys(native.inputs).length > 0); assert.ok(native.compiled.length > 0)
      for (const [path, identity] of Object.entries(native.inputs)) { await bind(path); assert.equal(inputs[path], identity.sha256, 'Current Source matches the sealed native candidate: ' + path) }
      for (const artifact of native.compiled) {
        const bytes = await bind(relative(root, resolve(dirname(resolve(root, packet.native.path)), artifact.file))); assert.equal(sha(bytes), artifact.sha256)
      }
      const backend = await Promise.all(packet.backend.map(readReceipt))
      assert.ok(backend.length > 0)
      for (const mode of ['--cli', '--cli-mutations', '--actions', '--action-mutations']) assert.ok(backend.some(receipt => receipt.schema === 'agentmux.toolkit-custom-proof.v1' && receipt.mode === mode && receipt.completed === true), 'Consume accepted real Backend qualification: ' + mode)
      results.push({ native: packet.native, visual: packet.visual, backend: packet.backend })
    }
    await unchanged(); receipt.completed = true
  } catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; throw error }
  finally { receipt.identity = sha(JSON.stringify(inputs)); await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify({ mode, completed: receipt.completed, evidence, identity: receipt.identity })) }
  return receipt
}
