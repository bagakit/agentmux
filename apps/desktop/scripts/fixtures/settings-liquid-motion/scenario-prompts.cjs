const assert = require('node:assert/strict')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// This module is connected only at the T2 qualification node. All actions use
// the existing private actual App, ConfigOwner and Electron input transport.
exports.run = async function run(p, h) {
  const { win, read, q, button, until, settle, click, field, type, scene, capture, section, owner, result } = p
  const { host, lens, target, snap, docked, paused, runningMove } = h
  const editor = '[data-prompt-editor]'
  const search = '[aria-label="Search prompts"]'
  const status = `${editor} [data-prompt-status]`
  const proof = 'window.liquidPromptProof'
  const initial = structuredClone(owner.current.composerShortcuts)
  assert.deepEqual(initial.map(prompt => prompt.id), ['explain', 'review', 'continue'], 'Actual ConfigOwner starts with the complete nonempty private fixture library')
  const current = () => read(`(()=>{const e=${q(editor)},s=${q(status)},n=${field('Name')},t=${field('Prompt')};return{id:e.dataset.promptEditor,status:s?.dataset.promptStatus,statusText:s?.textContent,name:n.value,body:t.value,sameTextarea:t===${proof}.textarea,connected:t.isConnected,focused:document.activeElement===t}})()`)
  const sameEditor = async () => {
    const state = await current()
    assert.ok(state.connected && state.sameTextarea, 'One actual connected ComposerTextarea survives selection, filtering and section changes')
    return state
  }
  const focus = async expression => {
    const state = await read(`(()=>{const n=${expression};return{connected:n.isConnected,visible:n.checkVisibility(),focused:document.activeElement===n,hiddenAncestor:!!n.closest('[hidden],[inert]')}})()`)
    assert.deepEqual(state, { connected: true, visible: true, focused: true, hiddenAncestor: false }, 'Focus belongs to an actual visible connected control outside hidden/inert ancestors')
  }
  const localListeners = async () => {
    const remote = await win.webContents.debugger.sendCommand('Runtime.evaluate', { expression: q(host), returnByValue: false })
    assert.ok(remote.result?.objectId, 'CDP inspects the actual nonempty Prompt host object')
    try {
      const { listeners } = await win.webContents.debugger.sendCommand('DOMDebugger.getEventListeners', { objectId: remote.result.objectId })
      assert.ok(Array.isArray(listeners), 'CDP returns a concrete direct-host listener collection')
      const counts = Object.fromEntries(['pointermove', 'pointerleave', 'scroll'].map(type => [type, listeners.filter(listener => listener.type === type).length]))
      result.actions.push({ actualPromptHostListeners: counts })
      return counts
    } finally { await win.webContents.debugger.sendCommand('Runtime.releaseObject', { objectId: remote.result.objectId }) }
  }

  const resizeTargets = async reason => {
    const state = await read(`(()=>{const p=${proof},targets=[...p.resizeTargets.values()].flatMap(set=>[...set]);return{host:targets.filter(n=>n===p.host).length,rows:targets.filter(n=>n!==p.host).length}})()`)
    result.actions.push({ promptResizeTargets: { reason, ...state } })
    return state
  }

  await read(`${proof}={host:${q(host)},textarea:${field('Prompt')},name:${field('Name')},compositionStarts:0,compositionEnds:0};${proof}.textarea.addEventListener('compositionstart',()=>${proof}.compositionStarts++);${proof}.textarea.addEventListener('compositionend',()=>${proof}.compositionEnds++)`)
  // Observe original native methods without replacing the native observer,
  // scheduling its callback, or changing any geometry. Only this host/rows
  // enter the bounded probe; original methods and return values are retained.
  await read(`(()=>{const p=${proof},prototype=ResizeObserver.prototype,names=['observe','unobserve','disconnect'],originals=Object.fromEntries(names.map(name=>[name,Object.getOwnPropertyDescriptor(prototype,name)])),wrapped={};p.resizeTargets=new Map();for(const name of names){const original=originals[name].value;wrapped[name]=function(...args){const returned=Reflect.apply(original,this,args),node=args[0];if(name==='disconnect')p.resizeTargets.delete(this);else if(node===p.host||p.host.contains(node)){if(!p.resizeTargets.has(this))p.resizeTargets.set(this,new Set());if(name==='observe')p.resizeTargets.get(this).add(node);else p.resizeTargets.get(this).delete(node)}return returned};Object.defineProperty(prototype,name,{...originals[name],value:wrapped[name]})}p.restoreResize=()=>{for(const name of names){if(prototype[name]!==wrapped[name])throw Error('Resize observation will not overwrite an unexpected method edit');Object.defineProperty(prototype,name,originals[name])}return names.every(name=>prototype[name]===originals[name].value)}})()`)
  try {
  await section('general'); await section('prompts'); await settle()
  await click(q(target('explain'))); await delay(460); await docked('explain')
  assert.deepEqual(await resizeTargets('active calibration'), { host: 1, rows: 1 }, 'Nonempty original native ResizeObserver watches the actual visible Prompt host and selected row')
  assert.equal((await sameEditor()).status, 'saved')
  assert.equal(await read(`${q(editor)}.querySelectorAll('h3').length`), 0, 'The original Name input owns the title without a duplicate same-name heading')
  assert.equal(await read(`(${field('Name')}).closest('label').firstElementChild.textContent`), 'Name', 'Promoted title keeps its native Name label')
  const longName = 'Explain this change in plain words — 保留原工作面、说明验证结果与仍需确认的边界'
  await type(field('Name'), longName)
  const dirty = await sameEditor()
  assert.equal(dirty.status, 'unsaved', 'Selected authored Prompt reports Unsaved before the whole-library save'); assert.ok(dirty.statusText.includes('Unsaved'))
  const usage = await read(`(()=>{const n=${q(editor)}.querySelector('[aria-label="Usage preview"]');return{controls:n.querySelectorAll('button,input,select,textarea').length,text:n.textContent,keyword:n.querySelector('code').textContent}})()`)
  assert.equal(usage.controls, 0, 'The real usage example remains read only')
  assert.equal(usage.keyword, '/eli5'); assert.ok(usage.text.includes(longName) && usage.text.includes('Done') && usage.text.includes('Error'))
  assert.ok(/queue/i.test(usage.text), 'Usage describes pending-question behavior from the actual instruction facts')

  // Genuine Chromium IME events, then native pointer movement and a real resize
  // while composition remains active; no synthetic composition success flag.
  await type(field('Prompt'), '  original draft\nexact second line  ')
  await read(`(${field('Prompt')}).setSelectionRange(2,4)`)
  await win.webContents.debugger.sendCommand('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 })
  await until(`${proof}.compositionStarts>0`)
  const composing = await read(`(()=>{const n=${proof}.textarea;return{value:n.value,start:n.selectionStart,end:n.selectionEnd,ends:${proof}.compositionEnds}})()`)
  assert.equal(composing.ends, 0, 'Composition is still genuinely in flight before visual feedback')
  const bounds = await read(`${q(host)}.getBoundingClientRect().toJSON()`)
  win.webContents.sendInputEvent({ type: 'mouseMove', x: bounds.x + bounds.width * 0.7, y: bounds.y + 30 })
  await scene(940, 'light')
  await focus(`${proof}.textarea`)
  const afterFeedback = await read(`(()=>{const n=${proof}.textarea;return{value:n.value,start:n.selectionStart,end:n.selectionEnd,ends:${proof}.compositionEnds}})()`)
  assert.deepEqual(afterFeedback, composing, 'Pointer decoration and actual reflow preserve the original live composition and selection')
  await win.webContents.debugger.sendCommand('Input.insertText', { text: '中文' })
  await until(`${proof}.compositionEnds>0`)
  const authoredBody = (await sameEditor()).body
  assert.ok(authoredBody.includes('中文') && authoredBody.includes('\nexact second line  '), 'Native composition commits into the existing authored instruction')
  await scene(1480, 'light'); await docked('explain')
  await capture('prompts-1480-light-dirty.png', 'Native Name title, stable writing canvas and honest selected-object Unsaved plus whole-library facts')

  await type(q(search), 'Review changes')
  const filtered = await read(`(()=>{const n=${q(host)};return{ids:[...n.querySelectorAll('[data-prompt-id]')].map(r=>r.dataset.promptId),hidden:${q(lens)}.hidden,id:${q(lens)}.dataset.liquidSelection}})()`)
  assert.deepEqual(filtered.ids, ['review'])
  assert.equal(filtered.hidden, true); assert.equal(filtered.id, 'explain')
  assert.equal((await sameEditor()).id, 'explain'); assert.equal((await sameEditor()).body, authoredBody)
  assert.ok(await read(`${q('.prompt-editor__filtered')}.textContent.includes('outside your search')`))
  await capture('prompts-1480-light-filtered.png', 'Dirty selected object stays identified outside the filter; no neighbouring selected lens')
  await click(q('[aria-label="Clear prompt search"]')); await focus(q(search)); await settle(); await docked('explain')

  await click(q(target('review'))); await delay(460); await docked('review')
  const cleanOther = await sameEditor()
  assert.equal(cleanOther.id, 'review'); assert.equal(cleanOther.status, 'saved')
  assert.ok(await read(`${q('.prompt-save-summary')}.textContent.includes('1 changed')`), 'Current clean object never implies the complete dirty library is saved')
  await type(field('Prompt'), '   ')
  const invalid = await sameEditor()
  assert.equal(invalid.status, 'invalid'); assert.ok(invalid.statusText.includes('Needs attention'))
  assert.equal(await read(`(${field('Prompt')}).getAttribute('aria-invalid')`), 'true')
  assert.equal(await read(`(${button('Save prompts')}).disabled`), true)
  await capture('prompts-1480-light-invalid.png', 'Selected-field problem owns Needs attention; complete library Save is disabled')
  await type(field('Prompt'), initial.find(prompt => prompt.id === 'review').body)
  assert.equal((await sameEditor()).status, 'saved')
  await click(q(target('explain'))); await delay(460)
  assert.equal((await sameEditor()).name, longName); assert.equal((await sameEditor()).body, authoredBody)

  // CSS hiding keeps one host resize sentinel for reappearance; an inactive
  // module must also release that sentinel, not just hide its rectangle.
  assert.deepEqual(await localListeners(), { pointermove: 1, pointerleave: 1, scroll: 1 }, 'The visible local consumer really owns its three direct host observations')
  await runningMove('explain', 'review')
  await section('general')
  assert.equal(await read(`${q('[data-settings-pane="prompts"]')}.hidden`), true)
  await paused('inactive visited Prompt pane')
  assert.deepEqual(await resizeTargets('inactive visited pane'), { host: 0, rows: 0 }, 'active=false releases every owned Prompt resize target including the visibility sentinel')
  assert.deepEqual(await localListeners(), { pointermove: 0, pointerleave: 0, scroll: 0 }, 'active=false disconnects the hidden local consumer rather than relying on zero CSS geometry')
  assert.equal(await read(`${q(host)}===${proof}.host && ${proof}.textarea.isConnected`), true)
  await section('prompts'); await delay(460); await docked('review')
  assert.deepEqual(await resizeTargets('reactivated pane'), { host: 1, rows: 1 }, 'Reactivation observes the same nonempty current Prompt host and row')
  assert.deepEqual(await localListeners(), { pointermove: 1, pointerleave: 1, scroll: 1 })
  await sameEditor()

  win.setContentSize(1480, 420); await until('innerHeight===420'); await settle()
  const scroll = await read(`(()=>{const n=${q(host)},before=n.scrollTop;n.scrollTop=n.scrollHeight;return{before,after:n.scrollTop,height:n.clientHeight,total:n.scrollHeight,rect:n.getBoundingClientRect().toJSON()}})()`)
  assert.ok(scroll.total > scroll.height && scroll.height > 0, 'The actual short window creates a nonempty scrollable Prompt library')
  assert.ok(scroll.after > scroll.before, 'Prompt library scroll changes its real owning viewport')
  await settle()
  const scrolled = await snap()
  assert.equal(scrolled.id, 'review'); assert.equal(scrolled.nativeSelected, 'true')
  if (scrolled.target.bottom <= scroll.rect.top || scrolled.target.top >= scroll.rect.bottom) assert.equal(scrolled.hidden, true, 'A fully offscreen Prompt target hides its own lens instead of borrowing another row')
  else await docked('review')
  result.actions.push({ actualPromptScroll: { scroll, scrolled } })
  await read(`${q(host)}.scrollTop=0`)
  win.setContentSize(1480, 900); await until('innerHeight===900'); await settle(); await docked('review')

  await scene(640, 'dark')
  assert.equal(await read(`${q(host)}.checkVisibility()`), false, 'Narrow selected editor genuinely hides the library region')
  await paused('narrow hidden Prompt library')
  assert.deepEqual(await resizeTargets('CSS-hidden library'), { host: 1, rows: 0 }, 'CSS-hidden active library keeps only one host resize sentinel and no row consumer')
  assert.deepEqual(await localListeners(), { pointermove: 0, pointerleave: 0, scroll: 0 }, 'CSS-hidden Prompt library detaches local visual consumers while its editor remains active')
  await capture('prompts-640-dark-long-editor.png', 'Long saved object on the original narrow editor with complete whole-library save footer')
  await click(button('Back to prompts'))
  await until(`${q('.prompt-workbench')}.dataset.view==='library'`)
  await focus(q(target('review'))); await delay(460); await docked('review')
  assert.deepEqual(await localListeners(), { pointermove: 1, pointerleave: 1, scroll: 1 }, 'Original Back reconnects the same visible Prompt library consumers')
  assert.deepEqual(await resizeTargets('original Back'), { host: 1, rows: 1 }, 'Original Back reconnects the same actual selected row observation')
  assert.equal(await read(`${q(host)}===${proof}.host`), true)
  await capture('prompts-640-dark-library.png', 'Original Back returns to the same focused selected library row')
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
  win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  await until(`${q('.prompt-workbench')}.dataset.view==='editor'`)
  await sameEditor()
  await scene(1480, 'light'); await click(q(target('explain'))); await delay(460); await docked('explain')

  await read('window.settingsProof.hold()'); await click(button('Save prompts'))
  await until(`${q('[data-settings-save-bar]')}.textContent.includes('Saving')`)
  assert.deepEqual(owner.current.composerShortcuts, initial, 'The durable ConfigOwner has not committed the held whole-library save')
  await type(field('Name'), 'Later authored title')
  await read('window.settingsProof.release()')
  await until(`!${q('[data-settings-save-bar]')}.textContent.includes('Saving')`)
  assert.equal(owner.current.composerShortcuts.find(prompt => prompt.id === 'explain').label, longName, 'Input authored during a pending save is retained locally rather than silently committed')
  const later = await sameEditor()
  assert.equal(later.name, 'Later authored title'); assert.equal(later.status, 'unsaved')
  await capture('prompts-1480-light-pending-input.png', 'Real whole-library durable save completed; the later Name input remains honestly Unsaved')
  await click(button('Save prompts')); await until(`${q(status)}.dataset.promptStatus==='saved'`)
  assert.equal(owner.current.composerShortcuts.find(prompt => prompt.id === 'explain').label, 'Later authored title')
  assert.equal(owner.current.composerShortcuts.find(prompt => prompt.id === 'explain').body, authoredBody)
  assert.deepEqual(owner.current.composerShortcuts.filter(prompt => prompt.id !== 'explain'), initial.filter(prompt => prompt.id !== 'explain'))

  await click(q(target('continue'))); await sameEditor()
  await click(button('Delete prompt'))
  assert.ok(await read(`${q('.prompt-save-summary')}.textContent.includes('1 pending deletion')`))
  assert.ok(owner.current.composerShortcuts.find(prompt => prompt.id === 'continue'), 'Local deletion stays pending persistence')
  await click(button('Undo'))
  assert.equal((await sameEditor()).id, 'continue')
  assert.equal((await sameEditor()).body, initial.find(prompt => prompt.id === 'continue').body)
  assert.equal(await read('!!document.querySelector(".prompt-pending-delete")'), false)

  await click(button('Add prompt'))
  const added = (await sameEditor()).id
  assert.ok(added && !initial.some(prompt => prompt.id === added))
  await focus(field('Name'))
  assert.equal((await sameEditor()).status, 'invalid')
  await capture('prompts-1480-light-new.png', 'Original Add focuses the same native Name input with honest required-field state')
  await click(button('Cancel new prompt'))
  assert.equal(await read(`${q(host)}.querySelectorAll('[data-prompt-id]').length`), initial.length)
  await click(q(target('review'))); await scene(1480, 'dark'); await delay(460); await docked('review')
  await capture('prompts-1480-dark-long.png', 'Full dark Prompt workbench with long body, native reach fields and read-only usage')
  result.actions.push({ promptContracts: { initialIds: initial.map(prompt => prompt.id), longName, authoredBody, addedAndCancelled: added, stableTextarea: true } })
  } finally {
    assert.equal(await read(`${proof}.restoreResize()`), true, 'Bounded Prompt observer probe restores every original native ResizeObserver method')
  }
}
