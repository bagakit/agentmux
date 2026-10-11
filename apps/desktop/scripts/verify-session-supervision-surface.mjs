import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifySourcePins } from './session-capability-evidence.mjs'
import { readSupervisionNativeSurfaceOwner, readSupervisionInitialWaitOwner } from './session-supervision-native-evidence.mjs'
import { readSupervisionConsumerOwner, readSupervisionSettingsOwner } from './session-supervision-evidence.mjs'

const entry = 'apps/desktop/scripts/verify-session-supervision-surface.mjs'
const root = path.resolve(import.meta.dirname, '../../..')
const hash = value => createHash('sha256').update(value).digest('hex')
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'))
const guard = 'apps/desktop/scripts/fixtures/session-continuity-supervision/native-evidence-guards.mjs'
const sources = [entry, guard, 'apps/desktop/scripts/session-capability-evidence.mjs', 'apps/desktop/scripts/session-supervision-evidence.mjs', 'apps/desktop/scripts/session-supervision-native-evidence.mjs']
const pins = async project => Object.fromEntries(await Promise.all(sources.map(async file => [file, hash(await fs.readFile(path.join(project, file)))])))


async function owners(project, files) {
  assert.deepEqual(Object.keys(files).sort(), ['cleanup', 'consumer', 'native', 'settings'])
  assert.deepEqual(Object.keys(files.consumer).sort(), ['initialWaiting', 'surface'])
  assert.deepEqual(Object.keys(files.native).sort(), ['initialWaiting', 'surface'])
  const results = [await readSupervisionSettingsOwner(project, files.settings),
    await readSupervisionConsumerOwner(project, 'consumer', files.consumer.surface),
    await readSupervisionConsumerOwner(project, 'initialWaiting', files.consumer.initialWaiting),
    await readSupervisionConsumerOwner(project, 'cleanup', files.cleanup),
    await readSupervisionNativeSurfaceOwner(project, files.native.surface),
    await readSupervisionInitialWaitOwner(project, files.native.initialWaiting)]
  const consumer = await read(path.resolve(project, files.consumer.surface))
  for (const id of ['main-native-gate', 'main-remote-scope', 'main-packet-identity']) assert.ok(consumer.runs.some(one => one.id === id && one.exitCode === 1))
  return results
}

/** Consume the original T004 join and each producer again; locator JSON never substitutes for proof. */
export async function readSupervisionSurfaceEvidence(project, receiptFile) {
  const file = path.resolve(project, receiptFile), bytes = await fs.readFile(file), receipt = JSON.parse(bytes)
  assert.equal(receipt.schema, 'agentmux.supervision-surface-qualification.v1'); assert.equal(receipt.passed, true)
  assert.deepEqual(receipt.after, receipt.before)
  const sourceInputs = await verifySourcePins(project, receipt.before, entry)
  assert.deepEqual(await owners(project, receipt.files), receipt.owners)
  return { task: 'T004', receipt: file, sha256: hash(bytes), sourceInputs, owners: receipt.owners,
    visualAcceptance: 'Independent review of the actual frames remains separate.' }
}

async function main() {
  const args = process.argv.slice(2), option = name => { const at = args.indexOf(name); return at < 0 ? null : args[at + 1] }
  const output = path.resolve(root, option('--output') ?? '.tmp/session-continuity-supervision/surface')
  await fs.mkdir(output, { recursive: true }); await fs.rm(path.join(output, 'qualification.json'), { force: true })
  const before = await pins(root), receipt = { schema: 'agentmux.supervision-surface-qualification.v1', passed: false, before,
    limitations: ['Automated exact-source qualification only; the Host separately reviews the actual frames.',
      'One private Native generation proves controls and workface preservation; T005 owns restart and final integration.',
      'The repository native protocol fixture does not certify upstream Provider account or bootstrap services.'] }
  try {
    const supplied = option('--owners')
    if (supplied) receipt.files = await read(path.resolve(root, supplied))
    else {
      const receiptAt = name => path.join(output, name, 'receipt.json')
      receipt.files = { settings: receiptAt('settings'), cleanup: receiptAt('cleanup'),
        consumer: { surface: receiptAt('consumer'), initialWaiting: receiptAt('initial-consumer') },
        native: { surface: receiptAt('native'), initialWaiting: receiptAt('initial-native') } }
      const run = async (name, script, positional = false) => {
        const directory = path.join(output, name), log = []
        const child = spawn(process.execPath, [path.join(root, 'apps/desktop/scripts', script), ...(positional ? [directory] : ['--output', directory])], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
        child.stdout.on('data', value => { log.push(value) }); child.stderr.on('data', value => { log.push(value) })
        const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
        await fs.writeFile(path.join(output, name + '.log'), Buffer.concat(log)); assert.equal(code, 0, name + ' original producer failed')
      }
      await run('settings', 'verify-session-continuity-settings.mjs')
      await run('consumer', 'verify-session-continuity-supervision.mjs')
      await run('initial-consumer', 'verify-initial-continuity-supervision.mjs')
      await run('cleanup', 'verify-probe-cleanup-observation.mjs')
      await run('native', 'verify-session-continuity-supervision-surface.mjs', true)
      await run('initial-native', 'verify-initial-continuity-supervision-surface.mjs', true)
    }
    receipt.owners = await owners(root, receipt.files)
    const guardLog = [], child = spawn(process.execPath, [path.join(root, guard), root, receipt.files.native.initialWaiting,
      path.join(output, 'native-evidence-guards'), receipt.files.native.surface], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', value => { guardLog.push(value) }); child.stderr.on('data', value => { guardLog.push(value) })
    const guardCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
    await fs.writeFile(path.join(output, 'native-evidence-guards.log'), Buffer.concat(guardLog))
    assert.equal(guardCode, 0, 'The original Native evidence reader must reject its counterexamples')
    receipt.mainWire = 'The full consumer producer includes the actual Main/Hosted test and all three exact loaded Main counterexamples.'
    receipt.after = await pins(root); assert.deepEqual(receipt.after, before)
    receipt.passed = true
  } catch (error) { receipt.failure = { name: error.name, message: error.message }; throw error }
  finally { await fs.writeFile(path.join(output, 'qualification.json'), JSON.stringify(receipt, null, 2) + '\n') }
  console.log('Original settings, Store, Main, cleanup and Native surface evidence qualified; independent visual review remains separate.')
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
