import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '../../..')
const directory = path.join(root, '.tmp/ui-design-cohesion/mobile-' + randomUUID())
const capture = 'apps/mobile/scripts/fixtures/mobile-product-redesign/capture-ui.mjs'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const result = { passed: false, boundary: 'Original MobileApp in private Chromium. Source mutations are private compiler inputs; no physical phone, live Host/Run or aesthetic approval claim.', runs: [] }
await fs.mkdir(directory, { recursive: true })

async function run(id, expectedFailure) {
  const args = [capture, ...(expectedFailure ? ['--mutation=' + id] : [])]
  let output = ''
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('error', reject); child.on('close', resolve)
  })
  await fs.writeFile(path.join(directory, id + '.log'), output)
  const receipts = [...output.matchAll(/\.tmp\/mobile-product-redesign\/renderer-[\w-]+\/receipt\.json/g)]
  assert.ok(receipts.length > 0, 'Capture must produce its original Renderer receipt')
  const receiptPath = receipts.at(-1)[0]
  const receipt = JSON.parse(await fs.readFile(path.join(root, receiptPath), 'utf8'))
  assert.ok(Object.keys(receipt.source).length > 0 && Object.keys(receipt.images).length > 0, 'Actual production sources and Renderer images are nonempty')
  if (expectedFailure) {
    assert.equal(exitCode, 1, 'Actual implementation mutation must be rejected')
    assert.equal(receipt.passed, false)
    assert.equal(receipt.renderer?.error?.name, 'AssertionError', 'Compiler, timeout and setup errors do not count as mutation proof')
    assert.ok(receipt.renderer.error.message.startsWith(expectedFailure), 'Only the expected product assertion kills this mutation')
    assert.equal(receipt.sourceOverride?.id, id)
    assert.notEqual(receipt.sourceOverride.sha256, receipt.sourceOverride.originalSha256)
    assert.equal(receipt.source[receipt.sourceOverride.file], receipt.sourceOverride.sha256, 'The actual Renderer consumed the mutation')
    assert.equal(sha(await fs.readFile(path.join(root, receipt.sourceOverride.file))), receipt.sourceOverride.originalSha256, 'Shared source is untouched')
  } else {
    assert.equal(exitCode, 0)
    assert.equal(receipt.passed, true, receipt.error?.message)
    assert.ok(Object.keys(receipt.images).length > 5, 'The normal control covers complete original product surfaces')
    for (const [file, hash] of Object.entries(receipt.source)) assert.equal(sha(await fs.readFile(path.resolve(root, file))), hash, 'Control Source remains exact: ' + file)
  }
  result.runs.push({ id, receipt: receiptPath, expectedFailure: expectedFailure ?? null, sourceOverride: receipt.sourceOverride ?? null })
  console.log(id + ': ' + (expectedFailure ? 'mutation killed' : 'original Renderer passed'))
}

try {
  await run('control')
  await run('duplicate-connection', 'Same connection fact is not repeated in the shell')
  await run('hide-unknown', 'Unknown delivery remains independently visible')
  await run('missing-palette', 'Original MobileApp consumes the shared Graphite palette')
  result.passed = true
} catch (error) {
  result.error = { name: error.name, message: error.message, stack: error.stack }
  process.exitCode = 1
} finally {
  const file = path.join(directory, 'receipt.json')
  await fs.writeFile(file, JSON.stringify(result, null, 2) + '\n')
  await fs.writeFile(path.join(root, '.tmp/ui-design-cohesion/mobile-latest.json'), JSON.stringify({ receipt: path.relative(root, file), passed: result.passed }, null, 2) + '\n')
  console.log(path.relative(root, file))
  if (result.error) console.error(result.error.message)
}
