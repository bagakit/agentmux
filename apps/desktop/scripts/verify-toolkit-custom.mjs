import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), mode = process.argv[2]
assert.ok(['--cli', '--cli-mutations', '--cli-callers', '--actions', '--action-mutations', '--action-callers'].includes(mode), 'Choose an implemented custom Toolkit verification mode; UI has a separate owning Task.')
const actions = mode.startsWith('--action')
const base = resolve(root, '.bagakit/design/toolkit-custom-20261005/evidence'); await mkdir(base, { recursive: true })
const evidence = await mkdtemp(resolve(base, 'run-')), sha = bytes => createHash('sha256').update(bytes).digest('hex')
const ownSources = ['packages/core/src/toolkit.ts', 'packages/core/src/toolkit-control.ts', 'packages/core/src/toolkit-control-server.ts', 'packages/core/src/control.ts',
  'packages/core/src/control-host.ts', 'packages/core/src/agentmux.ts', 'packages/core/src/toolkit-cli.ts', 'packages/core/src/cli-json-input.ts',
  'packages/core/src/agentmux-cli-help.ts', 'packages/core/src/runtime-paths.ts',
  'packages/core/src/client.ts', 'packages/core/src/ctxmux-run-adapter.ts',
  'apps/desktop/src/main/toolkit-owner.ts', 'apps/desktop/src/main/toolkit-custom-owner.ts', 'apps/desktop/src/main/toolkit-config.ts',
  'apps/desktop/src/main/toolkit-receipt-store.ts', 'apps/desktop/src/main/toolkit-ipc.ts', 'apps/desktop/src/main/toolkit-run-port.ts', 'apps/desktop/src/main/toolkit-asset.ts',
  'apps/desktop/src/main/config-store.ts', 'apps/desktop/src/main/config-owner.ts', 'apps/desktop/src/main/runtime-controller.ts',
  'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/shared/toolkit.ts', 'apps/desktop/src/shared/toolkit-preferences.ts',
  'apps/desktop/src/shared/config-edit.ts', 'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/preload/index.ts', 'apps/desktop/src/renderer/src/lib/api.ts',
  'apps/desktop/src/renderer/src/lib/use-performance-observation.ts']
if (mode === '--action-callers') ownSources.push('apps/desktop/src/renderer/src/App.tsx',
  'apps/desktop/src/renderer/src/components/toolkit/ToolkitStatusBar.tsx',
  'apps/desktop/src/renderer/src/components/toolkit/UserToolkitResult.tsx')
const proofPaths = ['apps/desktop/test/toolkit-custom-owner.test.ts', 'apps/desktop/test/toolkit-custom-main.test.ts', 'apps/desktop/test/toolkit-owner.test.ts',
  'apps/desktop/test/toolkit-main.fixture.ts', 'apps/desktop/test/toolkit-receipt-store.test.ts', 'apps/desktop/scripts/fixtures/toolkit-custom/vitest.config.mts',
  'apps/desktop/scripts/fixtures/toolkit-custom/tsconfig.owning.json', 'apps/desktop/scripts/verify-toolkit-custom.mjs', 'vitest.setup.ts']
if (actions) proofPaths.push('apps/desktop/test/toolkit-actions-main.test.ts')
const manifestPath = 'packages/core/vendor/ctxmux/' + process.platform + '-' + process.arch + '/manifest.json'
const inputs = {}
for (const path of [...ownSources, ...proofPaths, manifestPath]) {
  const bytes = await readFile(resolve(root, path)); assert.ok(bytes.length > 0, 'Owning input must be nonempty: ' + path)
  inputs[path] = sha(bytes); const target = resolve(evidence, 'inputs', path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes)
}
const results = [], exec = promisify(execFile), identity = sha(JSON.stringify(inputs))
async function unchanged() { for (const [path, digest] of Object.entries(inputs)) assert.equal(sha(await readFile(resolve(root, path))), digest, 'Owning proof input changed: ' + path) }
try {
  if (mode === '--cli-callers' || mode === '--action-callers') {
    const require = createRequire(resolve(root, 'apps/desktop/package.json')), ts = require('typescript')
    const configFile = resolve(root, 'apps/desktop/scripts/fixtures/toolkit-custom/tsconfig.owning.json')
    const config = ts.readConfigFile(configFile, ts.sys.readFile)
    assert.equal(config.error, undefined)
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configFile))
    const program = ts.createProgram([...new Set([...parsed.fileNames, ...ownSources.map(path => resolve(root, path))])], parsed.options)
    const checker = program.getTypeChecker(), edges = [], channels = new Map(), channelCalls = []
    const targets = new Set(['parseToolkitCommand', 'serveToolkitControl', 'ToolkitOwner', 'CustomToolkitOwner',
      'executeToolkitConfig', 'prepareToolkitConfig', 'ConfigOwner.inspect', 'ToolkitOwner.prepareConfig',
      'AgentMuxClient.createTerminal', 'AgentMuxClient.readRunReplay', 'AgentMuxClient.releaseRunAttachment', 'AgentMuxClient.removeTerminal',
      'CustomToolkitOwner.dispose', 'ToolkitRunPort.remove'])
    if (actions) for (const name of ['parseToolkitActionInput', 'CustomToolkitOwner.action', 'ToolkitDesktopApi.action']) targets.add(name)
    for (const path of ownSources) {
      const tree = program.getSourceFile(resolve(root, path)); assert.ok(tree && tree.text.length > 0)
      const visit = node => {
        if (actions && (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))) {
          let symbol = checker.getSymbolAtLocation(node.tagName)
          if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
          if (symbol && ['ToolkitStatusBar', 'UserToolkitResult'].includes(symbol.name)) {
            for (const declaration of symbol.getDeclarations() ?? []) {
              const definition = relative(root, declaration.getSourceFile().fileName)
              if (definition !== path && !/test|fixture/u.test(path)) edges.push({ caller: path, definition,
                symbol: 'JSX ' + symbol.name, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 })
            }
          }
        }
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          const expression = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression
          let symbol = checker.getSymbolAtLocation(expression)
          if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
          for (const declaration of symbol?.getDeclarations() ?? []) {
            const parent = declaration.parent
            const name = (ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent)) && parent.name
              ? parent.name.text + '.' + symbol.name : symbol.name
            const definition = relative(root, declaration.getSourceFile().fileName)
            if (targets.has(name) && definition !== path && !/test|fixture/u.test(path)) {
              edges.push({ caller: path, definition, symbol: name, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 })
            }
          }
          const argument = node.arguments?.[0]
          if (ts.isCallExpression(node) && argument && ts.isStringLiteral(argument) && argument.text.startsWith('toolkit:')) {
            if (symbol?.name === 'handle') channels.set(argument.text, path)
            else channelCalls.push({ caller: path, symbol: 'IPC ' + argument.text, channel: argument.text,
              line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 })
          }
          if (ts.isNewExpression(node) && symbol?.name === 'AgentMuxControlServer' && argument && ts.isObjectLiteralExpression(argument)) {
            for (const property of argument.properties) {
              if (!property.name || property.name.getText(tree) !== 'toolkit') continue
              const value = ts.isShorthandPropertyAssignment(property) ? property.name : ts.isPropertyAssignment(property) ? property.initializer : null
              if (value && checker.getTypeAtLocation(value).getSymbol()?.name === 'ToolkitOwner') {
                const definition=relative(root,symbol.getDeclarations()[0].getSourceFile().fileName)
                assert.notEqual(definition,path)
                edges.push({ caller: path, definition, symbol: 'registered Toolkit port', line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 })
              }
            }
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(tree)
    }
    assert.ok(channels.size > 0, 'Actual registered Toolkit channels must be nonempty')
    for (const call of channelCalls) {
      const definition = channels.get(call.channel)
      if (definition && definition !== call.caller) edges.push({ ...call, definition })
    }
    assert.ok(edges.length > 0)
    for (const symbol of [...targets, 'registered Toolkit port', actions ? 'IPC toolkit:action' : 'IPC toolkit:run']) {
      assert.ok(edges.some(edge => edge.symbol === symbol), 'External product call must be nonempty: ' + symbol)
    }
    if (actions) assert.ok(edges.some(edge => edge.symbol === 'ToolkitDesktopApi.action' &&
      edge.caller === 'apps/desktop/src/renderer/src/components/toolkit/UserToolkitResult.tsx'), 'The real result button must call the public action bridge')
    if (actions) for (const [caller, symbol] of [
      ['apps/desktop/src/renderer/src/App.tsx', 'JSX ToolkitStatusBar'],
      ['apps/desktop/src/renderer/src/components/toolkit/ToolkitStatusBar.tsx', 'JSX UserToolkitResult']
    ]) assert.ok(edges.some(edge => edge.caller === caller && edge.symbol === symbol), 'The real App result consumer must be nonempty: ' + symbol)
    await writeFile(resolve(evidence, 'callers.json'), JSON.stringify(edges, null, 2) + '\n'); results.push({ edges })
  } else {
    const require = createRequire(resolve(root, 'packages/core/package.json')), { build } = require('esbuild')
    const cliDirectory = resolve(evidence, 'cli'), cli = resolve(cliDirectory, 'agentmux.mjs'); await mkdir(cliDirectory)
    await symlink(resolve(root, 'packages/core/node_modules'), resolve(cliDirectory, 'node_modules'), 'dir')
    const loaded = []
    await build({ entryPoints: [resolve(root, 'packages/core/src/agentmux.ts')], outfile: cli, bundle: true,
      platform: 'node', format: 'esm', target: 'node24', packages: 'external', plugins: [{ name: 'toolkit-custom-current-source', setup(builder) {
        builder.onLoad({ filter: /\.(ts|json)$/ }, async args => {
          if (!args.path.startsWith(root + '/packages/')) return
          const bytes = await readFile(args.path), path = relative(root, args.path)
          loaded.push({ path, originalSHA256: sha(bytes), consumedSHA256: sha(bytes), bytes: bytes.length })
          return { contents: bytes.toString(), loader: args.path.endsWith('.json') ? 'json' : 'ts' }
        })
      } }] })
    assert.ok(loaded.length > 0); await writeFile(resolve(cliDirectory, 'loaded-source.json'), JSON.stringify(loaded, null, 2))
    async function run(name, mutant, pattern) {
      const directory = resolve(evidence, name); await mkdir(directory)
      const json = resolve(directory, 'results.json')
      const files = actions ? ['apps/desktop/test/toolkit-actions-main.test.ts', 'apps/desktop/test/toolkit-custom-owner.test.ts']
        : ['apps/desktop/test/toolkit-custom-main.test.ts', 'apps/desktop/test/toolkit-custom-owner.test.ts',
          'apps/desktop/test/toolkit-receipt-store.test.ts', 'apps/desktop/test/toolkit-owner.test.ts']
      const args = ['node_modules/vitest/vitest.mjs', 'run', ...files, '--config', 'apps/desktop/scripts/fixtures/toolkit-custom/vitest.config.mts',
        '--reporter', 'json', '--outputFile', json, ...(pattern ? ['--testNamePattern', pattern] : [])]
      let output, code = 0
      try { output = await exec(process.execPath, args, { cwd: root, env: { ...process.env, AGENTMUX_TOOLKIT_CLI: cli,
        AGENTMUX_TOOLKIT_EVIDENCE: directory, AGENTMUX_TOOLKIT_MUTANT: mutant }, timeout: 150000, maxBuffer: 8 * 1024 * 1024 }) }
      catch (error) { code = error.code; output = error; if (!Number.isInteger(code)) throw error }
      await writeFile(resolve(directory, 'command.log'), String(output.stdout) + String(output.stderr))
      const report = JSON.parse(await readFile(json)), cases = report.testResults.flatMap(suite => suite.assertionResults)
      const executed = cases.filter(test => test.status === 'passed' || test.status === 'failed')
      assert.ok(executed.length > 0, 'Owning collection must be nonempty')
      if (mutant === 'baseline') { assert.equal(code, 0); assert.ok(executed.every(test => test.status === 'passed')) }
      else {
        assert.notEqual(code, 0)
        const failures = executed.filter(test => test.status === 'failed')
        assert.equal(failures.length, 1); assert.ok(failures[0].failureMessages.some(text => /AssertionError/u.test(text)), 'Loaded mutant must fail a concrete assertion, never setup')
        assert.ok(failures[0].fullName.includes(pattern), 'Mutant failed its selected owning case')
        const source = (await readFile(resolve(directory, 'loaded-source.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse)
        assert.ok(source.some(value => value.mutant === mutant && value.originalSHA256 !== value.consumedSHA256), 'Mutation must alter actually loaded product Source')
      }
      if (executed.some(test => /^registered Main (?:custom Toolkit actual CLI vertical|saved Toolkit action actual CLI)/u.test(test.fullName))) {
        const starts=(await readFile(resolve(directory,'fixture-startup.jsonl'),'utf8')).split('\n').filter(Boolean).map(JSON.parse).filter(record=>record.phase==='registered')
        const manifest=JSON.parse(await readFile(resolve(evidence,'inputs',manifestPath),'utf8'))
        assert.ok(starts.length>0,'Actual private Native identity must be nonempty')
        for(const start of starts) {
          assert.equal(start.protocol,manifest.product.protocol)
          assert.equal(start.runtimeIdentity.protocolGeneration,manifest.product.protocol)
          assert.equal(start.daemon.sha256,manifest.binaries.find(binary=>binary.name==='ctxmuxd').sha256)
          assert.ok(start.runner.sha256.length===64)
        }
        const cleanup=(await readFile(resolve(directory,'fixture-cleanup-summary.jsonl'),'utf8')).split('\n').filter(Boolean).map(JSON.parse)
        assert.ok(cleanup.length>0,'Private Native cleanup identity must be nonempty')
        const daemons=cleanup.filter(record=>record.allEnded!==undefined)
        assert.equal(daemons.length,starts.length)
        assert.ok(daemons.every(record=>record.allEnded===true))
        const inventories=cleanup.filter(record=>record.remainingRuns!==undefined)
        assert.equal(inventories.length,starts.length)
        for(const inventory of inventories)assert.deepEqual(inventory.remainingRuns,[],'Exact private cleanup must leave no Run')
      }
      results.push({ name, mutant, exitCode: code, executed: executed.length, jsonSHA256: sha(await readFile(json)) })
      console.log(name + ': ' + executed.length + ' owning, exit ' + code)
    }
    if (mode === '--cli' || mode === '--actions') {
      const output = await exec(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'apps/desktop/scripts/fixtures/toolkit-custom/tsconfig.owning.json', '--pretty', 'false'], { cwd: root, timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
      await writeFile(resolve(evidence, 'types.log'), output.stdout + output.stderr)
      // Debug selectors are recorded as partial qualification; formal gate always executes the whole bounded set.
      const filter = process.env.AGENTMUX_TOOLKIT_CUSTOM_DEBUG_FILTER
      await run(filter ? 'partial-debug' : 'baseline', 'baseline', filter ?? (actions ? 'registered Main saved Toolkit action actual CLI|saved Toolkit actions' : undefined))
      assert.ok(!filter, 'Partial debug must never qualify the formal CLI gate')
    } else {
      const mutants = actions ? [
        ['action-binding', 'actual action source and captured configuration target conflicts'],
        ['action-output', 'actual result text cannot create an action program'],
        ['action-repeat', 'actual repeated unknown action preserves its exact admission']
      ] : [
        ['expected', 'actual CLI expected conflict preserves the durable configuration'],
        ['execution', 'actual compiled CLI creates a configured local script'],
        ['completion', 'refuses guessed completion when authoritative terminal byte barrier'],
        ['cleanup', 'ten actual manual runs retire exact metadata']
      ]
      for (const [mutant, pattern] of mutants) { await run(mutant, mutant, pattern); await run(mutant + '-restored', 'baseline', pattern) }
    }
  }
  await unchanged()
  await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify({ schema: 'agentmux.toolkit-custom-proof.v1', mode, completed: true, identity, inputs, results }, null, 2) + '\n')
  console.log(relative(root, evidence))
} catch (error) {
  await writeFile(resolve(evidence, 'failure.json'), JSON.stringify({ mode, identity, results, error: String(error), stack: error.stack }, null, 2) + '\n')
  console.error(relative(root, evidence)); throw error
}
