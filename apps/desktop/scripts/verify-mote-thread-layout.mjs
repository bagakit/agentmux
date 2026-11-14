import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const root = resolve(import.meta.dirname, '../../..')
const run = promisify(execFile)
const fixture = 'apps/mobile/scripts/fixtures/mobile-product-redesign/capture-ui.mjs'
const component = 'packages/client-ui/src/components/MoteConversationThreads.tsx'
const styles = 'packages/client-ui/src/styles/mote-conversation.css'
const tabs = 'packages/client-ui/src/components/Tabs.tsx'
const hash = text => createHash('sha256').update(text).digest('hex')
const digest = async file => hash(await readFile(resolve(root, file)))
const candidate = await digest(component)

async function capture(mutation, expected) {
  let output
  let status = 0
  try {
    output = (await run(process.execPath, [fixture, '--mote-discussion-restore', ...(mutation ? ['--mutation=' + mutation] : [])],
      { cwd: root, timeout: 120_000 })).stdout
  } catch (error) {
    status = error.code
    output = error.stdout
  }
  const receiptPath = output?.match(/^\.tmp\/mobile-product-redesign\/renderer-[a-f0-9-]+\/receipt\.json$/mu)?.[0]
  assert.ok(receiptPath, 'Actual Mobile Renderer must produce a receipt')
  const receipt = JSON.parse(await readFile(resolve(root, receiptPath), 'utf8'))
  assert.equal(receipt.source[styles], await digest(styles), 'The actual shared stylesheet was compiled')
  assert.equal(receipt.source[tabs], await digest(tabs), 'The actual public Tabs were compiled')
  assert.equal(await digest(component), candidate, 'Private probes never change the original source')
  if (mutation) {
    assert.equal(status, 1, 'An actual assertion fails, with no timeout or setup failure')
    assert.equal(receipt.sourceOverride.id, mutation)
    assert.equal(receipt.sourceOverride.file, component)
    assert.equal(receipt.sourceOverride.originalSha256, candidate)
    assert.notEqual(receipt.sourceOverride.sha256, candidate)
    assert.equal(receipt.source[component], receipt.sourceOverride.sha256)
    assert.equal(receipt.process?.timedOut, false, 'A timed-out Renderer cannot prove a behavior mutation')
    const failure = receipt.renderer?.error
    assert.equal(failure?.name, 'AssertionError', receipt.error?.message)
    assert.ok(failure.message.includes(expected), failure.message)
  } else {
    assert.equal(status, 0, receipt.renderer?.error?.message)
    assert.equal(receipt.passed, true)
    assert.equal(receipt.source[component], candidate)
    assert.equal(receipt.restoredRenderer.passed, true, 'The original member thread still restores in a fresh process')
    assert.equal(receipt.renderer.operations.filter(item => item.action === 'thread-layout-complete-filters').length, 1)
    assert.ok(receipt.renderer.operations.some(item => item.action === 'thread-layout-ordinary-reading' && item.visible))
    assert.deepEqual(receipt.renderer.operations.filter(item => item.action === 'thread-layout-unchanged-original').map(item => item.width), [960, 320])
  }
  console.log((mutation ?? 'baseline') + ' ' + receiptPath)
}

await capture()
await capture('mote-thread-tabs-disconnected', 'The real inner arrow focuses and activates Members')
await capture('mote-thread-layout-remounts', 'The original reply node, selection and focus survive a layout change')
