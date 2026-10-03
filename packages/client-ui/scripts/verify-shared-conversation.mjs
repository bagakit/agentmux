import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, readdir, mkdtemp, cp, symlink, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const sourceRoot = resolve(root, 'packages/client-ui/src')
const evidenceRoot = resolve(root, '.tmp/agentmux-private-mobile-client/shared-ui')
const mutationAndCallers = process.argv.includes('--mutation-and-callers')
const log = []
const sha = source => createHash('sha256').update(source).digest('hex')
async function files(folder, pattern = /\.tsx?$/) {
  const result = []
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = resolve(folder, entry.name)
    if (entry.isDirectory()) result.push(...await files(path, pattern))
    else if (pattern.test(entry.name)) result.push(path)
  }
  return result
}
function run(args, expected = 'green') {
  const result = spawnSync('pnpm', args, { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  if (result.error) throw result.error
  const output = result.stdout + result.stderr
  log.push({ command: ['pnpm', ...args], status: result.status, expected, output })
  if (expected === 'green') assert.equal(result.status, 0, output)
  else {
    assert.notEqual(result.status, 0, 'Mutation survived: ' + args.join(' '))
    assert.match(output, /Tests\s+\d+ failed/, 'A real behaviour test must fail; infrastructure/empty collection is not mutation evidence\n' + output)
    assert.match(output, /AssertionError:/, 'Mutation must trigger a real assertion failure\n' + output)
  }
  return output
}
function parse(path, source) {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
}
function runtimeImports(sf) {
  return sf.statements.flatMap(statement => {
    if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) return []
    if (statement.isTypeOnly || statement.importClause?.isTypeOnly) return []
    const bindings = statement.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every(item => item.isTypeOnly)) return []
    return [statement.moduleSpecifier.text]
  })
}
async function checkDependencyBoundary() {
  const sources = await files(sourceRoot)
  assert.ok(sources.length > 20, 'The real shared source surface must exist')
  const known = new Set(sources)
  const graph = new Map()
  for (const path of sources) {
    const source = await readFile(path, 'utf8')
    const imports = runtimeImports(parse(path, source))
    graph.set(path, imports)
    for (const dependency of imports) {
      assert.ok(!dependency.startsWith('node:') && !['electron', 'zustand'].includes(dependency), `${relative(root, path)} imports host runtime ${dependency}`)
      assert.ok(!dependency.includes('desktop') && !dependency.includes('host'), `${relative(root, path)} imports a client implementation`)
      if (dependency === '@agentmux/core') assert.fail(`${relative(root, path)} loads the Node Core barrel at runtime; use type imports or browser-safe pure public leaves`)
      if (dependency.startsWith('.')) {
        const next = resolve(dirname(path), dependency).replace(/\.js$/, '.ts')
        assert.ok(known.has(next) || known.has(next + 'x'), `Shared relative import must remain inside this package: ${dependency}`)
      }
    }
  }
  const pure = []
  for (const leaf of ['pasted-images', 'terminal-path-link']) {
    const path = resolve(sourceRoot, 'lib', leaf + '.ts')
    assert.deepEqual(graph.get(path), [], `Node-consumed leaf ${leaf} must have no runtime imports`)
    pure.push({ module: '@agentmux/client-ui/' + leaf, source: relative(root, path), sha256: sha(await readFile(path)) })
  }
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const images = await import('@agentmux/client-ui/pasted-images');
    const paths = await import('@agentmux/client-ui/terminal-path-link');
    assert.deepEqual(images.PASTED_IMAGE_EXTENSIONS, ['png','jpg','jpeg','gif','webp']);
    assert.deepEqual(paths.detectTerminalPathLinks('src/main.ts:7', process.cwd()), [{ index:0,length:13,path:'src/main.ts',line:7 }]);
    assert.equal(typeof document, 'undefined');
    console.log('Compiled ESM pure leaf imports work in Node without a DOM');
  `], { cwd: resolve(root, 'apps/desktop'), encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr || child.stdout)
  const corePackage = JSON.parse(await readFile(resolve(root, 'packages/core/package.json'), 'utf8'))
  for (const dependency of Object.keys(corePackage.dependencies ?? {})) assert.ok(!/react|electron|client-ui/.test(dependency), 'Core must remain headless: ' + dependency)
  return { sourceCount: sources.length, nodeLeaves: pure, nodeOutput: child.stdout.trim() }
}
async function callers(candidateRoot = root) {
  const candidateSourceRoot = resolve(candidateRoot, 'packages/client-ui/src')
  const desktopSourceRoot = resolve(candidateRoot, 'apps/desktop/src/renderer/src')
  const all = [...await files(candidateSourceRoot), ...await files(desktopSourceRoot)]
  const symbols = ['ConversationMessage', 'ConversationView', 'AgentComposer', 'AgentInteractionCard', 'InlineComposer', 'ClientUiProvider']
  const result = {}
  for (const symbol of symbols) {
    const definition = symbol === 'ClientUiProvider' ? resolve(candidateSourceRoot, 'platform.tsx') : resolve(candidateSourceRoot, 'components', symbol + '.tsx')
    const hits = []
    for (const path of all) {
      if (path === definition) continue
      const source = await readFile(path, 'utf8')
      const sf = parse(path, source)
      function visit(node) {
        if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(sf) === symbol) {
          hits.push({ source: relative(candidateRoot, path), line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 })
        }
        ts.forEachChild(node, visit)
      }
      visit(sf)
    }
    assert.ok(hits.some(hit => hit.source.startsWith('apps/desktop/src/renderer/src/')), `${symbol} has no Desktop product invocation outside its defining file (shared-only invocations/imports/tests are not Desktop callers)`)
    result[symbol] = hits
  }
  return result
}
const tests = ['exec', 'vitest', 'run', '--config', 'packages/client-ui/vitest.config.ts']
await mkdir(evidenceRoot, { recursive: true })
try {
  run(['--filter', '@agentmux/client-ui', 'typecheck'])
  run(['--filter', '@agentmux/client-ui', 'build'])
  run(['exec', 'tsc', '--noEmit', '-p', 'apps/desktop/tsconfig.renderer.json'])
  run(tests)
  const boundary = await checkDependencyBoundary()
  const mutationResults = []
  let productCallers = {}
  if (mutationAndCallers) {
    const mutations = [
      { name: 'copy-port-disconnected', path: 'components/ConversationMessage.tsx', start: '    const accepted = await platform.copyText(text, () => {', end: '\n    if (activeCopyActionRef.current !== actionId)', replacement: '    const accepted = true', test: 'copy failure' },
      { name: 'permission-response-disconnected', path: 'components/AgentInteractionCard.tsx', needle: 'await onRespond(response)', replacement: 'await Promise.resolve()', test: 'original request option' },
      { name: 'composer-writeback-disconnected', path: 'components/AgentComposer.tsx', needle: 'onValueChange={onChange}', replacement: 'onValueChange={() => {}}', test: 'maintained editor controlled' }
    ]
    const originalSources = Object.fromEntries(await Promise.all((await files(sourceRoot)).map(async path => [relative(sourceRoot, path), sha(await readFile(path))])))
    const isolatedRoot = await mkdtemp(resolve(root, '.tmp/client-ui-mutations-'))
    try {
      const isolatedPackage = resolve(isolatedRoot, 'packages/client-ui')
      await mkdir(isolatedPackage, { recursive: true })
      for (const name of ['src', 'test', 'package.json', 'tsconfig.json', 'tsconfig.build.json', 'vitest.config.ts']) {
        await cp(resolve(root, 'packages/client-ui', name), resolve(isolatedPackage, name), { recursive: true })
      }
      await cp(resolve(root, 'tsconfig.base.json'), resolve(isolatedRoot, 'tsconfig.base.json'))
      await symlink(resolve(root, 'node_modules'), resolve(isolatedRoot, 'node_modules'), 'dir')
      // A concurrent Core build may replace dist. Freeze that existing compiled dependency;
      // all unrelated installed dependencies remain read-only links to the workspace.
      const core = resolve(root, 'packages/core')
      const compiled = await files(resolve(core, 'dist'), /\.(?:js|map)$/)
      assert.ok(compiled.length > 0, 'The compiled Core dependency snapshot must be nonempty')
      const compiledHashes = Object.fromEntries(await Promise.all(compiled.map(async path => [relative(core, path), sha(await readFile(path))])))
      const frozenCore = resolve(isolatedRoot, 'packages/core')
      await mkdir(frozenCore, { recursive: true })
      await cp(resolve(core, 'package.json'), resolve(frozenCore, 'package.json'))
      await cp(resolve(core, 'dist'), resolve(frozenCore, 'dist'), { recursive: true })
      for (const [path, digest] of Object.entries(compiledHashes)) {
        assert.equal(sha(await readFile(resolve(frozenCore, path))), digest, 'Compiled dependency changed during its snapshot')
      }
      await symlink(resolve(core, 'node_modules'), resolve(frozenCore, 'node_modules'), 'dir')
      const installed = resolve(root, 'packages/client-ui/node_modules')
      const isolatedModules = resolve(isolatedPackage, 'node_modules')
      await mkdir(isolatedModules, { recursive: true })
      for (const entry of await readdir(installed)) {
        if (entry !== '@agentmux') await symlink(resolve(installed, entry), resolve(isolatedModules, entry), 'dir')
      }
      await mkdir(resolve(isolatedModules, '@agentmux'))
      for (const entry of await readdir(resolve(installed, '@agentmux'))) {
        await symlink(entry === 'core' ? frozenCore : resolve(installed, '@agentmux', entry), resolve(isolatedModules, '@agentmux', entry), 'dir')
      }
      const isolatedConfig = resolve(isolatedPackage, 'vitest.config.ts')
      const isolatedTests = ['exec', 'vitest', 'run', '--config', isolatedConfig]
      for (const mutation of mutations) {
        const path = resolve(isolatedPackage, 'src', mutation.path)
        const original = await readFile(path, 'utf8')
        let changed
        if (mutation.needle) {
          assert.equal(original.split(mutation.needle).length, 2, `Mutation anchor must occur exactly once: ${mutation.name}`)
          changed = original.replace(mutation.needle, mutation.replacement)
        } else {
          const start = original.indexOf(mutation.start), end = original.indexOf(mutation.end, start)
          assert.ok(start >= 0 && end > start, `Whole mutation block must exist: ${mutation.name}`)
          changed = original.slice(0, start) + mutation.replacement + original.slice(end)
        }
        await writeFile(path, changed)
        run([...isolatedTests, '--testNamePattern', mutation.test], 'red')
        await writeFile(path, original)
        run([...isolatedTests, '--testNamePattern', mutation.test])
        mutationResults.push({ name: mutation.name, changedSource: mutation.path, isolatedCandidate: true, red: true, assertionError: true, restoredGreen: true, restoredSha256: sha(original) })
      }
      await cp(resolve(root, 'apps/desktop/src/renderer/src'), resolve(isolatedRoot, 'apps/desktop/src/renderer/src'), { recursive: true })
      await callers(isolatedRoot)
      // Removing every Desktop consuming block leaves the import/definition/shared package present.
      // It must still fail the zero-caller check: an isolated library is not the Desktop capability.
      for (const path of await files(resolve(isolatedRoot, 'apps/desktop/src/renderer/src'))) {
        const source = await readFile(path, 'utf8')
        if (/<AgentComposer(?:\s|>)/u.test(source)) await writeFile(path, '')
      }
      await assert.rejects(() => callers(isolatedRoot), error => error.name === 'AssertionError' && error.message.includes('AgentComposer has no Desktop product invocation'))
      mutationResults.push({ name: 'all-desktop-composer-consumers-removed', isolatedCandidate: true, red: true, assertionError: true, sharedDefinitionKept: true })
    } finally { await rm(isolatedRoot, { recursive: true, force: true }) }
    const sourcesAfter = Object.fromEntries(await Promise.all((await files(sourceRoot)).map(async path => [relative(sourceRoot, path), sha(await readFile(path))])))
    assert.deepEqual(sourcesAfter, originalSources, 'Current package source must remain byte-identical; the verifier never writes the live candidate')

    productCallers = await callers()
  }
  const proof = { schema: 'agentmux.shared-conversation-verification.v1', passed: true, scope: 'T009 shared UI consumed by Desktop; no mobile authentication/native-device claim', boundary, mutations: mutationResults, productCallers, commands: log }
  await writeFile(resolve(evidenceRoot, 'verification.json'), JSON.stringify(proof, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, tests: 5, mutations: mutationResults.length, callerSymbols: Object.keys(productCallers).length, evidence: relative(root, resolve(evidenceRoot, 'verification.json')) }))
} catch (error) {
  await writeFile(resolve(evidenceRoot, 'failed-verification.json'), JSON.stringify({ passed: false, error: String(error), commands: log }, null, 2) + '\n')
  throw error
}
