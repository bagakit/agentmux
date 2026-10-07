import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const viteEntry = createRequire(join(root, 'apps/desktop/package.json')).resolve('vite')
const owners = [
  'packages/client-ui/src/components/InlineComposer.tsx',
  'packages/client-ui/src/components/AgentComposer.tsx',
  'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx',
  'apps/desktop/src/renderer/src/components/NewTabSurface.tsx'
]
const test = 'apps/desktop/test/inline-composer-demand.test.tsx'
const sources = Object.fromEntries(owners.map(path => [path, readFileSync(join(root, path), 'utf8')]))
const sha = value => createHash('sha256').update(value).digest('hex')
const evidence = join(root, '.local/state/inline-composer-demand', randomUUID())
mkdirSync(evidence, { recursive: true })
const receipt = { schema: 'agentmux.inline-composer-demand.v1', passed: false, root,
  candidateBase: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceSHA256: Object.fromEntries(owners.map(path => [path, sha(sources[path])])),
  testSHA256: sha(readFileSync(join(root, test))), sourceWritten: false, userRunTouched: false,
  variants: [], limitations: ['DOM fixture; native IME, active terminal reading, persisted process restart and installed performance belong to the final joined candidate.'] }
function variant(name, owner, before, after) {
  const path = owners[owner]
  assert.equal(sources[path].split(before).length - 1, 1, 'Unique implementation anchor: ' + name)
  return { name, path, source: sources[path].replace(before, after) }
}
const variants = [null,
  variant('defer-withdrawn', 0, 'return active || presented ?', 'return true ?'),
  variant('retention-withdrawn', 0, 'return active || presented ?', 'return active ?'),
  variant('shared-demand-disconnected', 1, 'active={active}', 'active={true}'),
  variant('session-demand-disconnected', 2, 'key={sessionId} active={visible}', 'key={sessionId} active={true}'),
  variant('launcher-demand-disconnected', 3, '<InlineComposer active={visible && presentationActive}', '<InlineComposer active={true}'),
  variant('editable-update-withdrawn', 0, 'editor.setEditable(!props.disabled, false)', 'void props.disabled'),
  variant('unseen-insertion-silent', 0, 'insert: async () => { throw unavailableEditor() }', 'insert: async () => {}')
]
try {
  for (const mutation of variants) {
    const name = mutation?.name ?? 'candidate'
    const config = join(evidence, name + '.config.mts')
    const report = join(evidence, name + '.vitest.json'), loaded = join(evidence, name + '.loaded.json')
    const inputs = Object.fromEntries(owners.flatMap(path => {
      const source = mutation?.path === path ? mutation.source : sources[path]
      const entry = { sourcePath: path, source }
      // The product consumes client-ui through its built package. Compile the exact owning
      // source at that same module identity, preserving the real platform/context graph.
      return [[join(root, path), entry], ...(path.startsWith('packages/client-ui/')
        ? [[join(root, path.replace('/src/', '/dist/').replace(/\.tsx$/, '.js')), entry]] : [])]
    }))
    const text = `import { mergeConfig } from 'vitest/config'
import { transformWithEsbuild } from ${JSON.stringify(viteEntry)}
import { writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import base from ${JSON.stringify(join(root, 'vitest.config.ts'))}
const inputs = ${JSON.stringify(inputs)}, loaded = {}
const config = mergeConfig(base, { root: ${JSON.stringify(root)}, plugins: [{ name: 'actual-composer-demand-source', enforce: 'pre',
  async transform(_code, id) { const path = id.split('?')[0], input = inputs[path]; if (!input) return
    loaded[path] = { sourcePath: input.sourcePath, sha256: createHash('sha256').update(input.source).digest('hex') }
    writeFileSync(${JSON.stringify(loaded)}, JSON.stringify(loaded))
    return transformWithEsbuild(input.source, input.sourcePath, { loader: 'tsx', jsx: 'automatic', target: 'es2022' })
  } }] })
config.test = { ...config.test, include: [${JSON.stringify(test)}], maxWorkers: 1, fileParallelism: false, passWithNoTests: false }
export default config
`
    writeFileSync(config, text)
    const child = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', config,
      '--reporter=dot', '--reporter=json', '--outputFile=' + report], { cwd: root, encoding: 'utf8', timeout: 60_000 })
    writeFileSync(join(evidence, name + '.log'), (child.stdout ?? '') + (child.stderr ?? ''))
    assert.ifError(child.error)
    assert.equal(child.signal, null)
    const result = JSON.parse(readFileSync(report, 'utf8'))
    assert.deepEqual(result.testResults.map(item => item.name), [join(root, test)])
    const assertions = result.testResults.flatMap(item => item.assertionResults)
    assert.equal(assertions.length, 9, 'Exact nonempty behavior suite')
    assert.ok(assertions.every(item => ['passed', 'failed'].includes(item.status)))
    const failed = assertions.filter(item => item.status === 'failed')
    if (mutation) {
      assert.notEqual(child.status, 0)
      assert.ok(failed.length > 0 && failed.every(item => item.failureMessages.some(message => message.includes('AssertionError'))),
        'Only behavior assertions qualify as mutation RED')
    } else {
      assert.equal(child.status, 0)
      assert.equal(failed.length, 0)
    }
    const consumed = JSON.parse(readFileSync(loaded, 'utf8'))
    for (const path of owners) {
      const actual = Object.values(consumed).filter(item => item.sourcePath === path)
      assert.ok(actual.length > 0, 'Actual loaded product owner: ' + path)
      for (const entry of actual) assert.equal(entry.sha256, sha(mutation?.path === path ? mutation.source : sources[path]))
    }
    receipt.variants.push({ name, exitCode: child.status, assertions: assertions.length,
      failed: failed.map(item => item.fullName), consumed, configSHA256: sha(text) })
    console.log(JSON.stringify({ name, failed: failed.length }))
  }
  for (const path of owners) assert.equal(sha(readFileSync(join(root, path))), receipt.sourceSHA256[path], 'Owning source drift: ' + path)
  assert.equal(sha(readFileSync(join(root, test))), receipt.testSHA256, 'Test drift')
  receipt.passed = true
} finally {
  writeFileSync(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(join(evidence, 'receipt.json'))
}
