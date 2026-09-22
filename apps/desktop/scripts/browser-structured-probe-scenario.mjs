import assert from 'node:assert/strict'

// Scenario hooks only. The canonical harness owns the real Desktop, Browser and ordinary restart.
const quoted = JSON.stringify
const surface = '[aria-label="Recorded structured fields"]'
const longValue = 'L'.repeat(16_000)
const longKeys = Array.from({ length: 6 }, (_, index) => `long${index + 1}`)
const expectedKeys = ['title', 'zero', 'flag', 'empty', 'invalid', 'missing', 'ambiguous', ...longKeys]
const request = { within: '#structured-scope', fields: [
  { key: 'title', type: 'string', source: { selector: '#structured-title', read: 'text' } },
  { key: 'zero', type: 'number', source: { selector: '#structured-zero', read: 'text' } },
  { key: 'flag', type: 'boolean', source: { selector: '#structured-flag', read: 'checked' } },
  { key: 'empty', type: 'string', source: { selector: '#structured-empty', read: 'value' } },
  { key: 'invalid', type: 'number', source: { selector: '#structured-invalid', read: 'text' } },
  { key: 'missing', type: 'string', source: { selector: '.absent-field', read: 'text' } },
  { key: 'ambiguous', type: 'string', source: { selector: '.repeated-field', read: 'text' } },
  ...longKeys.map(key => ({ key, type: 'string', source: { selector: '#structured-long', read: 'text' } }))
] }

export function structuredFixture(path) {
  const title = path === '/a' ? 'Section value' : 'Definition value'
  const values = `<span id="structured-title">${title}</span><span id="structured-zero">0</span>` +
    '<label>Unchecked flag<input id="structured-flag" type="checkbox"></label><label>Empty input<input id="structured-empty" value=""></label>' +
    '<span id="structured-invalid">not a number</span><span class="repeated-field">first</span><span class="repeated-field">second</span>' +
    `<span id="structured-long">${longValue}</span>`
  const shape = path === '/a' ? `<section id="structured-scope"><h2>Section fields</h2><p>${values}</p></section>`
    : `<article id="structured-scope"><h2>Definition fields</h2><dl><dt>Measured fields</dt><dd>${values}</dd></dl></article>`
  return shape + '<button id="structured-action">Count page action</button><script>globalThis.structuredActions=0;document.querySelector("#structured-action").addEventListener("click",()=>globalThis.structuredActions++)</script>'
}

const currentHistory = ctx => ctx.probe.cdp.evaluate(`window.agentmux.browser.listOperationHistory()`)
async function historyIds(ctx) { return (await currentHistory(ctx)).filter(operation => operation.browserId === ctx.browserId).map(operation => operation.id).sort() }
const actualOperation = (ctx, id) => ctx.probe.cdp.evaluate(`window.agentmux.browser.getOperation(${quoted(id)})`)
function owned(ctx, selector, pageUrl) {
  return `${ctx.selectors(selector)}.filter(element=>element.closest('.browser-surface')?.querySelector('[aria-label="Browser address"]')?.value.split('#')[0]===${quoted(pageUrl)})`
}

async function extract(ctx, pageUrl, title) {
  const report = await ctx.runBrowser(ctx.browserId, `return await extractStructured(${quoted(request)});`)
  assert.equal(report.outcome.kind, 'completed', quoted(report.outcome))
  const result = report.result, operation = report.runOperation
  assert.equal(result.kind, 'browser-structured-output')
  assert.equal(result.status, 'partial', 'Field failures are explicit and do not turn zero, false or empty into defaults')
  assert.equal(result.artifactStatus, 'available')
  assert.ok(result.artifact.id && result.artifact.byteLength > 65_536, 'The real result must require more than one bounded read')
  assert.equal(result.source.browserId, ctx.browserId)
  assert.equal(result.source.operationId, operation.id)
  assert.equal(result.source.url, pageUrl)
  assert.equal(result.source.documentUrl, pageUrl)
  assert.deepEqual(result.source.scope, { kind: 'subtree', within: '#structured-scope' })
  assert.ok(result.source.navigationId && result.source.document)
  assert.equal(result.artifact.browserId, result.source.browserId)
  assert.equal(result.artifact.operationId, result.source.operationId)
  assert.equal(result.artifact.navigationId, result.source.navigationId)
  assert.deepEqual(operation.steps.map(step => step.method), ['extractStructured'])
  assert.deepEqual(result.fields.map(field => field.key), expectedKeys)
  const fields = Object.fromEntries(result.fields.map(field => [field.key, field]))
  for (const [key, value] of [['title', title], ['zero', 0], ['flag', false], ['empty', '']]) {
    assert.equal(fields[key].status, 'observed'); assert.equal(fields[key].inline, true); assert.equal(fields[key].value, value)
  }
  for (const [key, status] of [['invalid', 'type-error'], ['missing', 'missing'], ['ambiguous', 'ambiguous']]) assert.equal(fields[key].status, status)
  for (const key of longKeys) {
    assert.equal(fields[key].status, 'observed'); assert.equal(fields[key].inline, false)
    assert.ok(Buffer.byteLength(fields[key].preview) > 0 && Buffer.byteLength(fields[key].preview) <= 256)
    assert.equal(fields[key].valueBytes, Buffer.byteLength(longValue))
    assert.equal(fields[key].value, undefined, 'The reply contains a bounded preview instead of a full long value')
  }
  assert.ok(result.work.reads > 0 && result.work.visitedElements > 0, 'Actual extraction work must be nonempty')
  assert.equal(await ctx.nativePageScript(ctx.probe, 'globalThis.structuredActions', pageUrl), 0)
  return { result, operation, title }
}

async function selectRecordedStep(ctx, saved, pageUrl) {
  if (!await ctx.probe.cdp.evaluate(`Boolean(document.querySelector('.browser-trace-rail'))`)) {
    await ctx.click(ctx.probe.cdp, owned(ctx, '.browser-operation-status__trigger', pageUrl))
    await ctx.click(ctx.probe.cdp, ctx.selectors('[aria-label="Open browser activity timeline"]'))
  }
  const startedAt = new Date(saved.operation.startedAt).toISOString()
  const item = `${ctx.selectors('.browser-rsi-history__item')}.filter(element=>element.querySelector('time')?.dateTime===${quoted(startedAt)})`
  await ctx.click(ctx.probe.cdp, item)
  const timeline = `.browser-rsi-timeline[data-operation-id=${quoted(saved.operation.id)}]`
  await ctx.waitFor('the actual retained structured operation selected', () => ctx.probe.cdp.evaluate(`Boolean(document.querySelector(${quoted(timeline)}))`))
  await ctx.click(ctx.probe.cdp, ctx.selectors(`${timeline} [data-sequence="1"] > button`))
  await ctx.waitFor('nonempty structured fields from selected step evidence', () => ctx.probe.cdp.evaluate(`document.querySelector(${quoted(surface)})?.querySelectorAll('.browser-structured-fields__values > div').length===${expectedKeys.length}`))
  const observed = await ctx.probe.cdp.evaluate(`(()=>{const root=document.querySelector(${quoted(surface)});return {summary:root.querySelector('.browser-structured-fields__summary').textContent,fields:Array.from(root.querySelectorAll('.browser-structured-fields__values > div')).map(field=>({key:field.querySelector('dt').textContent,status:field.dataset.fieldStatus,text:field.querySelector('dd').textContent,code:field.querySelector('code')?.textContent})),rawOpen:Array.from(root.querySelectorAll('details')).find(detail=>detail.querySelector('summary')?.textContent==='Recorded JSON')?.open,rawPresent:!!root.querySelector('pre'),previewNotes:Array.from(root.querySelectorAll('.browser-structured-fields__preview-note')).map(note=>note.textContent.trim())}})()`)
  assert.deepEqual(observed.fields.map(field => field.key), expectedKeys)
  for (const field of observed.fields) assert.equal(field.status, saved.result.fields.find(item => item.key === field.key).status)
  for (const [key, code] of [['title', quoted(saved.title)], ['zero', '0'], ['flag', 'false'], ['empty', '""']]) assert.equal(observed.fields.find(field => field.key === key).code, code)
  for (const key of longKeys) {
    const field = observed.fields.find(field => field.key === key)
    assert.ok(Buffer.byteLength(field.code) > 0 && Buffer.byteLength(field.code) <= 256)
    assert.doesNotMatch(field.text, /full value|full result|not saved/i)
  }
  assert.deepEqual(observed.previewNotes, ['Previews · full result in Recorded JSON'])
  assert.equal(observed.rawOpen, false); assert.equal(observed.rawPresent, false, 'The full result is lazy until the person opens Recorded JSON')
  observed.previews=await previewFacts(ctx)
  return observed
}

async function previewFacts(ctx) {
  ctx.setPhase('structured-default-preview-layout-measurement')
  // Measure the original summary and its text range. A single real line needs
  // no guessed line-height or synthetic clone; the summary owns overflow clipping.
  const facts=await ctx.probe.cdp.evaluate(`(()=>{const root=document.querySelector(${quoted(surface)});return Array.from(root.querySelectorAll('.browser-structured-fields__preview')).map(detail=>{
    const summary=detail.querySelector('summary'),code=summary.querySelector('code'),body=detail.querySelector(':scope > code'),style=getComputedStyle(summary),codeStyle=getComputedStyle(code),rect=summary.getBoundingClientRect(),range=document.createRange();
    range.selectNodeContents(code);
    const rawRects=Array.from(range.getClientRects()).map(r=>({top:r.top,left:r.left,width:r.width,height:r.height,bottom:r.bottom}));
    const tops=Array.from(new Set(rawRects.filter(r=>r.width>0&&r.height>0).map(r=>r.top))).sort((a,b)=>a-b);
    return {key:summary.getAttribute('aria-label'),open:detail.open,bodyPresent:!!body,bodyText:body?.textContent??null,summaryVisible:code.checkVisibility(),summaryText:code.textContent,whiteSpace:style.whiteSpace,codeWhiteSpace:codeStyle.whiteSpace,overflowX:style.overflowX,textOverflow:style.textOverflow,rawRects,tops,height:rect.height,width:rect.width};
  })})()`)
  ctx.receipt.structured.previewObservations??=[]
  ctx.receipt.structured.previewObservations.push(facts)
  assert.deepEqual(facts.map(item=>item.key),longKeys.map(key=>`Field preview: ${key}`),'The actual six nonempty long values have disclosures')
  for(const fact of facts){
    assert.equal(fact.open,false);assert.equal(fact.bodyPresent,false);assert.equal(fact.bodyText,null);assert.equal(fact.summaryVisible,true)
    assert.equal(fact.summaryText,'L'.repeat(256),'The original summary retains its exact bounded preview')
    assert.ok(fact.rawRects.length>0,'The original summary must produce nonempty text rectangles')
    assert.equal(fact.tops.length,1,'The default summary occupies one actual text line')
    assert.equal(fact.whiteSpace,'nowrap');assert.equal(fact.codeWhiteSpace,'nowrap')
    assert.equal(fact.overflowX,'hidden');assert.equal(fact.textOverflow,'ellipsis')
    assert.ok(fact.height>0&&fact.width>0,'The original clipping summary has positive actual geometry')
  }
  return facts
}

async function fieldsTop(ctx) {
  const facts=await ctx.probe.cdp.evaluate(`(async()=>{const root=document.querySelector(${quoted(surface)}),summary=root.querySelector('.browser-structured-fields__summary'),rail=root.closest('.browser-trace-rail');summary.scrollIntoView({block:'start'});await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));const inside=element=>{const r=element.getBoundingClientRect(),bounds=rail.getBoundingClientRect();return element.checkVisibility()&&r.width>0&&r.height>0&&r.y>=bounds.y-1&&r.bottom<=bounds.bottom+1};return {summary:summary.textContent,summaryVisible:inside(summary),fields:Array.from(root.querySelectorAll('.browser-structured-fields__values > div')).slice(0,7).map(field=>({key:field.querySelector('dt').textContent,status:field.dataset.fieldStatus,text:field.querySelector('dd').textContent,visible:inside(field)}))}})()`)
  assert.equal(facts.summary,'10 / 13 observed · Partial');assert.equal(facts.summaryVisible,true)
  assert.deepEqual(facts.fields.map(field=>field.key),expectedKeys.slice(0,7))
  for(const field of facts.fields)assert.equal(field.visible,true,`${field.key} must be visible beside the page at the actual Fields top`)
  return facts
}

async function rawUiFacts(ctx, requireVisible = false) {
  const facts=await ctx.probe.cdp.evaluate(`(()=>{const root=document.querySelector(${quoted(surface)}),pre=root.querySelector('pre'),range=root.querySelector('.browser-structured-fields__range'),button=Array.from(root.querySelectorAll('button')).find(button=>button.textContent==='Read next chunk');if(!pre||!range)throw new Error('The actual raw chunk and byte range are required');const style=getComputedStyle(pre),r=pre.getBoundingClientRect();return {aria:pre.getAttribute('aria-label'),tabIndex:pre.tabIndex,clientHeight:pre.clientHeight,scrollHeight:pre.scrollHeight,height:r.height,maxHeight:Math.min(innerHeight*.24,12*Number.parseFloat(getComputedStyle(document.documentElement).fontSize)),overflowY:style.overflowY,range:range.textContent,rangeInsidePre:pre.contains(range),nextOutsidePre:button?!pre.contains(button):null,focused:document.activeElement===pre,focusVisible:pre.matches(':focus-visible')}})()`)
  assert.equal(facts.aria,'Recorded JSON chunk');assert.equal(facts.tabIndex,0)
  assert.ok(facts.height>0&&facts.height<=facts.maxHeight+2,'The actual JSON reading region has a finite viewport/rem height')
  assert.ok(facts.scrollHeight>facts.clientHeight&&facts.clientHeight>0,'The real long chunk has an independently scrollable region')
  assert.equal(facts.overflowY,'auto');assert.equal(facts.rangeInsidePre,false)
  if(facts.nextOutsidePre!==null)assert.equal(facts.nextOutsidePre,true)
  if (requireVisible) {
    const visible = await ctx.probe.cdp.evaluate(`(()=>{const root=document.querySelector(${quoted(surface)}),rail=root.closest('.browser-trace-rail'),bounds=rail.getBoundingClientRect(),pre=root.querySelector('pre'),range=root.querySelector('.browser-structured-fields__range'),next=Array.from(root.querySelectorAll('button')).find(button=>button.textContent==='Read next chunk');const inside=element=>{const r=element.getBoundingClientRect();return {visible:element.checkVisibility()&&r.width>0&&r.height>0&&r.top>=Math.max(0,bounds.top)-1&&r.bottom<=Math.min(innerHeight,bounds.bottom)+1,top:r.top,bottom:r.bottom}};return {pre:inside(pre),range:inside(range),next:next?inside(next):null}})()`)
    assert.equal(visible.pre.visible, true, 'The actual chunk must be fully visible for its screenshot')
    assert.equal(visible.range.visible, true, 'The byte range must be visible beside the chunk')
    if (visible.next) assert.equal(visible.next.visible, true, 'The continuation control must be visible beside the chunk')
    facts.viewport = visible
  }
  return facts
}

async function keyboardReadRaw(ctx) {
  const key=async(key,code,windowsVirtualKeyCode)=>{await ctx.probe.cdp.call('Input.dispatchKeyEvent',{type:'rawKeyDown',key,code,windowsVirtualKeyCode});await ctx.probe.cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode})}
  await key('Tab','Tab',9)
  await ctx.waitFor('actual keyboard focus enters the recorded JSON region',()=>ctx.probe.cdp.evaluate(`document.activeElement===document.querySelector(${quoted(surface+' pre')})`),2000)
  const before=await ctx.probe.cdp.evaluate(`(async()=>{const pre=document.querySelector(${quoted(surface+' pre')});pre.scrollIntoView({block:'nearest'});await new Promise(done=>requestAnimationFrame(done));pre.addEventListener('keydown',event=>{globalThis.__privateStructuredRawKey={trusted:event.isTrusted,key:event.key,target:event.target.getAttribute('aria-label')}},{once:true});return {scrollTop:pre.scrollTop,focusVisible:pre.matches(':focus-visible')}})()`)
  assert.equal(before.focusVisible,true)
  await key('PageDown','PageDown',34)
  const after=await ctx.waitFor('actual keyboard scroll inside the bounded JSON region',()=>ctx.probe.cdp.evaluate(`(()=>{const pre=document.querySelector(${quoted(surface+' pre')}),scrollTop=pre.scrollTop;return scrollTop>${before.scrollTop}?{scrollTop,event:globalThis.__privateStructuredRawKey,focused:document.activeElement===pre}:null})()`),2000)
  assert.equal(after.event.trusted,true);assert.equal(after.event.key,'PageDown');assert.equal(after.event.target,'Recorded JSON chunk');assert.equal(after.focused,true)
  await ctx.probe.cdp.evaluate('delete globalThis.__privateStructuredRawKey;null')
  return {before,after}
}

async function readRecordedJson(ctx, saved, captureUi = false) {
  const idsBefore = await historyIds(ctx), operationBefore = await actualOperation(ctx, saved.operation.id)
  await ctx.click(ctx.probe.cdp, `${ctx.selectors(surface + ' summary')}.filter(element=>element.textContent==='Recorded JSON')`)
  const chunks = [], chunkCount = Math.ceil(saved.result.artifact.byteLength / 65_536)
  let offset = 0
  for (let index = 0; index < chunkCount; index++) {
    const chunk = await ctx.waitFor(`actual retained JSON bytes from offset ${offset}`, () => ctx.probe.cdp.evaluate(`(()=>{const root=document.querySelector(${quoted(surface)}),range=root?.querySelector('.browser-structured-fields__range')?.textContent,text=root?.querySelector('pre')?.textContent;if(!range||!text)return null;const match=/^Bytes (\\d+)–(\\d+) of (\\d+)$/.exec(range);return match&&Number(match[1])===${offset}?{offset:Number(match[1]),end:Number(match[2]),total:Number(match[3]),text}:null})()`))
    assert.equal(chunk.total, saved.result.artifact.byteLength)
    assert.ok(chunk.end - chunk.offset + 1 <= 65_536)
    assert.equal(Buffer.byteLength(chunk.text), chunk.end - chunk.offset + 1, 'This ASCII fixture exposes the actual byte bound in the rendered chunk')
    chunks.push(chunk); offset = chunk.end + 1
    if(index===0){
      ctx.receipt.structured.rawUiReads??=[]
      const read={operationId:saved.operation.id,...await rawUiFacts(ctx)}
      ctx.receipt.structured.rawUiReads.push(read)
      if(captureUi){
        read.keyboard=await keyboardReadRaw(ctx)
        ctx.receipt.structured.rawSizeFacts=[]
        for(const [size,width,height] of [['normal',1440,900],['narrow',1000,720],['short',1000,660]]){
          await ctx.resize(ctx.probe,width,height)
          // Resizing changes the existing rail's scroll position. Scroll its real
          // disclosure into view; never alter styles or compose a synthetic image.
          await ctx.probe.cdp.evaluate(`(async()=>{document.querySelector(${quoted(surface+' pre')}).closest('details').querySelector(':scope > summary').scrollIntoView({block:'start'});await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));return true})()`)
          ctx.receipt.structured.rawSizeFacts.push({size,...await rawUiFacts(ctx, true)})
          ctx.setPhase('structured-bounded-raw-json-capture')
          await ctx.capture(ctx.probe,`${size}-structured-bounded-recorded-json`,'structured-output')
        }
        await ctx.resize(ctx.probe,1440,900)
      }
    }
    if (index + 1 < chunkCount) await ctx.click(ctx.probe.cdp, `${ctx.selectors(surface + ' button')}.filter(element=>element.textContent==='Read next chunk')`)
  }
  assert.equal(offset, saved.result.artifact.byteLength)
  assert.ok(chunks.length > 1, 'The product actually consumes the continuation UI')
  const document = JSON.parse(chunks.map(chunk => chunk.text).join(''))
  assert.equal(document.schema, 'browser-structured-output.v1'); assert.deepEqual(document.source, saved.result.source)
  assert.deepEqual(document.request, request)
  assert.equal(document.fields.find(field => field.key === 'title').value, saved.title)
  for (const key of longKeys) assert.equal(document.fields.find(field => field.key === key).value, longValue)
  assert.deepEqual(await historyIds(ctx), idsBefore, 'Opening a retained result cannot start another Browser operation')
  assert.deepEqual(await actualOperation(ctx, saved.operation.id), operationBefore, 'Reading recorded JSON cannot execute or rewrite its original step')
  return { chunks, source: document.source, schema: document.schema, byteLength: saved.result.artifact.byteLength, noReexecution: true }
}

async function navigate(ctx, url) {
  const addresses = ctx.selectors('[aria-label="Browser address"]')
  ctx.setPhase('structured-actual-toolbar-navigation')
  await ctx.probe.cdp.evaluate(`(()=>{const matches=(${addresses});if(matches.length!==1)throw new Error('The actual address control must be unique');const input=matches[0],events=[],identity=element=>({tag:element?.tagName,aria:element?.getAttribute?.('aria-label'),id:element?.id});const read=()=>({value:input.value,selectionStart:input.selectionStart,selectionEnd:input.selectionEnd,focused:document.activeElement===input,documentFocused:document.hasFocus(),active:identity(document.activeElement),connected:input.isConnected,events:events.slice()});const listener=event=>{if(events.length<32)events.push({type:event.type,trusted:event.isTrusted,key:event.key,inputType:event.inputType,target:identity(event.target),value:input.value,selectionStart:input.selectionStart,selectionEnd:input.selectionEnd,focused:document.activeElement===input})};const types=['pointerdown','focusin','focusout','keydown','keyup','beforeinput','input','change','submit'];for(const type of types)document.addEventListener(type,listener,true);globalThis.__privateStructuredNavigation={read,dispose:()=>{for(const type of types)document.removeEventListener(type,listener,true)}};return true})()`)
  const read = () => ctx.probe.cdp.evaluate('globalThis.__privateStructuredNavigation.read()')
  const attempt = { wanted: url, before: await read(), input: 'Real CDP keyboard events into the clicked address; no DOM focus/value or event assignment' }
  ctx.receipt.structured.navigationAttempts ??= []; ctx.receipt.structured.navigationAttempts.push(attempt)
  try {
    await ctx.click(ctx.probe.cdp, addresses)
    attempt.afterClick = await read()
    assert.equal(attempt.afterClick.focused, true, 'The actual clicked address must hold DOM focus before keyboard input')
    await ctx.probe.cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4, commands: ['selectAll'] })
    await ctx.probe.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 })
    attempt.afterSelectAll = await read()
    assert.equal(attempt.afterSelectAll.focused, true)
    assert.equal(attempt.afterSelectAll.selectionStart, 0); assert.equal(attempt.afterSelectAll.selectionEnd, attempt.afterSelectAll.value.length)
    await ctx.probe.cdp.call('Input.insertText', { text: url })
    attempt.afterInsert = await read()
    assert.equal(attempt.afterInsert.value, url, 'Real text insertion must replace the selected address')
    assert.ok(attempt.afterInsert.events.some(event => event.type === 'input' && event.trusted && event.target.aria === 'Browser address'), 'The actual address must consume a trusted input event')
    // Puppeteer's maintained CDP keyboard sends Enter's text as well as keyCode.
    // https://github.com/puppeteer/puppeteer/blob/main/packages/puppeteer-core/src/cdp/Input.ts
    await ctx.probe.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' })
    await ctx.probe.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    attempt.afterEnter = await read()
    assert.ok(attempt.afterEnter.events.some(event => event.type === 'submit' && event.trusted), 'The actual Browser form must consume a trusted submission')
    await ctx.waitFor('real toolbar navigation to the second generic document', () => ctx.nativePageScript(ctx.probe, 'document.readyState===\'complete\'&&document.querySelector(\'#structured-scope\')!==null', url).catch(() => false))
    attempt.actualNavigation = true
    ctx.setPhase('structured-navigation-native-frame-ready')
    attempt.nativeFrameReady = await ctx.nativeFrameReady(url)
  } finally {
    attempt.final = await read()
    await ctx.probe.cdp.evaluate('globalThis.__privateStructuredNavigation.dispose();delete globalThis.__privateStructuredNavigation;null')
  }
}

export async function reviewStructuredOutput(ctx) {
  const first = await extract(ctx, ctx.pageUrl, 'Section value')
  ctx.receipt.structured = { input: 'public Core browser.run → actual Main extractStructured → Journal evidence → Renderer fields and existing result reader', physicalDeviceTested: false, first }
  ctx.receipt.structured.fields = await selectRecordedStep(ctx, first, ctx.pageUrl)
  ctx.receipt.structured.fieldsTop=[]
  for (const [size, width, height] of [['normal',1440,900],['narrow',1000,720],['short',1000,660]]) {
    await ctx.resize(ctx.probe, width, height)
    ctx.receipt.structured.fieldsTop.push({size,...await fieldsTop(ctx),previews:await previewFacts(ctx)})
    ctx.setPhase('structured-fields-top-capture')
    await ctx.capture(ctx.probe, `${size}-structured-fields-top`, 'structured-output')
  }
  await ctx.resize(ctx.probe,1440,900)
  const historyBeforePreview=await historyIds(ctx)
  ctx.setPhase('structured-real-preview-disclosure')
  await ctx.click(ctx.probe.cdp,ctx.selectors('[aria-label="Field preview: long1"]'))
  await ctx.waitFor('the original native disclosure and its rendered retained preview', () => ctx.probe.cdp.evaluate(`(()=>{const summary=document.querySelector('[aria-label="Field preview: long1"]'),detail=summary?.parentElement,body=detail?.querySelector(':scope > code');return detail?.open===true&&body?.checkVisibility()===true})()`))
  ctx.receipt.structured.expandedPreview=await ctx.probe.cdp.evaluate(`(()=>{const summary=document.querySelector('[aria-label="Field preview: long1"]'),detail=summary.parentElement,body=detail.querySelector(':scope > code');return {open:detail.open,visible:body.checkVisibility(),text:body.textContent,rawPresent:!!document.querySelector(${quoted(surface+' pre')})}})()`)
  assert.equal(ctx.receipt.structured.expandedPreview.open,true);assert.equal(ctx.receipt.structured.expandedPreview.visible,true)
  assert.equal(ctx.receipt.structured.expandedPreview.text,first.result.fields.find(field=>field.key==='long1').preview)
  assert.equal(ctx.receipt.structured.expandedPreview.rawPresent,false)
  await ctx.capture(ctx.probe,'normal-structured-expanded-preview','structured-output')
  await ctx.click(ctx.probe.cdp,ctx.selectors('[aria-label="Field preview: long1"]'))
  await ctx.waitFor('the original disclosure closed and its one-line summary rendered', () => ctx.probe.cdp.evaluate(`(()=>{const summary=document.querySelector('[aria-label="Field preview: long1"]'),detail=summary?.parentElement;return detail?.open===false&&detail.querySelector(':scope > code')===null&&summary.querySelector('code')?.checkVisibility()===true})()`))
  assert.deepEqual(await historyIds(ctx),historyBeforePreview,'Preview disclosure cannot start a Browser operation')
  await previewFacts(ctx)
  // Changing this private fixture is a test input. No application fact or storage is seeded.
  await ctx.nativePageScript(ctx.probe, 'document.querySelector("#structured-title").textContent="Later live DOM value";null')
  ctx.receipt.structured.firstRaw = await readRecordedJson(ctx, first, true)
  await navigate(ctx, ctx.urls[1])
  const second = await extract(ctx, ctx.urls[1], 'Definition value')
  assert.notEqual(second.result.source.navigationId, first.result.source.navigationId)
  assert.notEqual(second.result.artifact.id, first.result.artifact.id)
  ctx.receipt.structured.second = second
  ctx.receipt.structured.secondFields = await selectRecordedStep(ctx, second, ctx.urls[1])
  ctx.receipt.structured.secondFieldsTop = await fieldsTop(ctx)
  ctx.setPhase('structured-second-document-native-capture')
  await ctx.capture(ctx.probe, 'normal-second-dom-structured-fields', 'structured-output', ctx.urls[1])
  ctx.receipt.structured.secondRaw = await readRecordedJson(ctx, second)
  await selectRecordedStep(ctx, first, ctx.urls[1])
  ctx.receipt.structured.firstRawAfterNavigation = await readRecordedJson(ctx, first)
  assert.deepEqual(ctx.receipt.structured.firstRawAfterNavigation.chunks, ctx.receipt.structured.firstRaw.chunks)
  ctx.receipt.structured.navigationKeptArtifact = true
  await navigate(ctx, ctx.pageUrl)
  ctx.receipt.structured.operationsBeforeRestart = await historyIds(ctx)
  // The completed call reply is a transient projection; Journal owns persisted
  // timestamps and replay summaries. Compare that same durable fact across quit.
  const retained = await actualOperation(ctx, first.operation.id)
  assert.equal(retained?.id, first.operation.id)
  assert.equal(retained.browserId, ctx.browserId)
  assert.deepEqual(retained.steps.map(step => step.method), ['extractStructured'])
  assert.equal(retained.steps[0].status, 'completed')
  assert.ok(retained.steps[0].evidence.length > 0, 'The retained extraction must contain its actual evidence before restart')
  ctx.receipt.structured.retainedOperationBeforeRestart = retained
}

export async function recoverStructuredOutput(ctx) {
  ctx.setPhase('structured-recorded-result-after-ordinary-restart')
  const saved = ctx.receipt.structured.first
  assert.deepEqual(await historyIds(ctx), ctx.receipt.structured.operationsBeforeRestart)
  const operation = await actualOperation(ctx, saved.operation.id)
  assert.equal(operation.browserId, ctx.browserId)
  assert.deepEqual(operation, ctx.receipt.structured.retainedOperationBeforeRestart, 'Ordinary restart must preserve the exact durable operation')
  ctx.receipt.structured.restoredFields = await selectRecordedStep(ctx, saved, ctx.pageUrl)
  ctx.receipt.structured.restoredFieldsTop = await fieldsTop(ctx)
  ctx.receipt.structured.rawAfterRestart = await readRecordedJson(ctx, saved)
  assert.deepEqual(ctx.receipt.structured.rawAfterRestart.chunks, ctx.receipt.structured.firstRaw.chunks)
  assert.equal(await ctx.nativePageScript(ctx.probe, 'globalThis.structuredActions'), 0)
  ctx.receipt.structured.sameArtifactAfterRestart = true
  // Read persistence independently of the subsequent native geometry/image gate.
  // A capture failure must not hide whether the real retained bytes were read.
  ctx.receipt.structured.restoredLayout = await ctx.probe.cdp.evaluate(`(()=>{const surface=document.querySelector(${quoted(surface)}),browser=surface.closest('.browser-surface'),stage=browser.querySelector('[data-native-browser-stage]'),region=browser.closest('.workbench-region'),rect=element=>{const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};return {viewport:{width:innerWidth,height:innerHeight,devicePixelRatio},uiZoomFactor:window.agentmux.ui.getZoomFactor(),fonts:document.fonts.status,stage:rect(stage),region:region?rect(region):null,toolbar:rect(browser.querySelector('.browser-toolbar'))}})()`)
  await fieldsTop(ctx)
  ctx.setPhase('structured-restored-native-page-frame')
  await ctx.nativeFrameReady(ctx.pageUrl)
  await ctx.capture(ctx.probe, 'normal-structured-fields-after-ordinary-restart', 'structured-output')
  await ctx.probe.cdp.evaluate(`(async()=>{document.querySelector(${quoted(surface+' pre')}).closest('details').querySelector(':scope > summary').scrollIntoView({block:'start'});await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));return true})()`)
  await rawUiFacts(ctx, true)
  await ctx.nativeFrameReady(ctx.pageUrl)
  await ctx.capture(ctx.probe, 'normal-structured-result-after-ordinary-restart', 'structured-output')
  ctx.receipt.structured.complete = true
}
