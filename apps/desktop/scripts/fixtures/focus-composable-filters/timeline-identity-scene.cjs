const assert = require('node:assert/strict')

// Bounded leaf of the original App/public-conversation producer; no second owner.
module.exports = async function timelineIdentityScene({ win, result, read, until, settle, move, click, key, state, shot, scope }) {
  const recipient = await read('projectTimelineProof.recipient'), other = await read('projectTimelineProof.other')
  const live = id => `[data-focus-timeline-id="${id}"]:not([data-history-only]) .agent-avatar--inline`
  const resize = '[aria-label="Resize timeline names"]'
  await click('.recent-focus [aria-label="Show all timeline projects"]'); await scope([])
  const initial = await state()
  const geometry = () => read(`(()=>{
    const box=n=>n?.getBoundingClientRect().toJSON()??null, timeline=document.querySelector('.recent-focus'), focus=document.querySelector('.global-focus-surface'), control=timeline?.querySelector('[data-focus-project-scope-control]');
    const r=control?.getBoundingClientRect(), hit=!!r&&control.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
    const active=document.activeElement, activeBox=active?.getBoundingClientRect(), activeFace=active?.querySelector('.agent-avatar__face'), activeLabel=active?.querySelector('.agent-avatar__label');
    return { active:{tag:active?.tagName,id:active?.id,track:active?.closest('[data-focus-timeline-id]')?.dataset.focusTimelineId,label:active?.getAttribute('aria-label'),box:box(active),face:box(activeFace),text:box(activeLabel),hit:!!activeBox&&active.contains(document.elementFromPoint(activeBox.x+activeBox.width/2,activeBox.y+activeBox.height/2))}, viewport:box(timeline?.querySelector('.recent-focus__viewport')), ruler:box(timeline?.querySelector('.recent-focus__ruler')), scrollTop:timeline?.querySelector('.recent-focus__viewport')?.scrollTop, timeline:box(timeline), focus:box(focus), inert:!!timeline?.closest('[inert]'), controlHit:hit,
      rows:[...document.querySelectorAll('.recent-focus__track .recent-focus__identity')].map(identity=>{
        const button=identity.querySelector('.agent-avatar--inline'), face=button?.querySelector('.agent-avatar__face'), label=button?.querySelector('.agent-avatar__label');
        if(!button||!face||!label)throw Error('Original identity parts missing');
        const s=getComputedStyle(button), canvas=document.createElement('canvas'), context=canvas.getContext('2d'); context.font=s.font;
        return { id:identity.closest('[data-focus-timeline-id]').dataset.focusTimelineId, history:identity.closest('[data-history-only]')!==null,
          identity:box(identity),button:box(button),face:box(face),label:box(label),text:label.textContent,
          styles:{background:s.backgroundColor,border:[s.borderTopWidth,s.borderRightWidth,s.borderBottomWidth,s.borderLeftWidth],shadow:s.boxShadow},thirtyCh:context.measureText('0').width*30 };
      }) };
  })()`)
  const admission = value => {
    assert.ok(value.focus?.width > 0 && value.focus.height > 0, 'Actual full App Focus surface is visible')
    assert.ok(value.timeline?.height > 0 && value.timeline.width > 0, 'Actual timeline is visible')
    assert.equal(value.inert, false, 'Timeline is the active presentation')
    assert.equal(value.controlHit, true, 'Actual Focus scope target is reachable')
    assert.ok(value.rows.length >= 2, 'Nonempty short and long identity consumers')
  }
  const frame = async (file, label, hover = false) => {
    const beforeCapture = await geometry()
    if (!hover) { await move('.recent-focus__ruler'); await key('Escape') }
    else if (file.includes('hover')) { await move(live(recipient)); await until('original hover disclosure', () => read('!!document.querySelector(".recent-focus__context-preview")')) }
    await settle(); const before = await geometry(); admission(before)
    await shot(file, label)
    const after = await geometry(); admission(after)
    result.frames.at(-1).identity = { beforeCapture, before, after }
    // Assert after saving the original full App image, so inverse failures retain
    // both the exact image and its business geometry rather than just an exit.
    const top = Math.max(after.viewport.top, after.ruler.bottom)
    for (const row of after.rows.filter(row => !row.history && [recipient, other].includes(row.id))) {
      for (const part of [row.face, row.label]) assert.ok(part.top >= top - 1 && part.bottom <= after.viewport.bottom + 1, 'Original live identity is fully visible below the sticky ruler')
    }
    const rows = after.rows, left = rows[0].face.x, textLeft = rows[0].label.x
    for (const row of rows) {
      assert.ok(Math.abs(row.face.x - left) <= 1, 'Timeline avatar x alignment')
      assert.ok(Math.abs(row.label.x - textLeft) <= 1, 'Timeline name x alignment')
      assert.ok(Math.abs(row.button.right - row.identity.right) <= 2, 'Timeline identity button fills its original indented container')
      assert.ok(row.face.width >= 13 && row.face.height >= 13, 'Original avatar is not compressed')
      assert.ok(row.face.x >= row.button.x - 1 && row.face.x + row.face.width <= row.button.x + row.button.width + 1, 'Original avatar is not clipped by its trigger')
      if (!hover) assert.ok(row.styles.background === 'rgba(0, 0, 0, 0)' || row.styles.background === 'transparent', 'Timeline default identity has no pill background')
      assert.ok(row.styles.border.every(width => parseFloat(width) === 0), 'Timeline identity has no pill border')
      if (!hover) assert.equal(row.styles.shadow, 'none', 'Timeline identity has no inset pill shadow')
    }
    assert.equal((await state()).sameDrafts, true); assert.equal((await state()).sameRuns, true)
  }
  for (const theme of ['dark', 'light']) {
    await read(`projectTimelineProof.theme(${JSON.stringify(theme)})`)
    for (const width of theme === 'dark' ? [112, 244, 320] : [244, 320]) {
      win.setContentSize(1440, 960); await read(`projectTimelineProof.identities(${width})`); await settle()
      assert.equal((await state()).nameWidth, width)
      await frame(`${theme}-identity-${width}.png`, `Full App timeline identity at saved ${width}px gutter`)
      if (width === 320) {
        const rows = result.frames.at(-1).identity.after.rows
        assert.ok(rows.some(row => row.identity.width > row.thirtyCh + 5), 'Wide fixture exceeds the inherited 30ch cap')
      }
    }
  }
  await read('projectTimelineProof.identities(244)'); win.setContentSize(420, 960); await settle()
  await frame('light-identity-narrow.png', 'Full narrow App retains aligned readable timeline identities')
  win.setContentSize(1440, 960); await read('projectTimelineProof.theme("dark")'); await settle()
  const beforeHover = await state(), reads = result.publicReads.length
  await move(live(recipient)); await until('original identity hover disclosure', () => read('!!document.querySelector(".recent-focus__context-preview")'))
  await frame('dark-identity-hover.png', 'Original shared identity hover remains passive', true)
  assert.deepEqual((await state()).focus, beforeHover.focus); assert.deepEqual((await state()).selection, beforeHover.selection)
  assert.equal(result.publicReads.length, reads, 'Identity hover performs no extra conversation read')
  await move('.recent-focus__ruler'); await key('Escape')
  // Use the actual separator's native keyboard contract as well as saved input.
  await click(resize)
  let separatorFocused = false
  for (let i = 0; i < 80; i++) {
    await key('Tab')
    separatorFocused = await read(`document.activeElement===document.querySelector(${JSON.stringify(resize)})`)
    if (separatorFocused) break
  }
  assert.equal(separatorFocused, true, 'Native Tab focuses the original resize separator')
  await key('Home'); await until('native Home width', async () => (await state()).nameWidth === 96)
  await key('ArrowRight'); await until('native Arrow width', async () => (await state()).nameWidth === 112)
  await key('End'); await until('native End width', async () => (await state()).nameWidth === 320)
  result.identityResize = { input: ['Home', 'ArrowRight', 'End'], saved: (await state()).nameWidth }
  await click(live(other)); await until('mouse selects exact short-name Context', async () => (await state()).focus.execution.sessionId === other)
  await move(live(recipient)); await click(resize)
  // Native reverse-Tab follows the shared disclosure contract (forward Tab
  // enters its panel actions); no synthetic focus or click selects this target.
  let reached = false
  for (let i = 0; i < 40; i++) {
    await key('Tab', 8)
    reached = await read(`document.activeElement===document.querySelector(${JSON.stringify(live(recipient))})`)
    if (reached) break
  }
  assert.equal(reached, true, 'Native reverse-Tab reaches original long-name Context trigger')
  result.identityKeyboardTarget = await geometry()
  await key('Enter'); await until('Enter selects exact original Context', async () => (await state()).focus.execution.sessionId === recipient)
  result.identityNativeFocus = await geometry()
  const focused = result.identityNativeFocus, minimumTop = Math.max(focused.viewport.top, focused.ruler.bottom)
  assert.equal(focused.active.track, recipient, 'Native Enter retains the exact focused identity')
  assert.equal(focused.active.hit, true, 'Native focused identity remains reachable')
  for (const part of [focused.active.face, focused.active.text]) assert.ok(part && part.top >= minimumTop && part.bottom <= focused.viewport.bottom, 'Native focused identity remains visible below the sticky ruler')
  await read('projectTimelineProof.identities(244,true)'); await settle()
  await until('original current working identity', () => read(`!!document.querySelector(${JSON.stringify(live(recipient))})?.classList.contains('status--working')&&!!document.querySelector(${JSON.stringify(live(recipient))})?.closest('.recent-focus__track').querySelector('.recent-focus__current')`))
  await frame('dark-identity-current-working.png', 'Keyboard-selected original Current Context keeps its working mark', true)
  const mark = await read(`(()=>{const button=document.querySelector(${JSON.stringify(live(recipient))}),mark=button.querySelector('.agent-avatar__status--working'),r=mark?.getBoundingClientRect(),b=button.getBoundingClientRect();return{mark:r?.toJSON(),button:b.toJSON(),viewport:document.querySelector('.recent-focus__viewport').getBoundingClientRect().toJSON(),ruler:document.querySelector('.recent-focus__ruler').getBoundingClientRect().toJSON(),overflow:getComputedStyle(button).overflow,faceOverflow:getComputedStyle(button.querySelector('.agent-avatar__face')).overflow,current:!!button.closest('.recent-focus__track').querySelector('.recent-focus__current')}})()`)
  assert.ok(mark.current && mark.mark?.width > 0 && mark.mark.height > 0, 'Actual Current and working status mark exist')
  assert.ok(mark.mark.top >= Math.max(mark.viewport.top,mark.ruler.bottom) && mark.mark.bottom <= mark.viewport.bottom, 'Actual working mark is visible below sticky ruler')
  assert.equal(mark.overflow, 'visible', 'Original status mark is not clipped by the identity trigger')
  assert.equal(mark.faceOverflow, 'visible', 'Original avatar face permits its outset status mark')
  result.identityWorking = mark
  const final = await state(); assert.deepEqual(final.drafts, initial.drafts); assert.equal(final.sameRuns, true)
  assert.ok(Object.values(final.calls).every(count => count === 0))
  result.identityInteraction = { hoverReadDelta: 0, mouseRecipient: other, keyboardRecipient: recipient, draftsRetained: true, runReferencesRetained: true }
}
