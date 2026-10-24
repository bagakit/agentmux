import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
execFileSync(process.execPath, [fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url)), '-p', join(root, 'tsconfig.json')], { stdio: 'inherit' })
const test = join(root, 'test/client.mjs')
execFileSync(process.execPath, ['--test', test], { stdio: 'inherit' })
const mutations = [
  { file: 'client.js', before: 'response.instanceId !== this.instance', after: 'false', test: 'spoofed response instance' },
  { file: 'client.js', before: 'response.operationId !== pending.operation?.operationId', after: 'false', test: 'wrong operation receipt' },
  { file: 'image.js', before: 'dimensions.width !== image.width', after: 'false', test: 'PNG limits and metadata' },
  { file: 'client.js', before: "pending.operation.state = 'unknown'", after: "pending.operation.state = 'failed'", test: 'lost mutation retains original' },
  { file: 'client.js', before: 'async request(method, params, options = {}) {\n        await options.beforeSubmit?.();', after: 'async request(method, params, options = {}) {', test: 'submission rechecks the original authority' },
  { file: 'client.js', before: 'freezeReceivedJson(response.result)', after: 'response.result', test: 'callers cannot rewrite' }
]
for (const mutation of mutations) {
  const directory = await mkdtemp(join(tmpdir(), 'amux-native-mutation-'))
  try {
    await cp(join(root, 'dist'), directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), '{"type":"module"}')
    const file = join(directory, mutation.file)
    const before = await readFile(file, 'utf8')
    assert.equal(before.split(mutation.before).length, 2, `Mutation anchor must occur once: ${mutation.before}`)
    await writeFile(file, before.replace(mutation.before, mutation.after))
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=' + mutation.test, test], {
      env: { ...process.env, NATIVE_TEST_ENTRY: pathToFileURL(join(directory, 'index.js')).href }, encoding: 'utf8'
    })
    assert.notEqual(result.status, 0, `Surviving mutation: ${mutation.before}`)
    assert.match(result.stdout, /not ok/, `Mutation failed outside the test: ${result.stderr}`)
    console.log(`killed: ${mutation.before}`)
  } finally { await rm(directory, { recursive: true, force: true }) }
}
console.log(`native client: baseline and ${mutations.length} behavior mutations passed; Unix fixture is not OS permission proof`)
