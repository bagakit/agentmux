import assert from 'node:assert/strict'
import { fixtureEpoch, fixtureIso } from '../../../../../test/fixture-values.mjs'

export const surfaceInput = '--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-const value = false\n+const value = true\n'
export const surfaceOutput = 'The original controlled result is retained.'
export function surfaceRows() {
  const row = (id, type, extra) => ({ type: 'response_item', timestamp: fixtureIso(1), payload: { id, type, ...extra } })
  return [row('surface-system', 'message', { role: 'developer', content: [{ type: 'input_text', text: 'Recorded runtime context: keep the original Session and workface.' }] }),
    row('surface-human', 'message', { role: 'user', content: [{ type: 'input_text', text: '请核对系统记录、协作回报与工具原文。' }] }),
    row('surface-report', 'agent_message', { author: '/root/reviewer', recipient: '/root', content: [{ type: 'input_text', text: '协作回报：原始记录与来源保持，可以继续核对。' }] }),
    row('surface-answer', 'message', { role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '共同卡片沿原始来源呈现，展开与复制不会改变记录。' }] })]
}
export function surfaceCaptured(agentSessionId) {
  return { id: 'surface-captured-tool', agentSessionId, kind: 'tool_call', status: 'complete', source: 'agentmux',
    title: 'Recorded patch input', toolName: 'controlled_patch', toolInput: surfaceInput, toolOutput: surfaceOutput,
    createdAt: fixtureEpoch(2), updatedAt: fixtureEpoch(2) }
}

/** Exercises real App controls over controlled Core records and a paused local intent. */
export async function exerciseSurfaces({ read, click, shot, until, copies }) {
  const control = async selector => {
    await read(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center'})`)
    await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    await click(`document.querySelector(${JSON.stringify(selector)})`)
  }
  const copy = async (selector, expected) => {
    const before = copies.length; await control(selector); await until(() => copies.length > before, 'Original surface copy receipt')
    assert.equal(copies.at(-1), expected)
  }
  await control('.log-turn__system-toggle')
  assert.equal(await read(`document.querySelector('.log-turn__system-toggle').getAttribute('aria-expanded')`), 'true')
  await shot('system')
  await control('.log-turn__collaboration-toggle')
  assert.equal(await read(`document.querySelector('.log-turn__collaboration-toggle').getAttribute('aria-expanded')`), 'true')
  await shot('collaboration')
  await control('.conversation-record-process .wf-head')
  await until(() => read(`!!document.querySelector('[data-captured-process-id="surface-captured-tool"]')`), 'Original captured process')
  await control('[data-captured-process-id="surface-captured-tool"] .log-row[aria-expanded]')
  assert.equal(await read(`document.querySelectorAll('[data-captured-process-id="surface-captured-tool"] .log-diff__line').length`), 2)
  await shot('captured-diff')
  await control('[data-captured-process-id="surface-captured-tool"] details summary')
  await copy('[data-captured-process-id="surface-captured-tool"] [aria-label="Copy tool input"]', surfaceInput)
  await copy('[data-captured-process-id="surface-captured-tool"] [aria-label="Copy tool output"]', surfaceOutput)
  await shot('captured-original')
  await control('.composer__mailbox')
  await until(() => read(`!!document.querySelector('.composer-mailbox:popover-open')`), 'Original mailbox')
  await control('.composer-mailbox [role="tab"][id$="-user-tab"]')
  await until(() => read(`!!document.querySelector('.composer-mailbox [data-input-history-id]')`), 'Original input history')
  await shot('compact-mailbox')
  await control('[aria-label="Close mailbox"]')
  await control('[aria-label="Show Terminal"]')
  await until(() => read(`!!document.querySelector('.terminal-view__xterm .xterm')`), 'Original terminal')
  await until(() => read(`!!document.querySelector('.composer-pending:not([hidden])')`), 'Original pending surface')
  const geometry = await read(`(()=>{const rect=n=>{const r=n.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom}};const pending=document.querySelector('.composer-pending:not([hidden])'),interaction=document.querySelector('.agent-interaction[data-request-id]'),input=document.querySelector('.terminal-view__xterm .xterm-helper-textarea');return {pending:rect(pending),interaction:interaction?rect(interaction):null,input:input?rect(input):null,request:interaction?.dataset.requestId}})()`)
  assert.ok(geometry.interaction, 'The real Provider hook supplies an original interaction card')
  const overlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  assert.equal(overlap(geometry.pending, geometry.interaction), false)
  if (geometry.input?.bottom > geometry.input?.top) assert.equal(overlap(geometry.pending, geometry.input), false)
  await shot('pending-terminal')
  await control('[aria-label="Show Activity"]')
  return { geometry, boundary: 'Provider-format native file, controlled Core captured input, original fake CLI PermissionRequest hook, and explicitly paused local intent. No dispatch or permission reply.' }
}
