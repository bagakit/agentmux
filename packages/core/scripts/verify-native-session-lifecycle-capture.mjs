import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const test = 'packages/core/test/native-session-lifecycle-capture.test.ts'
const clientPath = 'packages/core/src/client.ts'
const capturePath = 'packages/core/src/agent-native-session-capture.ts'
const sha = value => createHash('sha256').update(value).digest('hex')
const patches = {
  'create-omitted': { path: clientPath, needle: 'this.hookBindings.set(run.runId, hookBinding)\n      this.runPids.set(run.runId, run.pid)\n      this.queueNativeIdentityCapture(readySession, input)',
    replacement: 'this.hookBindings.set(run.runId, hookBinding)\n      this.runPids.set(run.runId, run.pid)' , test: 'public create persists' },
  'reconnect-omitted': { path: clientPath,
    needle: "if (runs.some(run => run.runId === session.run.runId && run.state.type === 'running')) {\n          this.queueNativeIdentityCapture(session)",
    replacement: "if (runs.some(run => run.runId === session.run.runId && run.state.type === 'running')) {\n          void session",
    test: 'public healthy reconnect' },
  'resume-uncertainty-rollback': { path: clientPath,
    needle: 'catch (error) { persisted = this.retainUnconfirmedLifecycle(error, next); readySession = persisted }',
    replacement: 'catch (error) { throw error }', test: 'public native resume keeps' },
  'persistence-omitted': { path: capturePath,
    needle: `return await registry.update(expected.agentSessionId, expected.run, value => {
    assertSession(value)
    if (value.nativeHandle && !sameHandle(value.nativeHandle, handle)) {
      throw changed('Native identity capture cannot overwrite a concurrent Hook identity.')
    }
    return { ...value, nativeHandle: { ...handle }, updatedAt: Math.max(value.updatedAt, Date.now()) }
  }, signal)`, replacement: 'return { ...current, nativeHandle: { ...handle } }', test: 'public create persists' }
}

// Load the ordinary repository config unchanged. A Vite transform mutates only the loaded
// production module, so concurrent collaborators' files, index and built artifacts stay intact.
if (process.argv[2] === '--worker') {
  const { startVitest, parseCLI } = await import('vitest/node')
  const name = process.argv[3], receipt = process.argv[4]
  const patch = patches[name]
  assert(patch && receipt, 'An explicit mutation and loaded receipt are required')
  const { filter, options } = parseCLI(['vitest', 'run', test, '--config', './vitest.config.ts', '--root', '.', '--maxWorkers', '1', '-t', patch.test])
  options.config = './vitest.config.ts'
  options.root = '.'
  const context = await startVitest('test', filter, options, { plugins: [{
    name: 'native-lifecycle-loaded-mutation', enforce: 'pre',
    transform(source, id) {
      if (id.split('?')[0] !== join(root, patch.path)) return
      assert.equal(source.split(patch.needle).length, 2, 'Mutation must match one production owner')
      const code = source.replace(patch.needle, patch.replacement)
      appendFileSync(receipt, JSON.stringify({ name, path: patch.path, sourceSha: sha(source), loadedSha: sha(code), replacements: 1 }) + '\n')
      return { code, map: null }
    }
  }] })
  assert(context, 'The ordinary config must initialize')
  assert(context.state.getFiles().length > 0, 'Mutation must execute nonempty tests')
  await context.close()
} else {
  const output = join(root, '.tmp/native-session-lifecycle-capture')
  await mkdir(output, { recursive: true })
  const paths = [clientPath, capturePath, test, 'packages/core/scripts/verify-native-session-lifecycle-capture.mjs']
  const bind = async () => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(join(root, path)))])))
  const inputs = ['packages/core/src/agent-session-store.ts', 'packages/core/src/agent-session-registry.ts', 'packages/core/src/durable-write.ts']
  const bindInputs = async () => Object.fromEntries(await Promise.all(inputs.map(async path => [path, sha(await readFile(join(root, path)))])))
  const sourceBefore = await bind(), inputPins = await bindInputs(), runs = [], mutations = []
  async function run(name, args) {
    const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    child.stdout.on('data', data => { text += data }); child.stderr.on('data', data => { text += data })
    const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
    await writeFile(join(output, `${name}.log`), text)
    const result = { name, exitCode, args, log: relative(root, join(output, `${name}.log`)), outputSha: sha(text) }
    runs.push(result)
    return { ...result, text }
  }
  function calls(source, path, names) {
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
    const result = []
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text
          : ts.isIdentifier(node.expression) ? node.expression.text : ''
        if (names.includes(name)) {
          let owner = node.parent
          while (owner && !ts.isMethodDeclaration(owner) && !ts.isFunctionDeclaration(owner)) owner = owner.parent
          result.push({ path, name, owner: owner?.name?.getText(file) ?? 'module', line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1 })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
    return result
  }
  try {
    for (const name of Object.keys(patches)) {
      const receipt = join(output, `${name}.loaded.jsonl`)
      await writeFile(receipt, '')
      const red = await run(name, [relative(root, fileURLToPath(import.meta.url)), '--worker', name, receipt])
      const loaded = (await readFile(receipt, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      assert.equal(loaded.length, 1, 'One production module must be transformed and loaded')
      assert.equal(loaded[0].sourceSha, sourceBefore[patches[name].path])
      assert.notEqual(loaded[0].sourceSha, loaded[0].loadedSha)
      assert.notEqual(red.exitCode, 0, 'Loaded mutation must fail')
      assert.match(red.text, /AssertionError:/)
      assert.doesNotMatch(red.text, /No test files found|Failed to load|Error during transform/)
      assert.deepEqual(await bind(), sourceBefore, 'Source must remain byte-exact')
      mutations.push({ name, assertionRed: true, loaded: loaded[0] })
    }
    const restored = await run('restored-green', ['node_modules/vitest/vitest.mjs', 'run', test,
      'packages/core/test/native-hook-session-scope.test.ts', '--maxWorkers', '1', '--config', './vitest.config.ts', '--root', '.'])
    assert.equal(restored.exitCode, 0, restored.text)
    assert.match(restored.text, /Tests\s+22 passed \(22\)/)
    const client = await readFile(join(root, clientPath), 'utf8')
    const lifecycle = calls(client, clientPath, ['queueNativeIdentityCapture'])
    assert.deepEqual(new Set(lifecycle.map(call => call.owner)), new Set(['open', 'refreshAgentSession', 'createAgentWithDelivery', 'resumeAgentRun']))
    const capture = calls(client, clientPath, ['captureAgentNativeSessionIdentity'])
    assert.equal(capture.length, 1, 'The helper must have a production caller outside its definition')
    const external = []
    for (const path of ['packages/core/src/public-rpc-service.ts', 'apps/desktop/src/main/runtime-controller.ts']) {
      external.push(...calls(await readFile(join(root, path), 'utf8'), path,
        ['createAgent', 'createAgentWithDelivery', 'refreshAgentSession', 'connect']))
    }
    assert(external.length > 0 && external.some(call => call.name.startsWith('createAgent')) &&
      external.some(call => call.name === 'refreshAgentSession'), 'Public lifecycle consumers must be nonempty')
    const sourceAfter = await bind()
    assert.deepEqual(sourceAfter, sourceBefore)
    assert.deepEqual(await bindInputs(), inputPins, 'Durability inputs must match this actual qualification')
    const receipt = { schema: 'agentmux.native-session-lifecycle-proof.v1', sourceBefore, sourceAfter, inputPins,
      mutations, restoredGreen: true, tests: 22, lifecycle, definitionExternalProductionCallers: [...capture, ...external], runs,
      scope: 'Private real process/open native artifacts and public Core lifecycle; no user Run or GUI actions.' }
    await writeFile(join(output, 'qualification.json'), JSON.stringify(receipt, null, 2) + '\n')
    process.stdout.write(relative(root, join(output, 'qualification.json')) + '\n')
  } catch (error) {
    await writeFile(join(output, 'failure.json'), JSON.stringify({ error: String(error.stack), sourceBefore, sourceAfter: await bind(), runs }, null, 2) + '\n')
    throw error
  }
}
