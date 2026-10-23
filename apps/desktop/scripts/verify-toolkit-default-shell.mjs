import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { defaultShellMutations } from './fixtures/toolkit-default-shell/mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const evidence = resolve(root, '.local/toolkit-default-shell/qualification')
const config = 'apps/desktop/test/toolkit-default-shell.config.mts'
const nativeTest = 'apps/desktop/test/toolkit-default-shell-native.test.ts'
const fastTests = [
  'apps/desktop/test/toolkit-default-shell.test.ts',
  'apps/desktop/test/toolkit-tui-owner.test.ts',
  'apps/desktop/test/toolkit-tui-config.test.ts',
]
const hash = (value) => createHash('sha256').update(value).digest('hex')
const read = async (path) => JSON.parse(await readFile(path, 'utf8'))
const nativeCases = new Set(['native', 'remerge-environment', 'main-default'])
const cases = [
  'baseline',
  'reject-blank',
  'wrong-wrapper',
  'forget-prepared',
  'mismatch-operation',
  'leak-receipt',
  ...nativeCases,
]
const assertion = {
  'mismatch-operation': 'rejects incomplete or non-data preparation',
  'leak-receipt':
    'keeps malformed private preparation out of the public Toolkit error',
  'reject-blank': 'accepts blank TUI command',
  'wrong-wrapper': 'captures the Host default shell',
  'forget-prepared': 'continues the captured default after a lost receipt',
  'remerge-environment':
    'keeps the captured Host shell and original Native Run',
  'main-default': 'keeps the captured Host shell and original Native Run',
}

async function current(inputs) {
  assert.ok(
    Object.keys(inputs).length > 0,
    'Evidence must bind nonempty actual sources',
  )
  for (const [path, digest] of Object.entries(inputs))
    assert.equal(
      hash(await readFile(resolve(root, path))),
      digest,
      'Source changed: ' + path,
    )
}

async function verify(name) {
  const directory = resolve(evidence, name),
    receipt = await read(resolve(directory, 'run.json'))
  assert.equal(receipt.name, name)
  await current(receipt.inputs)
  for (const [path, digest] of Object.entries(receipt.artifacts))
    assert.equal(
      hash(await readFile(resolve(root, path))),
      digest,
      'Artifact changed: ' + path,
    )
  const result = await read(resolve(directory, 'result.json'))
  assert.ok(result.numTotalTests > 0, 'Empty tests cannot qualify')
  if (!Object.hasOwn(defaultShellMutations, name)) {
    assert.equal(receipt.code, 0)
    assert.equal(result.success, true)
  } else {
    assert.notEqual(receipt.code, 0)
    assert.ok(
      result.testResults
        .flatMap((suite) => suite.assertionResults)
        .some(
          (test) =>
            test.fullName.includes(assertion[name]) &&
            test.status === 'failed' &&
            test.failureMessages.some((message) =>
              /AssertionError|expected/u.test(message),
            ),
        ),
      'Specific product assertion must kill ' + name,
    )
  }
  if (nativeCases.has(name)) {
    const source = await read(resolve(directory, 'compiled/source.json'))
    await current(source.inputs)
    for (const [path, digest] of Object.entries(source.compiled))
      assert.equal(hash(await readFile(resolve(root, path))), digest)
    if (name !== 'native')
      assert.ok(
        source.consumed.some(
          (input) =>
            input.path === defaultShellMutations[name][0] &&
            input.originalSHA256 !== input.consumedSHA256,
        ),
        'Native consumer must load the product mutation',
      )
    const native = await read(resolve(directory, 'native.json'))
    assert.deepEqual(native.remaining, [])
    assert.equal(native.cleanup.childExit, 'confirmed')
    assert.equal(native.cleanup.namespace, 'removed')
    assert.ok(
      native.childExits.length > 0 &&
        native.childExits.every(
          (exit) => exit.code === 0 && exit.signal === null,
        ),
      'Every private owner must exit normally',
    )
    if (name === 'native') {
      assert.equal(native.completed, true)
      assert.equal(native.proof.actualCli, true)
      assert.equal(native.proof.hostEnvironmentFrozen, true)
      assert.equal(native.proof.privateReceiptMode, '0600')
      assert.equal(native.proof.publicIntentAbsent, true)
      assert.equal(
        native.proof.continuedRun.runId,
        native.proof.originalRun.runId,
      )
      assert.equal(native.proof.sameRunInput.pid, native.proof.originalRun.pid)
      assert.equal(native.proof.ownerPids.length, 4)
    }
  } else if (name !== 'baseline') {
    const loaded = (
      await readFile(resolve(directory, 'mutation.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map(JSON.parse)
    assert.ok(
      loaded.some(
        (input) =>
          input.mutation === name &&
          input.path === defaultShellMutations[name][0] &&
          input.originalSHA256 !== input.consumedSHA256,
      ),
      'Fast consumer must load the product mutation',
    )
  }
  return {
    name,
    total: result.numTotalTests,
    passed: result.numPassedTests,
    failed: result.numFailedTests,
    receipt: relative(root, resolve(directory, 'run.json')),
    sha256: hash(await readFile(resolve(directory, 'run.json'))),
  }
}

async function run(name) {
  assert.ok(cases.includes(name), 'Choose one bounded qualification case')
  const directory = resolve(evidence, name)
  await mkdir(directory, { recursive: true })
  await rm(resolve(evidence, 'receipt.json'), { force: true })
  for (const file of ['result.json', 'run.json'])
    await rm(resolve(directory, file), { force: true })
  const inputs = {}
  for (const path of [
    config,
    'apps/desktop/scripts/fixtures/toolkit-custom/vitest.config.mts',
    'apps/desktop/scripts/fixtures/toolkit-default-shell/mutations.mjs',
    'apps/desktop/scripts/verify-toolkit-default-shell.mjs',
    ...(nativeCases.has(name) ? [nativeTest] : fastTests),
  ]) {
    inputs[path] = hash(await readFile(resolve(root, path)))
  }
  for (const file of [
    'loaded-source.jsonl',
    'mutation.jsonl',
    'bindings.jsonl',
  ])
    await writeFile(resolve(directory, file), '')
  const child = spawn(
    process.execPath,
    [
      resolve(root, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--config',
      config,
      '--reporter=default',
      '--reporter=json',
      '--outputFile=' + resolve(directory, 'result.json'),
    ],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AGENTMUX_TOOLKIT_EVIDENCE: directory,
        AGENTMUX_TOOLKIT_MUTANT: '',
        AGENTMUX_DEFAULT_SHELL_NATIVE: nativeCases.has(name) ? '1' : '',
        AGENTMUX_DEFAULT_SHELL_MUTATION: Object.hasOwn(
          defaultShellMutations,
          name,
        )
          ? name
          : '',
      },
    },
  )
  let log = ''
  child.stdout.on('data', (value) => {
    log += value
  })
  child.stderr.on('data', (value) => {
    log += value
  })
  const code = await new Promise((accept, reject) => {
    child.once('error', reject)
    child.once('close', accept)
  })
  await writeFile(resolve(directory, 'run.log'), log)
  const loaded = (
    await readFile(resolve(directory, 'loaded-source.jsonl'), 'utf8')
  )
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse)
  assert.ok(loaded.length > 0, 'Actual product imports must be observed')
  const bindings = (
    await readFile(resolve(directory, 'bindings.jsonl'), 'utf8')
  )
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse)
  assert.ok(bindings.length > 0)
  for (const input of bindings) {
    assert.equal(
      hash(await readFile(resolve(root, input.path))),
      input.disk,
      'Source drift: ' + input.path,
    )
    inputs[input.path] = input.disk
    if (input.path.endsWith('.ts') && !input.path.includes('/dist/'))
      assert.equal(
        input.loaded,
        input.disk,
        'Actual TypeScript consumer differs from source: ' + input.path,
      )
  }
  if (nativeCases.has(name))
    Object.assign(
      inputs,
      (await read(resolve(directory, 'compiled/source.json'))).inputs,
    )
  await current(inputs)
  const artifacts = {}
  for (const file of [
    'result.json',
    'run.log',
    'loaded-source.jsonl',
    'mutation.jsonl',
    'bindings.jsonl',
    ...(nativeCases.has(name)
      ? ['compiled/source.json', 'native.json', 'cli.jsonl']
      : []),
  ]) {
    const path = relative(root, resolve(directory, file))
    artifacts[path] = hash(await readFile(resolve(root, path)))
  }
  await writeFile(
    resolve(directory, 'run.json'),
    JSON.stringify({ name, code, inputs, artifacts }, null, 2) + '\n',
  )
  const result = await verify(name)
  process.stdout.write(
    name +
      ': ' +
      (Object.hasOwn(defaultShellMutations, name)
        ? 'mutation killed'
        : 'passed') +
      '\n',
  )
  return result
}

if (process.argv[2] === '--case') await run(process.argv[3])
else {
  assert.equal(
    process.argv.length,
    2,
    'Use --case <name> only to produce one bounded case',
  )
  const results = []
  for (const name of cases) results.push(await verify(name))
  await writeFile(
    resolve(evidence, 'receipt.json'),
    JSON.stringify({ status: 'passed', results }, null, 2) + '\n',
  )
  process.stdout.write('Toolkit default shell qualification passed.\n')
}
