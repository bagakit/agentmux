const assert = require('node:assert/strict')

/** Actual product UI operations; private preview API facts do not prove Native delivery. */
module.exports = async function messageFeedback({ win, evaluate, waitFor, visible, painted, click, key, seed, capture, result, surface }) {
  result.captureOnly = true; result.aestheticReview = 'not-performed'; result.feedback = []
  const composer = `${surface}.querySelector('.composer')`, editor = `${composer}.querySelector('[role="textbox"]')`
  const toggle = `${composer}.querySelector('.composer-tool--mode')`, trigger = `${composer}.querySelector('.composer__mailbox')`
  const mailbox = `${composer}.querySelector('.composer-mailbox')`, dock = `document.querySelector('.composer-pending__notice')`
  async function draft(text) {
    await click(editor)
    for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65 })
    await win.webContents.debugger.sendCommand('Input.insertText', { text })
    await waitFor(`${editor}.textContent.includes(${JSON.stringify(text.split('\n').at(-1))})`)
  }
  async function frame(width, state) {
    await painted(); const file = `${width}-feedback-${state}.png`, png = await capture(file.slice(0, -4))
    result.frames.push({ width, state, file, png })
  }
  async function compact(expression) {
    const observed = await evaluate(`(()=>{const e=${expression},c=${composer};
      const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}}
      return {card:rect(e),composer:rect(c),heading:rect(e.querySelector('.message-delivery-failure__heading')),
        actions:rect(e.querySelector('.message-delivery-failure__actions')),detailsOpen:e.querySelector('details').open,
        primaryState:!!e.querySelector(':scope > .message-delivery-failure__state'),
        buttons:Array.from(e.querySelector('.message-delivery-failure__actions').querySelectorAll('button')).map(b=>({rect:rect(b),font:parseFloat(getComputedStyle(b).fontSize),label:b.textContent,hit:document.elementFromPoint(b.getBoundingClientRect().x+b.clientWidth/2,b.getBoundingClientRect().y+b.clientHeight/2)?.closest('button')===b}))}
    })()`)
    assert.equal(observed.detailsOpen, false, 'The actual diagnostic starts folded')
    assert.equal(observed.primaryState, false, 'The actual reminder has no repeated multi-line state block')
    assert.ok(observed.card.height <= 76, 'The actual primary reminder stays within two readable rows')
    assert.ok(observed.buttons.length >= 1, 'The original compact actions are nonempty')
    for (const button of observed.buttons) { assert.ok(button.font >= 11 && button.rect.width > 0 && button.hit, 'Actual compact actions remain readable and operable') }
    return observed
  }
  for (const width of [640, 320]) {
    await evaluate(`identityMenu.appearance(${JSON.stringify(width === 640 ? 'dark' : 'light')})`)
    await seed(width); await waitFor(visible(editor)); await draft('Keep this unsent original draft.')
    const scenario = await evaluate(`identityMenu.messageFeedback('tool')`)
    await click(toggle); await waitFor(`${composer}.querySelector('.composer-tools').dataset.mode==='current'`)
    await evaluate(`${editor}.focus()`)
    await evaluate('document.fonts.ready.then(()=>true)'); await painted()
    await new Promise(resolve => setTimeout(resolve, 250)); await painted()
    await evaluate(`window.originalFeedbackEditor=${editor}`)
    const before = await evaluate(`({terminal:identityMenu.terminal(),draft:${editor}.textContent,drafts:identityMenu.facts().drafts})`)
    await click(`${composer}.querySelector('[aria-label="Reference files for the Agent to read"]')`)
    await waitFor(visible(`${dock}?.querySelector('.message-delivery-failure')`)); await painted()
    const state = await compact(`${dock}.querySelector('.message-delivery-failure')`)
    result.feedbackCurrent = { width, state }
    await frame(width, 'tools-failed')
    assert.ok(Math.abs(state.card.right - state.composer.right) <= 2, 'The actual reminder docks at the original composer right edge')
    assert.equal(await evaluate(`${composer}.querySelectorAll('.composer-feedback').length`), 0, 'The original editor has no duplicate large error block')
    assert.deepEqual(await evaluate(`({terminal:identityMenu.terminal(),draft:${editor}.textContent,drafts:identityMenu.facts().drafts})`), before, 'Failure preserves original terminal geometry, cursor and both exact drafts')
    assert.equal(await evaluate(`window.originalFeedbackEditor===${editor}`), true, 'Failure preserves the original editing DOM')
    assert.equal(await evaluate(`document.activeElement===${composer}.querySelector('[aria-label="Reference files for the Agent to read"]')`), true, 'Failure does not steal focus from the original user-invoked tool')
    await click(toggle); await waitFor(`${composer}.querySelector('.composer-tools').dataset.mode==='expanded'`)
    await draft('Original long draft.\nKeep the current operation.\nKeep every saved message.\nReview the complete diagnostic.\nThis draft remains unsent.')
    await compact(`${dock}.querySelector('.message-delivery-failure')`); await frame(width, 'expanded-failed')
    await click(toggle); await waitFor(`${composer}.querySelector('.composer-tools').dataset.mode==='collapsed'`)
    await compact(`${dock}.querySelector('.message-delivery-failure')`); await frame(width, 'one-line-failed')
    const report = await evaluate(`${dock}.querySelector('pre').textContent`)
    assert.ok(report.includes(scenario.raw), 'The actual complete diagnostic retains the original raw error and tail')
    for (const identity of Object.values(scenario.identities)) assert.ok(report.includes(identity), 'The actual diagnostic retains every original identity')
    await click(`${dock}.querySelector('summary')`); await painted()
    const tail = await evaluate(`(()=>{const pre=${dock}.querySelector('pre'),cards=${dock}.closest('.composer-pending__cards'),text=pre.firstChild;
      const offset=text.textContent.lastIndexOf('original-diagnostic-tail-完整');if(offset<0)throw new Error('Original diagnostic tail absent');
      cards.scrollTop=cards.scrollHeight;const range=document.createRange();range.setStart(text,offset);range.setEnd(text,offset+'original-diagnostic-tail-完整'.length);
      pre.scrollTop+=range.getBoundingClientRect().top-Math.max(pre.getBoundingClientRect().top,cards.getBoundingClientRect().top)-24;
      const r=range.getBoundingClientRect(),p=pre.getBoundingClientRect(),c=cards.getBoundingClientRect();
      return {text:range.toString(),preScrollTop:pre.scrollTop,cardsScrollTop:cards.scrollTop,visible:r.top>=Math.max(p.top,c.top)&&r.bottom<=Math.min(p.bottom,c.bottom)}
    })()`)
    assert.equal(tail.visible, true, 'The original diagnostic scrollport can expose the complete retained tail')
    result.diagnosticTails??=[];result.diagnosticTails.push({width,...tail})
    await frame(width, 'diagnostic-open')
    await evaluate(`${dock}.closest('.composer-pending__cards').scrollTo({top:0});${dock}.querySelector('pre').scrollTo({top:0})`);await painted()
    const copyRect = () => evaluate(`(()=>{const r=${dock}.querySelector('.message-delivery-failure__copy').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`)
    const copyBefore=await copyRect()
    await evaluate('identityMenu.failFeedbackCopy(true)'); await click(`${dock}.querySelector('[aria-label="复制完整诊断"]')`)
    await waitFor(`${dock}.querySelector('[data-copy-state]').dataset.copyState==='failed'`); await frame(width, 'copy-failed')
    assert.deepEqual(await copyRect(),copyBefore,'Copy refusal preserves the original hit area')
    await evaluate('identityMenu.failFeedbackCopy(false)'); await click(`${dock}.querySelector('[aria-label="复制完整诊断"]')`)
    await waitFor(`${dock}.querySelector('[data-copy-state]').dataset.copyState==='copied'`)
    assert.deepEqual(await copyRect(),copyBefore,'Copy confirmation preserves the original hit area')
    assert.equal(await evaluate('identityMenu.facts().clipboard.at(-1)'), report, 'The actual clipboard consumer receives every original diagnostic byte')
    await frame(width, 'copy-confirmed')
    await click(`${dock}.querySelector('.message-delivery-failure__actions button')`); await painted()
    assert.equal(await evaluate(`Boolean(${dock})`), false, 'Retry uses the original action and dismisses only its completed notice')
    for (const kind of ['failed', 'unknown', 'waiting']) {
      const original = await evaluate(`identityMenu.messageFeedback(${JSON.stringify(kind)})`)
      await waitFor(visible(`document.querySelector('.composer-pending__card')`)); await painted()
      const explanation = await evaluate(`(()=>{const card=document.querySelector('.composer-pending__card'),reason=card.querySelector('.composer-pending__reason');return {reasonPresent:!!reason,reasonHeight:reason?.getBoundingClientRect().height??0,label:reason?.textContent,opacity:getComputedStyle(card).opacity}})()`)
      assert.equal(explanation.reasonPresent,true,'The actual right card exposes its original short state in the main layer')
      assert.ok(explanation.reasonHeight>1,'The original short state is visibly readable rather than screen-reader-only')
      assert.equal(explanation.opacity,'1','Distance material retains stable status and operation ink')
      result.queueExplanations??=[];result.queueExplanations.push({width,kind,...explanation})
      await frame(width, `${kind}-right-card`)
      await click(`document.querySelector('.composer-pending__copy')`)
      await waitFor(`document.querySelector('.composer-pending__copy').dataset.copyState==='copied'`)
      assert.equal(await evaluate('identityMenu.facts().clipboard.at(-1)'), original.text, 'The actual queued-message clipboard consumer receives every original body byte')
      if (kind === 'waiting') {
        const geometry = await evaluate(`(()=>{const card=document.querySelector('.composer-pending__card'),more=card.querySelector('.composer-pending__more'),r=card.getBoundingClientRect(),m=more.getBoundingClientRect();return {height:r.height,moreHit:document.elementFromPoint(m.x+m.width/2,m.y+m.height/2)?.closest('button')===more}})()`)
        assert.ok(geometry.height >= 48 && geometry.height <= 76 && geometry.moreHit, 'The actual waiting card retains two readable rows and an operable original Outbox action')
        const stop = `document.querySelector('.composer-pending__retry button')`
        await waitFor(visible(stop)); await click(stop)
        const call = await evaluate('identityMenu.feedbackWaitCancelCalls().at(-1)')
        assert.deepEqual(call, { sessionId: original.identities.agentSessionId, operationId: original.identities.operationId, result: false }, 'The real stop control reaches the original cancel owner; this snapshot fixture has no live retry lease')
        result.waitCancel = call
      }
      await click(`document.querySelector('.composer-pending__more')`)
      await waitFor(`${mailbox}.matches(':popover-open') && ${mailbox}.dataset.state==='open'`)
      const failure = `${mailbox}.querySelector('.message-delivery-failure')`
      await waitFor(visible(failure)); await compact(failure)
      await frame(width, `${kind}-outbox`)
      assert.equal(await evaluate(`${mailbox}.querySelector('.composer-outbox__inline').dataset.recordKey`), `queue:${original.identities.operationId}`, 'The original outbox operation identity is retained')
      const raw = await evaluate(`${failure}.querySelector('pre').textContent`)
      assert.ok(raw.includes(original.raw), 'Outbox folding preserves the original full diagnostic')
      await click(`${failure}.querySelector('[aria-label="复制完整诊断"]')`)
      await waitFor(`${failure}.querySelector('[data-copy-state]').dataset.copyState==='copied'`)
      assert.equal(await evaluate('identityMenu.facts().clipboard.at(-1)'), raw, 'The actual Outbox clipboard consumer receives the complete original diagnostic')
      assert.ok(await evaluate(`${mailbox}.textContent.includes(${JSON.stringify('original-message-tail-完整')})`), 'Outbox retains the complete original message body')
      if (kind === 'waiting') assert.equal(await evaluate(`Array.from(${mailbox}.querySelectorAll('button')).some(button=>button.textContent==='停止等待')`), true, 'The original wait-cancel action remains available')
      await key('Escape', 'Escape', 27); await waitFor(`!${mailbox}.matches(':popover-open') && ${mailbox}.dataset.state==='closed'`); await painted()
    }
    result.feedback.push({ width, state, originalDiagnosticBytes: Buffer.byteLength(report), identities: scenario.identities, preserved: true })
  }
  const inputs = await evaluate('identityMenu.mailboxInputs()')
  assert.ok(inputs.some(event => event.type === 'input' && event.trusted), 'Actual trusted product editing events are nonempty')
  result.feedbackInputs = inputs.filter(event => event.trusted)
  result.clipboard = await evaluate('identityMenu.facts().clipboard')
}
