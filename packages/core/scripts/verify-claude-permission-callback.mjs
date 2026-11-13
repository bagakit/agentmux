import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

assert.equal(process.argv.length, 2, 'This verification accepts no user profile or existing Session target')
const root = resolve(import.meta.dirname, '../../..'), base = join(root, '.local/claude-permission-callback')
await mkdir(base, { recursive: true })
const artifact = join(base, randomUUID()); await mkdir(artifact)
const loader = pathToFileURL(join(root, 'packages/core/scripts/fixtures/claude-permission-callback/source-loader.mjs')).href
const registration = `import { register } from 'node:module';register(${JSON.stringify(loader)},${JSON.stringify(import.meta.url)});`
const nodeOptions = '--import=data:text/javascript,' + encodeURIComponent(registration)
const variables = ['PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TZ']
const clean = Object.fromEntries(variables.flatMap(key => process.env[key] ? [[key, process.env[key]]] : []))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const validationPaths = [
  'packages/core/src/providers/claude.ts', 'packages/core/src/client.ts', 'packages/core/src/agent-interaction-state.ts',
  'packages/core/scripts/verify-claude-permission-callback.mjs',
  'packages/core/scripts/fixtures/claude-permission-callback/native.mjs',
  'packages/core/scripts/fixtures/claude-permission-callback/source-loader.mjs',
  'packages/core/test/vitest.claude-permission.config.mts', 'packages/core/test/agent-interaction-active-hook.test.ts',
  'packages/core/test/agent-provider.test.ts', 'packages/core/test/claude-native-request-lifecycle.test.ts',
  'packages/core/test/permission-hook-callback.test.ts', 'packages/core/test/permission-hook-core.test.ts',
  'packages/core/test/providers/claude.test.ts', 'packages/core/test/provider-hook-timeout-source.test.ts'
]
const validationHashes = Object.fromEntries(await Promise.all(validationPaths.map(async path => [path, hash(await readFile(join(root, path)))])))
const proof = { schema: 'agentmux.claude-permission-callback-proof.v1', passed: false, actual: 'Real Claude executable, packed ctxmux, Core Hook server, Store, public RPC and object CLI',
  controlled: 'Anthropic Messages API tool proposal only; the model fixture executes no tools', userRuntimeTouched: false, sharedSourceMutations: 0, validationHashes, stages: [] }
try {
  const stages = [
    { variant: 'candidate', kind: 'native' },
    { variant: 'no-native-decision', kind: 'native', expected: 'original native permission callback addressable' },
    { variant: 'short-permission-timeout', kind: 'native', expected: 'original callback remains open beyond the short observer timeout' },
    { variant: 'unit-candidate', kind: 'unit' },
    { variant: 'provider-candidate', kind: 'unit', providerOnly: true, pattern: 'explicitly own its typed terminal response protocol' },
    { variant: 'forget-callback-invocation', kind: 'unit', pattern: 'settles an addressable callback only through its own' },
    { variant: 'forget-confirmed-answer', kind: 'unit', pattern: 'a returned original callback leaves' },
    { variant: 'promote-unconfirmed-answer', kind: 'unit', pattern: 'response remains an unresolved original request' },
    { variant: 'forget-close-proof', kind: 'unit', pattern: 'write observation without the original callback close' },
    { variant: 'hide-other-requests', kind: 'unit', pattern: 'returned callback cannot hide another original' }
  ]
  for (const specification of stages) {
    const { variant, kind } = specification
    const directory = await realpath(await mkdtemp('/tmp/amx-permission-'))
    const loaded = join(artifact, variant + '-loaded.ndjson')
    const env = { ...clean, HOME: join(directory, 'home'), CLAUDE_CONFIG_DIR: join(directory, 'claude'),
      AGENTMUX_RUNTIME_DIRECTORY: join(directory, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(directory, 'state'),
      AGENTMUX_AGENT_SESSION_STORE: join(directory, 'state/sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(directory, 'state/messages.ndjson'),
      AGENTMUX_CLAUDE_PERMISSION_ROOT: directory, AGENTMUX_CLAUDE_PERMISSION_LOADED: loaded,
      AGENTMUX_CLAUDE_PERMISSION_MUTATION: variant.endsWith('candidate') ? '' : variant,
      NODE_OPTIONS: nodeOptions, NODE_NO_WARNINGS: '1',
      AGENTMUX_CLAUDE_PERMISSION_PROVIDER_ONLY: specification.providerOnly ? '1' : '', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ENABLE_TOOL_SEARCH: 'false',
      DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' }
    const stage = await new Promise((yes, no) => {
      const args = kind === 'native' ? ['packages/core/scripts/fixtures/claude-permission-callback/native.mjs'] :
        ['node_modules/vitest/vitest.mjs', 'run', '--config', 'packages/core/test/vitest.claude-permission.config.mts',
          ...(specification.pattern ? ['--testNamePattern', specification.pattern] : []),
          '--reporter=json', '--outputFile=' + join(artifact, variant + '-tests.json')]
      const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = '', timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 120000)
      child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
      child.once('error', no); child.once('close', (code, signal) => { clearTimeout(timer); yes({ variant, kind, directory, code, signal, timedOut, output }) })
    })
    await writeFile(join(artifact, variant + '.log'), stage.output)
    const rows = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    assert(rows.length > 0, 'The actual production source graph must be nonempty')
    // Other work packages may change unrelated loaded modules during this proof.
    // Bind every observed version; only this slice's behavior-bearing sources must stay fixed.
    stage.sourceVersions = rows
    for (const row of rows.filter(row => ['packages/core/src/client.ts', 'packages/core/src/providers/claude.ts', 'packages/core/src/agent-interaction-state.ts'].includes(row.path))) {
      assert.equal(hash(await readFile(join(root, row.path))), row.originalSHA256, 'Permission source changed during its proof: ' + row.path)
    }
    stage.loaded = [...new Set(rows.map(row => row.path))]
    stage.transformed = [...new Set(rows.filter(row => row.changed).map(row => row.path))]
    delete stage.output
    assert.equal(stage.timedOut, false); assert.equal(stage.signal, null)
    if (kind === 'native') {
      const cleanup = JSON.parse(await readFile(join(directory, 'cleanup.json'), 'utf8'))
      assert.equal(cleanup.passed, true, 'All exact private resources must be released')
      if (variant === 'candidate') {
        assert.equal(stage.code, 0, 'Real native callback candidate failed: ' + join(artifact, variant + '.log'))
        stage.native = JSON.parse(await readFile(join(directory, 'native-proof.json'), 'utf8'))
        assert.equal(stage.native.passed, true); assert.deepEqual(stage.native.cases.map(item => item.mode), ['allow', 'deny'])
        assert.equal(stage.transformed.length, 0)
      } else {
        stage.failure = JSON.parse(await readFile(join(directory, 'failure.json'), 'utf8'))
        assert.equal(stage.code, 1); assert(stage.transformed.length > 0)
        assert(stage.failure.message.includes(specification.expected), 'Mutation must fail its accepted behavior assertion: ' + stage.failure.message)
      }
    } else {
      const report = JSON.parse(await readFile(join(artifact, variant + '-tests.json'), 'utf8'))
      const assertions = report.testResults.flatMap(suite => suite.assertionResults)
      const active = assertions.filter(item => ['passed', 'failed'].includes(item.status))
      stage.tests = active.map(item => ({ name: item.fullName, status: item.status, failureMessages: item.failureMessages }))
      assert(active.length > 0, 'The selected behavior consumer set must be nonempty')
      if (variant.endsWith('candidate')) {
        assert.equal(stage.code, 0, 'Permission regression failed: ' + join(artifact, variant + '.log'))
        assert.equal(report.numFailedTests, 0); assert.equal(report.numFailedTestSuites, 0); assert.equal(report.success, true)
        assert(active.length >= (specification.providerOnly ? 2 : 40)); assert.equal(stage.transformed.length, 0)
      } else {
        assert.equal(stage.code, 1); assert(stage.transformed.length > 0)
        const failed = active.filter(item => item.status === 'failed')
        assert(failed.length > 0)
        assert(failed.every(item => item.failureMessages.some(message => message.includes('AssertionError'))),
          'Every mutation must fail a real behavior assertion, not compilation or setup')
      }
    }
    proof.stages.push(stage)
    await writeFile(join(artifact, 'receipt.json'), JSON.stringify(proof, null, 2))
    process.stdout.write(JSON.stringify({ variant, code: stage.code, transformed: stage.transformed, nativeVersion: stage.native?.nativeVersion }) + '\n')
  }
  for (const [path, expected] of Object.entries(validationHashes)) assert.equal(hash(await readFile(join(root, path))), expected, 'Permission verification input changed: ' + path)
  proof.passed = true
} catch (error) { proof.error = { message: error.message, stack: error.stack } }
finally {
  await writeFile(join(artifact, 'receipt.json'), JSON.stringify(proof, null, 2))
  await writeFile(join(base, 'latest.json'), JSON.stringify({ passed: proof.passed, receipt: join(artifact, 'receipt.json') }) + '\n')
  process.stdout.write(JSON.stringify({ passed: proof.passed, receipt: join(artifact, 'receipt.json'), error: proof.error?.message }) + '\n')
}
if (!proof.passed) process.exitCode = 1
