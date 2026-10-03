import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '../../..')
const parser = 'packages/client-ui/src/lib/agent-markdown.ts'
const renderer = 'packages/client-ui/src/components/AgentMarkdown.tsx'
const style = 'packages/client-ui/src/styles/markdown.css'
const config = 'packages/client-ui/test/markdown-quality.config.mts'
const tests = 'packages/client-ui/test/markdown-semantics.test.tsx'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const originals = Object.fromEntries(await Promise.all([parser, renderer, style].map(async path => [path, await readFile(join(root, path))])))
const hashes = Object.fromEntries(Object.entries(originals).map(([path, bytes]) => [path, hash(bytes)]))

async function sourceFiles(directory) {
  const entries = await readdir(join(root, directory), { withFileTypes: true })
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? sourceFiles(join(directory, entry.name))
    : /\.tsx?$/.test(entry.name) ? [join(directory, entry.name)] : []))).flat()
}
const files = [...await sourceFiles('packages/client-ui/src'), ...await sourceFiles('apps/desktop/src/renderer/src')]
assert.ok(files.length > 0, 'Production source scan must be nonempty')
const callers = { parser: [], renderer: [], document: [], workspaceImage: [] }
for (const path of files) {
  const source = await readFile(join(root, path), 'utf8')
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const names = new Set(['AgentMarkdown'])
  // Conversation memoizes the same shared renderer; record its real JSX use, not just an import.
  for (const statement of tree.statements) if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer && ts.isCallExpression(declaration.initializer)
          && declaration.initializer.arguments.some(argument => ts.isIdentifier(argument) && argument.text === 'AgentMarkdown')) names.add(declaration.name.text)
    }
  }
  function inspect(node) {
    if (path !== parser && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'parseAgentMarkdown') callers.parser.push(path)
    if (path !== renderer && (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isIdentifier(node.tagName) && names.has(node.tagName.text)) {
      callers.renderer.push(path)
      const attributes = node.attributes.properties.filter(ts.isJsxAttribute).map(attribute => attribute.name.text)
      if (attributes.includes('documentMode')) callers.document.push(path)
      if (attributes.includes('renderWorkspaceImage')) callers.workspaceImage.push(path)
    }
    ts.forEachChild(node, inspect)
  }
  inspect(tree)
}
for (const key of Object.keys(callers)) callers[key] = [...new Set(callers[key])]
assert.ok(callers.parser.length > 0, 'Parser needs a caller outside its definition')
assert.ok(callers.renderer.length >= 2, 'Document and conversation must consume the shared renderer')
assert.ok(callers.document.length > 0, 'Document mode needs an actual file consumer')
assert.ok(callers.workspaceImage.length > 0, 'Workspace image IO seam needs a real Host consumer')

await mkdir(join(root, '.tmp'), { recursive: true })
const proof = await mkdtemp(join(root, '.tmp/file-markdown-quality-'))
const snapshot = join(proof, 'source')
await cp(join(root, 'packages/client-ui/src'), join(snapshot, 'packages/client-ui/src'), { recursive: true })
for (const path of ['package.json', 'packages/client-ui/package.json', config, tests]) {
  await mkdir(join(snapshot, path, '..'), { recursive: true })
  await cp(join(root, path), join(snapshot, path))
}
await symlink(join(root, 'node_modules'), join(snapshot, 'node_modules'), 'dir')
await symlink(join(root, 'packages/client-ui/node_modules'), join(snapshot, 'packages/client-ui/node_modules'), 'dir')
const mutations = [
  { mode: 'ordered-start', path: parser, from: '{ start: node.start }', to: '{ start: 1 }' },
  { mode: 'lost-task-state', path: parser, from: 'item.checked ?? null', to: 'item.checked === null || item.checked === undefined ? null : false' },
  { mode: 'lost-reference-destination', path: parser, from: "href: definition.url, children: inlineFrom(node.children, context)", to: "href: 'https://example.com/wrong', children: inlineFrom(node.children, context)" },
  { mode: 'lost-hard-break', path: parser, from: "out.push({ kind: 'break' })", to: "out.push({ kind: 'text', text: '\\n' })" },
  { mode: 'lost-footnote-occurrence', path: parser, from: 'occurrence: reference.count', to: 'occurrence: 1' },
  { mode: 'document-heuristic', path: renderer, from: 'if (!documentMode && !looksLikeMarkdown(content))', to: 'if (!looksLikeMarkdown(content))' },
  { mode: 'missing-workspace-image', path: renderer, from: 'if (file && context.documentMode && context.renderWorkspaceImage)', to: 'if (file && !context.documentMode && context.renderWorkspaceImage)' },
  { mode: 'nested-linked-image-action', path: renderer, from: 'context.renderWorkspaceImage(file.path, node.alt, true)', to: 'context.renderWorkspaceImage(file.path, node.alt, false)' },
  { mode: 'global-anchor-navigation', path: renderer, from: "const root = source.closest('[data-markdown-root]')", to: 'const root = source.ownerDocument' }
]
const receipt = { sourceHashes: hashes, scannedFiles: files.length, callers, proof, phases: [] }
async function run(mode, changed) {
  const output = join(proof, `${mode}.json`), loadedLog = join(proof, `${mode}.loaded.jsonl`), logs = []
  const exitCode = await new Promise((done, reject) => {
    const child = spawn(join(root, 'node_modules/.bin/vitest'), ['run', '--config', join(snapshot, config), '--reporter=json', '--outputFile=' + output],
      { cwd: snapshot, env: { ...process.env, AGENTMUX_MARKDOWN_LOADED_LOG: loadedLog } })
    child.stdout.on('data', data => logs.push(data)); child.stderr.on('data', data => logs.push(data))
    child.on('error', reject); child.on('exit', done)
  })
  await writeFile(join(proof, `${mode}.log`), Buffer.concat(logs))
  const result = JSON.parse(await readFile(output, 'utf8'))
  const loaded = (await readFile(loadedLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  for (const path of [parser, renderer]) {
    const actual = loaded.filter(item => item.path === path)
    assert.ok(actual.length > 0, `Owning tests must load actual ${path}`)
    const expected = changed?.path === path ? hash(changed.bytes) : hashes[path]
    for (const item of actual) assert.equal(item.loadedSHA256, expected, 'Loaded source must match candidate or exact isolated mutant')
  }
  const failures = result.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'failed')
  receipt.phases.push({ mode, exitCode, passed: result.numPassedTests, failed: result.numFailedTests, loaded,
    ...(changed ? { mutation: { path: changed.path, sourceSHA256: hashes[changed.path], mutantSHA256: hash(changed.bytes) } } : {}),
    assertions: failures.map(test => ({ name: test.fullName, messages: test.failureMessages })) })
  if (changed) {
    assert.notEqual(exitCode, 0, 'Actual implementation mutation must fail')
    assert.ok(failures.some(test => test.failureMessages.some(message => message.includes('AssertionError'))), 'Mutant must reach a behavior assertion, not fail compilation')
  } else {
    assert.equal(exitCode, 0, 'Candidate and restored bytes must pass')
    assert.equal(result.numPassedTests, 9, 'All nonempty mounted behavior tests must execute')
    assert.equal(result.numFailedTests, 0)
  }
}
try {
  await run('green')
  for (const mutation of mutations) {
    const original = originals[mutation.path], text = original.toString('utf8')
    assert.equal(text.split(mutation.from).length - 1, 1, `Exact mutation anchor ${mutation.mode} must exist once`)
    const bytes = Buffer.from(text.replace(mutation.from, mutation.to))
    try {
      await writeFile(join(snapshot, mutation.path), bytes)
      await run(mutation.mode, { path: mutation.path, bytes })
    } finally {
      await writeFile(join(snapshot, mutation.path), original)
      assert.deepEqual(await readFile(join(snapshot, mutation.path)), original, 'Restore isolated source byte for byte')
    }
  }
  await run('restored')
  const layoutLogs = []
  const layoutExit = await new Promise((done, reject) => {
    const child = spawn(process.execPath, [join(root, 'apps/desktop/scripts/verify-file-markdown-layout.mjs')], { cwd: root, env: process.env })
    child.stdout.on('data', data => layoutLogs.push(data)); child.stderr.on('data', data => layoutLogs.push(data))
    child.on('error', reject); child.on('exit', done)
  })
  await writeFile(join(proof, 'layout.log'), Buffer.concat(layoutLogs))
  assert.equal(layoutExit, 0, 'The real bounded document layout must pass its loaded-CSS mutation oracle')
  receipt.layout = JSON.parse(Buffer.concat(layoutLogs).toString('utf8').trim().split('\n').at(-1))
  assert.equal(receipt.layout.passed, true)
} finally {
  for (const [path, bytes] of Object.entries(originals)) assert.deepEqual(await readFile(join(root, path)), bytes, 'Mutation harness must leave candidate source intact')
  await writeFile(join(proof, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
console.log(JSON.stringify({ proof, callers, phases: receipt.phases.map(({ assertions, loaded, ...phase }) => phase), layout: receipt.layout }))
