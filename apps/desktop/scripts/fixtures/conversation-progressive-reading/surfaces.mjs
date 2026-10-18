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
export async function exerciseSurfaces({ read, click, shot, until, copies, resize }) {
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
  const processGroups = await read(`([...document.querySelectorAll('.conversation-record-process .wf-head')].filter(node=>node.getClientRects().length).map((node,index)=>{node.dataset.readingProofGroup=String(index);return index}))`)
  assert.ok(processGroups.length, 'The actual surface contains process groups')
  try {
    for (const index of processGroups) {
      if (await read(`!!document.querySelector('[data-captured-process-id="surface-captured-tool"]')?.getClientRects().length`)) break
      const selector = `[data-reading-proof-group="${index}"]`
      if (await read(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-expanded') === 'false'`)) {
        await control(selector)
        await until(() => read(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-expanded') === 'true'`), 'The original process group opens')
      }
    }
    await until(() => read(`!!document.querySelector('[data-captured-process-id="surface-captured-tool"]')?.getClientRects().length`), 'Original captured process')
  } finally {
    await read(`document.querySelectorAll('[data-reading-proof-group]').forEach(node=>delete node.dataset.readingProofGroup)`)
  }
  await control('[data-captured-process-id="surface-captured-tool"] .log-row[aria-expanded]')
  assert.deepEqual(await read(`([...document.querySelectorAll('[data-captured-process-id="surface-captured-tool"] .log-diff__line')].map(line=>{
    const marker=line.querySelector('.log-diff__marker');return {
      kind:['hunk','removed','added','context'].find(kind=>line.classList.contains('log-diff__line--'+kind)),
      marker:marker?.textContent,text:[...line.childNodes].filter(node=>node!==marker).map(node=>node.textContent).join('')
    }}))`), [
    { kind: 'hunk', marker: ' ', text: '--- a/example.ts' },
    { kind: 'hunk', marker: ' ', text: '+++ b/example.ts' },
    { kind: 'hunk', marker: ' ', text: '@@ -1 +1 @@' },
    { kind: 'removed', marker: '-', text: 'const value = false' },
    { kind: 'added', marker: '+', text: 'const value = true' }
  ])
  await shot('captured-diff')
  await control('[data-captured-process-id="surface-captured-tool"] details summary')
  await copy('[data-captured-process-id="surface-captured-tool"] [aria-label="Copy tool input"]', surfaceInput)
  await copy('[data-captured-process-id="surface-captured-tool"] [aria-label="Copy tool output"]', surfaceOutput)
  await shot('captured-original')
  await control('.composer__mailbox')
  await until(() => read(`!!document.querySelector('.composer-mailbox:popover-open')`), 'Original mailbox')
  await control('.composer-mailbox [role="tab"][id$="-user-tab"]')
  const original = await until(() => read(`readingProof.originalInput('surface-human')`), 'Original typed native input history')
  const rowSelector = `.composer-mailbox [aria-label="Recorded input history"] .composer-mailbox__row[data-record-key=${JSON.stringify(original.key)}]`
  await until(() => read(`!!document.querySelector(${JSON.stringify(rowSelector)})?.getClientRects().length`), 'Original native input row')
  await read(`document.querySelector(${JSON.stringify(rowSelector)}).scrollIntoView({block:'center'})`)
  await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const row = await read(`(()=>{const node=document.querySelector(${JSON.stringify(rowSelector)}),r=node.getBoundingClientRect(),p=node.closest('.composer-mailbox').getBoundingClientRect();return {key:node.dataset.recordKey,text:node.querySelector('.composer-mailbox__preview').textContent,visible:r.width>0&&r.height>0&&r.top>=p.top&&r.bottom<=p.bottom}})()`)
  assert.deepEqual(row, { key: original.key, text: original.message.content, visible: true })
  await click(`document.querySelector(${JSON.stringify(rowSelector)})`)
  const detailSelector = `.composer-mailbox__detail[data-record-key=${JSON.stringify(original.key)}] .log-turn`
  const compact = () => read(`(()=>{const card=document.querySelector(${JSON.stringify(detailSelector)});if(!card)return null;const r=card.getBoundingClientRect();return {messageId:card.dataset.messageId,sourceKey:card.dataset.messageSourceKey,compact:card.dataset.compact,recordedIdentity:card.dataset.recordedIdentity,body:card.querySelector('.log-turn__body')?.textContent,left:r.left,right:r.right,width:r.width,viewport:innerWidth}})()`)
  const verifyCompact = snapshot => {
    assert.deepEqual({ messageId: snapshot.messageId, sourceKey: snapshot.sourceKey, compact: snapshot.compact,
      recordedIdentity: snapshot.recordedIdentity, body: snapshot.body },
    { messageId: original.key, sourceKey: original.sourceKey, compact: 'true', recordedIdentity: 'true', body: original.message.content })
    assert.ok(snapshot.width > 0 && snapshot.left >= -1 && snapshot.right <= snapshot.viewport + 1, 'The original compact card stays inside its viewport')
  }
  const wide = await until(compact, 'Original compact native input card')
  verifyCompact(wide)
  await copy(detailSelector + ' [aria-label="Copy message"]', original.message.content)
  await shot('compact-mailbox')
  let narrow
  try {
    await resize(332)
    narrow = await compact()
    await read(`readingProof.mark('compact-mailbox-narrow',${JSON.stringify(narrow)})`)
    await shot('compact-mailbox-narrow')
    verifyCompact(narrow)
    assert.equal(narrow.viewport, 332)
  } finally { await resize(1280) }
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
  return { geometry, inputHistory: { original, row, wide, narrow }, boundary: 'Provider-format native file, controlled Core captured input, original fake CLI PermissionRequest hook, and explicitly paused local intent. No dispatch or permission reply.' }
}
