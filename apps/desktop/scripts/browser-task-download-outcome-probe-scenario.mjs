import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { native } from './browser-demonstration-probe-scenario.mjs'
import { publicFacts } from './browser-outcome-probe-scenario.mjs'

// Thin scenario only: the existing canonical owns Chromium, socket, durable workspace and quit/relaunch.
export const taskDownloadPayload = Buffer.from([0, 255, 128, 13, 10, 1, 2, 0, 254])
export const taskDownloadFixture = '<button id="task-download">Create file</button><script>globalThis.demoTrusted={click:0,input:0};globalThis.taskFileClicks=0;document.addEventListener("click",event=>{if(event.isTrusted){globalThis.demoTrusted.click++;globalThis.demoTrusted.lastTarget=event.target.id}},true);document.querySelector("#task-download").addEventListener("click",()=>{if(++globalThis.taskFileClicks>1){const link=document.createElement("a");link.href="/task-completion.bin";link.download="artifact.bin";link.click()}})</script>'
const q = JSON.stringify
const surface = '[aria-label="Editable Browser task asset"]'
const buttons = (ctx, label) => `${ctx.selectors(surface + ' button')}.filter(element=>element.textContent.trim()===${q(label)})`
const state = ctx => ctx.probe.cdp.evaluate(`window.agentmux.browser.getTaskAssets(${q(ctx.browserId)})`)
async function actualOperation(ctx) {
  const document = JSON.parse(await readFile(join(ctx.userData, 'browser-operation-journal.json'), 'utf8'))
  return document.operations.find(item => item.id === ctx.receipt.taskDownload.operationId)
}
async function check(ctx, label) {
  const before = await state(ctx)
  await ctx.click(ctx.probe.cdp, buttons(ctx, 'Verify task evidence'))
  await ctx.waitFor('real readable file completion projection', () => ctx.probe.cdp.evaluate(`document.querySelector('[data-task-completion]')?.dataset.taskCompletion==='passed'`))
  const operation = await actualOperation(ctx)
  assert.deepEqual(operation.outcome.evaluation.conditions.map(item => item.status), ['passed'])
  assert.deepEqual(operation.outcome.registration.assetRun, ctx.receipt.taskDownload.assetRun)
  const facts = await publicFacts(ctx, operation)
  assert.deepEqual(await state(ctx), before, 'Verification must not change its saved cursor or produce another action')
  assert.equal(ctx.receipt.taskDownload.requests.length, 1, 'Readonly completion checks must never repeat the download')
  ;(ctx.receipt.taskDownload.checks ??= []).push({ label, evaluation: operation.outcome.evaluation, public: facts })
}

export async function reviewTaskDownloadOutcome(ctx) {
  ctx.setPhase('task-download-outcome-real-declaration')
  const { probe, receipt } = ctx
  receipt.taskDownload ??= { requests: [] }
  await ctx.click(probe.cdp, ctx.selectors('[aria-label="More browser tools"]'))
  await ctx.click(probe.cdp, ctx.selectors('[aria-label="Open human demonstration draft"]'))
  await ctx.click(probe.cdp, ctx.selectors('[aria-label="Start recording demonstration"]'))
  await native(ctx, '#task-download') // The first real demonstration prepares the file, without starting a transfer.
  await ctx.click(probe.cdp, ctx.selectors('[aria-label="Stop recording demonstration"]'))
  await ctx.waitFor('actual stopped semantic demonstration', () => probe.cdp.evaluate(`window.agentmux.browser.getDemonstration(${q(ctx.browserId)}).then(value=>value.draft?.status==='stopped'&&value.draft.steps.length>0)`))
  await ctx.click(probe.cdp, buttons(ctx, 'Edit demonstration'))
  const imported = await ctx.waitFor('actual file task imported', async () => (await state(ctx)).assets[0] ?? null)
  assert.deepEqual(imported.draft.steps.map(step => step.kind), ['click'])
  assert.equal(imported.draft.steps[0].target.name, 'Create file')
  await ctx.click(probe.cdp, ctx.selectors(surface + ' [aria-label="Review task step 1"]'))
  await ctx.click(probe.cdp, `${ctx.selectors(surface + ' summary')}.filter(element=>element.textContent.startsWith('Completion conditions'))`)
  const path = `${surface} [aria-label=${q('Download path for ' + imported.draft.steps[0].id)}]`
  await ctx.click(probe.cdp, ctx.selectors(path))
  await probe.cdp.call('Input.insertText', { text: 'task-artifact.bin' })
  assert.equal(await probe.cdp.evaluate(`document.querySelector(${q(path)}).value`), 'task-artifact.bin')
  await ctx.click(probe.cdp, buttons(ctx, 'Save version'))
  const saved = await ctx.waitFor('immutable declared download version', async () => {
    const asset = (await state(ctx)).assets.find(item => item.id === imported.id)
    return asset?.versions.length === 1 ? asset : null
  })
  assert.deepEqual(saved.versions[0].completion.criteria, [{ kind: 'download-readable', stepId: imported.draft.steps[0].id, path: 'task-artifact.bin' }])
  await ctx.click(probe.cdp, buttons(ctx, 'Run version'))
  const completed = await ctx.waitFor('declared native transfer completed', async () => (await state(ctx)).runs.find(item => item.assetId === saved.id && item.status === 'completed') ?? null)
  assert.equal(completed.operationIds.length, 1)
  receipt.taskDownload.asset = saved
  receipt.taskDownload.run = completed
  receipt.taskDownload.operationId = completed.operationIds[0]
  receipt.taskDownload.assetRun = { runId: completed.id, assetId: saved.id, version: 1 }
  assert.equal(receipt.taskDownload.requests.length, 1)
  const original = await actualOperation(ctx)
  const produced = original.steps.filter(step => step.method === 'download')
  assert.equal(produced.length, 1)
  assert.equal(produced[0].status, 'completed')
  assert.deepEqual(original.outcome.registration.assetRun, receipt.taskDownload.assetRun)
  const file = await readFile(join(ctx.workspacePath, 'task-artifact.bin'))
  assert.deepEqual(file, taskDownloadPayload)
  await check(ctx, 'before-quit')
  for (const [label, width, height] of [['normal', 1440, 900], ['narrow', 1000, 720], ['short', 1000, 660]]) {
    await ctx.resize(probe, width, height)
    await check(ctx, label)
    await ctx.capture(probe, `${label}-task-download-satisfied`, 'task-assets')
  }
  await ctx.resize(probe, 1440, 900)
}

export async function recoverTaskDownloadOutcome(ctx) {
  ctx.setPhase('task-download-outcome-ordinary-restart')
  const restored = await ctx.waitFor('actual file task and cursor restored', async () => {
    const value = await state(ctx)
    return value.runs.find(item => item.id === ctx.receipt.taskDownload.run.id)?.status === 'completed' ? value : null
  })
  assert.deepEqual(restored.assets[0], ctx.receipt.taskDownload.asset)
  assert.deepEqual(restored.runs[0], ctx.receipt.taskDownload.run)
  assert.equal(await ctx.nativePageScript(ctx.probe, 'globalThis.taskFileClicks'), 0, 'Restore cannot replay a file producer')
  await ctx.click(ctx.probe.cdp, `${ctx.selectors('[aria-label="More browser tools"]')}.filter(element=>element.closest('.browser-surface')?.querySelector('[aria-label="Browser address"]')?.value===${q(ctx.pageUrl)})`)
  await ctx.click(ctx.probe.cdp, ctx.selectors('[aria-label="Open human demonstration draft"]'))
  await check(ctx, 'after-ordinary-restart')
  assert.deepEqual(await readFile(join(ctx.workspacePath, 'task-artifact.bin')), taskDownloadPayload)
  assert.equal(await ctx.nativePageScript(ctx.probe, 'globalThis.taskFileClicks'), 0)
  await ctx.capture(ctx.probe, 'normal-task-download-restored-satisfied', 'task-assets')
  ctx.receipt.taskDownload.complete = true
}
