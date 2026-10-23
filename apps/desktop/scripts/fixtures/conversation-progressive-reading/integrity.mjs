import assert from 'node:assert/strict'
import { integrityCode } from './scene.mjs'

export const integrityPayload = 'integrity captured original payload'
export const integrityCapturedId = 'integrity-captured-tool'
export function integrityCaptured(agentSessionId, recordedAt) {
  return { id: integrityCapturedId, agentSessionId, kind: 'tool_call', status: 'complete', source: 'agentmux',
    title: 'Original captured reading target', toolName: 'controlled_read', toolInput: '{"original":true}',
    toolOutput: integrityPayload, createdAt: recordedAt, updatedAt: recordedAt }
}

/** The existing private App and original Core records; all actions use native
 * input. DOM access observes the real result and prepares focus, not handlers. */
export async function exerciseIntegrity({ read, click, shot, until, native, append, appendRow, phase }) {
  const result = { nativeInputs: [], query: null, navigation: [], captured: null, follow: null }
  const ready = (expression, label) => until(() => read(expression), label ?? expression)
  // The production reader pins this existing content-end sentinel. Physical
  // scrollHeight also includes the feed's padding and non-reading affordances.
  const tailGeometry = `(()=>{
    const f=document.querySelector('.activity-feed'),tails=f?.querySelectorAll('[data-conversation-reading-tail]');
    if(!f||tails.length!==1||!tails[0].isConnected||!f.checkVisibility()||f.clientHeight<=0)throw Error('The unique original reading tail needs a visible viewport');
    const viewport=f.getBoundingClientRect(),end=tails[0].getBoundingClientRect().top;
    const readingHeight=Math.max(f.clientHeight,f.scrollTop+end-viewport.top);
    return {tailDistance:readingHeight-f.clientHeight-f.scrollTop,physicalTailDistance:f.scrollHeight-f.clientHeight-f.scrollTop,
      readingTailTop:end,viewportBottom:viewport.top+f.clientHeight,scrollTop:f.scrollTop,scrollHeight:f.scrollHeight,clientHeight:f.clientHeight,consumer:readingProof.consumer()};})()`
  const key = async (key, code, virtualKey, modifiers = 0) => {
    for (const type of ['keyDown', 'keyUp']) await native('Input.dispatchKeyEvent',
      { type, key, code, windowsVirtualKeyCode: virtualKey, modifiers,
        ...(type === 'keyDown' && key === 'a' && modifiers === 4 ? { commands: ['selectAll'] } : {}) })
  }
  const query = async text => {
    await key('a', 'KeyA', 65, 4)
    await native('Input.insertText', { text })
    await ready(`document.querySelector('.reading-find__tools input')?.value === ${JSON.stringify(text)}`, 'Native text enters the original Find input')
    return ready(`(()=>{const text=document.querySelector('.reading-find__count')?.textContent;const count=text?.match(new RegExp('^([0-9]+) / ([0-9]+)$'));return count&&Number(count[2])>0?{index:Number(count[1]),total:Number(count[2])}:null})()`, 'Original loaded-body Find has a real nonzero result')
  }
  const currentMatch = () => read(`(()=>{
    const entry=[...CSS.highlights].find(([name])=>name.endsWith('-current'));
    const range=entry&&[...entry[1]][0];if(!range)return null;
    const node=range.startContainer.parentElement,body=node.closest('[data-native-record-id]'),feed=document.querySelector('.activity-feed');
    const box=range.getBoundingClientRect(),viewport=feed.getBoundingClientRect();
    return {recordId:body?.dataset.nativeRecordId,text:range.toString(),connected:range.startContainer.isConnected,
      visible:box.height>0&&box.bottom>viewport.top&&box.top<viewport.bottom};})()`)
  await read(`(()=>{window.integrityInputs=[];window.integrityObserve=e=>integrityInputs.push({type:e.type,trusted:e.isTrusted,key:e.key??null,meta:e.metaKey??false,target:e.target?.tagName});for(const type of ['keydown','keyup','input'])document.addEventListener(type,integrityObserve,true)})()`)
  try {
    await ready('(()=>{const c=readingProof.consumer();return c&&!c.loading&&!c.inFlight&&!c.held&&!c.watch.binding&&c.watch.bound})()', 'Original current frame and its own observer settle')
    const beforeCut = await read('readingProof.nativeCut()'), row = appendRow('integrity', `follow-${phase}`)
    await append([row])
    await ready(`readingProof.appendDisposition(${JSON.stringify(beforeCut)},${JSON.stringify(row.payload.id)},false)`, 'A bottom-following native append reaches this original accepted frame')
    const appendedSelector = `.conversation-native-thread__record[data-native-record-id=${JSON.stringify(row.payload.id)}]`
    const appendedBody = row.payload.content[0].text
    await ready(`(()=>{const b=document.querySelector(${JSON.stringify(appendedSelector + ' .log-turn__body')});return b?.isConnected&&b.checkVisibility()&&b.textContent===${JSON.stringify(appendedBody)}})()`, 'The original appended short answer is actually presented')
    result.follow = { recordId: row.payload.id, ...await read(tailGeometry) }
    result.follow.appendedVisible = await read(`(()=>{const f=document.querySelector('.activity-feed'),n=f.querySelector(${JSON.stringify(appendedSelector)}),b=n?.querySelector('.log-turn__body');if(!b||!b.checkVisibility()||b.textContent!==${JSON.stringify(appendedBody)})return false;const r=n.getBoundingClientRect(),v=f.getBoundingClientRect();return r.height>0&&r.top>=v.top&&r.bottom<=v.top+f.clientHeight})()`)
    assert.equal(result.follow.appendedVisible, true, 'The complete original appended answer is visible at the reading tail')
    assert.ok(result.follow.tailDistance <= 2, 'A live original append preserves bottom following')
    await read(`document.querySelector('.reading-find__content').focus({preventScroll:true});window.integrityOpener=document.activeElement`)
    await key('f', 'KeyF', 70, 4)
    await ready(`document.activeElement===document.querySelector('.reading-find__tools input')`, 'Native Meta+F opens and focuses this loaded conversation')
    // Let only the already visible scheduled work settle before measuring query demand.
    await read(`new Promise((resolve,reject)=>{let prior=-1,stable=0,frames=0;function tick(){const count=readingProof.metrics.heavyMounts.length;stable=count===prior?stable+1:0;prior=count;if(stable===12)return resolve(true);if(++frames>180)return reject(Error('Visible scheduled bodies did not settle'));requestAnimationFrame(tick)}requestAnimationFrame(tick)})`)
    const before = await read(`(()=>{const rows=[...document.querySelectorAll('.conversation-native-thread__record[data-native-record-id^="integrity-answer-"]')];return {records:rows.map(n=>n.dataset.nativeRecordId),deferred:rows.filter(n=>n.querySelector('[data-conversation-body-presented="false"]')).map(n=>n.dataset.nativeRecordId),mounted:rows.filter(n=>n.querySelector('[data-conversation-body-presented="true"]')).map(n=>n.dataset.nativeRecordId),reads:readingProof.reads.length}})()`)
    assert.ok(before.records.length > 1 && before.deferred.length > 1, 'The original loaded frame includes multiple unmounted fenced answers')
    const count = await query(integrityCode)
    assert.equal(count.total, before.records.length, 'Find includes each original loaded fenced answer, including deferred bodies')
    const after = await read(`(()=>{const rows=[...document.querySelectorAll('.conversation-native-thread__record[data-native-record-id^="integrity-answer-"]')];return {mounted:rows.filter(n=>n.querySelector('[data-conversation-body-presented="true"]')).map(n=>n.dataset.nativeRecordId),deferred:rows.filter(n=>n.querySelector('[data-conversation-body-presented="false"]')).map(n=>n.dataset.nativeRecordId),reads:readingProof.reads.length}})()`)
    assert.deepEqual(after.mounted, before.mounted, 'Query does not mount every loaded heavy body')
    assert.equal(after.reads, before.reads, 'Query does not read hidden history, resources or another Session')
    result.query = { before, count, after }
    await shot('find-loaded')
    for (const [direction, modifiers] of [['next', 0], ['previous', 8]]) {
      await key('Enter', 'Enter', 13, modifiers)
      const match = await until(async () => { const value = await currentMatch(); return value?.connected && value.visible && value.recordId && value.text === integrityCode ? value : null }, 'Native Find navigation reveals its exact original fenced body')
      assert.ok(before.records.includes(match.recordId))
      result.navigation.push({ direction, ...match })
    }
    assert.notEqual(result.navigation[0].recordId, result.navigation[1].recordId)
    await shot('find-code')
    await key('Escape', 'Escape', 27)
    await ready(`!document.querySelector('.reading-find__tools')&&document.activeElement===integrityOpener`, 'Native Escape closes Find and returns its original focus')
    result.focus = await read(`({returned:document.activeElement===integrityOpener,tag:document.activeElement.tagName})`)
    await click(`document.querySelector('.conversation-ruler__window[aria-label^="History window:"]')`)
    await ready(`!![...document.querySelectorAll('[role="menuitemradio"]')].find(n=>n.textContent==='All · bounded reading')`)
    await click(`[...document.querySelectorAll('[role="menuitemradio"]')].find(n=>n.textContent==='All · bounded reading')`)
    await ready(`document.querySelector('[aria-label="History window: All"]')&&(()=>{const c=readingProof.consumer();return c&&!c.loading&&!c.inFlight&&!c.watch.binding})()`, 'The original bounded all-time ruler settles without inventing a time domain')
    const group = `([...document.querySelectorAll('[data-conversation-process-members]')].find(n=>JSON.parse(n.dataset.conversationProcessMembers).some(m=>m.sources.some(reference=>reference.source.kind==='captured'&&reference.source.recordId===${JSON.stringify(integrityCapturedId)}))))`
    const initial = await read(`(()=>{const n=${group};if(!n)return null;n.dataset.integrityProcessGroup='true';return {expanded:n.querySelector('.wf-head').getAttribute('aria-expanded'),mounted:!!n.querySelector('[data-captured-process-id="${integrityCapturedId}"]')}})()`)
    assert.deepEqual(initial, { expanded: 'false', mounted: false }, 'The captured original starts in an unread folded process group')
    const reveal = async () => {
      await read(`document.querySelector('.activity-ruler__track').focus({preventScroll:true})`)
      await key('Home', 'Home', 36)
      await key('End', 'End', 35)
      const count = await read(`Number(document.querySelector('.activity-ruler__track').getAttribute('aria-valuemax'))`)
      assert.ok(Number.isInteger(count) && count > 1)
      for (let step = 0; step < count; step++) {
        await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
        const shown = await read(`(()=>{const n=document.querySelector('[data-captured-process-id="${integrityCapturedId}"]'),g=document.querySelector('[data-integrity-process-group]'),f=document.querySelector('.activity-feed');if(!n)return null;const r=n.getBoundingClientRect(),v=f.getBoundingClientRect();return g.querySelector('.wf-head').getAttribute('aria-expanded')==='true'&&n.querySelector('.wf-tool-row').getAttribute('aria-expanded')==='true'&&n.textContent.includes(${JSON.stringify(integrityPayload)})&&r.height>0&&r.bottom>v.top&&r.top<v.bottom?{id:n.dataset.capturedProcessId,body:n.querySelector('.wf-native-process__body').textContent,source:n.dataset.messageSourceKey,selected:document.querySelector('.activity-ruler__track').getAttribute('aria-valuenow'),navigationSteps:${step + 1}}:null})()`)
        if (shown) return shown
        await key('ArrowLeft', 'ArrowLeft', 37)
      }
      assert.fail('Native ruler navigation did not reveal the exact previously folded captured payload')
    }
    const first = await reveal()
    await read(`window.integrityCapturedOriginal=document.querySelector('[data-captured-process-id="${integrityCapturedId}"]')`)
    await shot('ruler-captured')
    await click(`document.querySelector('[data-integrity-process-group] .wf-head')`)
    assert.equal(await read(`document.querySelector('[data-integrity-process-group] .wf-head').getAttribute('aria-expanded')`), 'false')
    const reopened = await reveal()
    const sameNode = await read(`document.querySelector('[data-captured-process-id="${integrityCapturedId}"]')===integrityCapturedOriginal`)
    assert.equal(sameNode, true)
    await shot('ruler-reopened')
    await read(`document.querySelector('.reading-find__content').focus({preventScroll:true})`)
    await key('f', 'KeyF', 70, 4)
    await ready(`document.activeElement===document.querySelector('.reading-find__tools input')`)
    const payloadCount = await query(integrityPayload)
    assert.equal(payloadCount.total, 1, 'The shared captured payload is searchable once under its original record')
    await key('Enter', 'Enter', 13)
    await ready(`(()=>{const h=[...CSS.highlights].find(([name])=>name.endsWith('-current'));return h&&[...h[1]].some(r=>r.toString()===${JSON.stringify(integrityPayload)}&&r.startContainer.parentElement.closest('[data-captured-process-id="${integrityCapturedId}"]'))})()`, 'Find highlights the exact captured tool payload')
    await shot('find-captured')
    await key('Escape', 'Escape', 27)
    await ready(`!document.querySelector('.reading-find__tools')`)
    result.captured = { initial, first, reopened, sameNode, payloadCount }
    if (await read('!!document.querySelector(".activity-feed__jump")')) await click('document.querySelector(".activity-feed__jump")')
    await ready(`(()=>{const t=${tailGeometry};return !t.consumer?.held&&t.tailDistance<=2})()`, 'Current returns the original accepted reading window to its tail')
    result.current = await read(tailGeometry)
  } finally {
    result.nativeInputs = await read(`(()=>{for(const type of ['keydown','keyup','input'])document.removeEventListener(type,integrityObserve,true);return integrityInputs})()`)
  }
  assert.ok(result.nativeInputs.length > 0 && result.nativeInputs.every(event => event.trusted))
  assert.ok(result.nativeInputs.some(event => event.type === 'keydown' && event.key === 'f' && event.meta))
  assert.ok(result.nativeInputs.some(event => event.type === 'input'))
  return result
}
