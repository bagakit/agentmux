const assert = require('node:assert/strict')

const frames = [
  'list-feedback-wide-dark-static', 'list-feedback-wide-dark-message-middle', 'list-feedback-wide-dark-message-settled',
  'list-feedback-wide-light-self', 'list-feedback-narrow-light-supervision', 'list-feedback-narrow-dark-host-isolation',
  'list-feedback-viewport-return', 'list-feedback-system-reduce', 'list-feedback-native-visible-return',
  'list-feedback-stop-pending', 'list-feedback-stop-detail-open', 'list-feedback-stop-detail-closed-focus',
  'list-feedback-stop-unconfirmed-narrow-light-detail', 'list-feedback-stop-failed'
]
const checks = ['list-native-directions-and-hosts', 'list-native-phase-and-policies', 'list-native-original-stop-and-focus']
const subjectKey = subject => JSON.stringify([subject.hostId, subject.agentSessionId])
const cardSelector = subject => `.focus-context-card[data-focus-agent-host=${JSON.stringify(subject.hostId)}][data-focus-agent-session=${JSON.stringify(subject.agentSessionId)}]`

function observe(subjects) {
  const bounds = element => element?.getBoundingClientRect().toJSON() ?? null
  const visible = element => {
    if (!element || element.closest('[hidden],[inert]')) return false
    const rectangle = element.getBoundingClientRect()
    let left = Math.max(0, rectangle.left), right = Math.min(innerWidth, rectangle.right), top = Math.max(0, rectangle.top), bottom = Math.min(innerHeight, rectangle.bottom)
    for (let owner = element; owner; owner = owner.parentElement) {
      const style = getComputedStyle(owner)
      if (style.display === 'none' || style.visibility !== 'visible') return false
      const clip = owner.getBoundingClientRect()
      if (owner !== element && /auto|scroll|hidden|clip/.test(style.overflowX)) { left = Math.max(left, clip.left); right = Math.min(right, clip.right) }
      if (owner !== element && /auto|scroll|hidden|clip/.test(style.overflowY)) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom) }
    }
    return right > left && bottom > top
  }
  const animation = value => {
    const timing = value.effect.getComputedTiming()
    return { name: value.animationName, state: value.playState, currentTime: value.currentTime, startTime: value.startTime,
      delay: timing.delay, duration: timing.duration, progress: timing.progress, iterations: timing.iterations === Infinity ? 'infinite' : timing.iterations }
  }
  const paint = element => {
    const text = element?.lastElementChild
    if (!text) return null
    const range = document.createRange(); range.selectNodeContents(text)
    const box = range.getBoundingClientRect(), point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    const styles = target => { const style = getComputedStyle(target); return { tag: target.tagName, class: target.getAttribute('class'), bounds: bounds(target), clientHeight: target.clientHeight, scrollHeight: target.scrollHeight, offsetHeight: target.offsetHeight, height: style.height, minHeight: style.minHeight, flexShrink: style.flexShrink, flexBasis: style.flexBasis, containIntrinsicBlockSize: style.containIntrinsicBlockSize, display: style.display, visibility: style.visibility, opacity: style.opacity, color: style.color, fontSize: style.fontSize, contentVisibility: style.contentVisibility, contain: style.contain, overflowX: style.overflowX, overflowY: style.overflowY } }
    const ancestors = []; for (let target = element; target && ancestors.length < 8; target = target.parentElement) ancestors.push(styles(target))
    return { text: text.textContent, bounds: box.toJSON(), point, nativeCheckVisibility: text.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true }),
      hit: text.contains(document.elementFromPoint(point.x, point.y)), stack: document.elementsFromPoint(point.x, point.y).slice(0, 8).map(target => ({ tag: target.tagName, class: target.getAttribute('class') })), ancestors }
  }
  const cards = Object.fromEntries(Object.entries(subjects).map(([name, subject]) => {
    const element = document.querySelector(`.focus-context-card[data-focus-agent-host=${JSON.stringify(subject.hostId)}][data-focus-agent-session=${JSON.stringify(subject.agentSessionId)}]`)
    if (!element) return [name, null]
    const feedback = element.querySelector('.focus-communication-feedback'), mark = feedback?.querySelector('.focus-communication-feedback__mark')
    return [name, { hostId: element.dataset.focusAgentHost, agentSessionId: element.dataset.focusAgentSession,
      name: element.querySelector('.focus-context__identity strong')?.textContent, bounds: bounds(element), visible: visible(element), body: element.dataset.focusCardBody,
      feedback: feedback ? { pulseId: feedback.dataset.activityId, kind: feedback.dataset.kind, direction: feedback.dataset.direction,
        text: feedback.textContent.trim(), active: feedback.dataset.motionActive === 'true', visible: visible(feedback), bounds: bounds(feedback),
        delay: parseFloat(getComputedStyle(mark).animationDelay) * 1000, opacity: getComputedStyle(mark).opacity,
        transform: getComputedStyle(mark).transform, color: getComputedStyle(mark).color, animations: mark.getAnimations().map(animation), paint: paint(feedback) } : null,
      operations: [...element.querySelectorAll('.agent-operation-feedback__item')].map(item => {
        const trigger = item.querySelector('.agent-operation-feedback__label'), detail = item.querySelector('.agent-operation-feedback__detail')
        return { kind: item.dataset.kind, phase: item.dataset.phase, operationId: detail?.querySelector('code')?.textContent,
          open: item.open, expanded: trigger?.getAttribute('aria-expanded'), controls: trigger?.getAttribute('aria-controls'), detailId: detail?.id,
          inert: detail?.inert, ariaHidden: detail?.getAttribute('aria-hidden'), insideFocus: Boolean(detail?.contains(document.activeElement)), triggerFocus: document.activeElement === trigger,
          label: trigger?.textContent.trim(), actions: [...item.querySelectorAll('button')].map(button => ({ text: button.textContent.trim(), disabled: button.disabled })),
          animations: [...item.getAnimations({ subtree: true })].map(animation) }
      }) }]
  }))
  return { at: performance.now(), wall: Date.now(), timeline: document.timeline.currentTime, hidden: document.hidden, visibility: document.visibilityState,
    reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, viewport: [innerWidth, innerHeight], theme: getComputedStyle(document.documentElement).colorScheme,
    listVisible: visible(document.querySelector('[data-desktop-focus-view="list"]')), cards }
}

function paintObservation(probe, subjects) {
  const snapshot = probe(subjects), clocks = {}
  for (const name of ['sender', 'recipient']) {
    const subject = subjects[name], card = document.querySelector(`.focus-context-card[data-focus-agent-host=${JSON.stringify(subject.hostId)}][data-focus-agent-session=${JSON.stringify(subject.agentSessionId)}]`)
    const mark = card?.querySelector('.focus-communication-feedback__mark'), animation = mark?.getAnimations().find(value => value.animationName === 'focus-list-communication-arrive')
    if (!animation) { clocks[name] = null; continue }
    const timing = animation.effect.getComputedTiming()
    clocks[name] = { pending: animation.pending, state: animation.playState, startTime: animation.startTime, currentTime: animation.currentTime,
      duration: timing.duration, delay: timing.delay, progress: timing.progress, iterations: timing.iterations, playbackRate: animation.playbackRate }
  }
  return { ...snapshot, clocks }
}

async function movingMiddle(probe, sample, subjects) {
  const previousPulseIds = Object.fromEntries(['sender', 'recipient'].map(name => {
    const subject = subjects[name], card = document.querySelector(`.focus-context-card[data-focus-agent-host=${JSON.stringify(subject.hostId)}][data-focus-agent-session=${JSON.stringify(subject.agentSessionId)}]`)
    return [name, card?.querySelector('.focus-communication-feedback')?.dataset.activityId ?? null]
  }))
  const event = window.graphCapture.live(true, subjects.sender.agentSessionId, subjects.recipient.agentSessionId, 'message', subjects.sender.hostId)
  const observations = [], started = performance.now()
  let previous, previousMarks, previousAnimations
  const targets = () => ['sender', 'recipient'].map(name => {
    const subject = subjects[name]
    const mark = document.querySelector(`.focus-context-card[data-focus-agent-host=${JSON.stringify(subject.hostId)}][data-focus-agent-session=${JSON.stringify(subject.agentSessionId)}] .focus-communication-feedback__mark`)
    return { mark, animation: mark?.getAnimations().find(value => value.animationName === 'focus-list-communication-arrive') }
  })
  do {
    const raf = await new Promise(done => requestAnimationFrame(done)), current = { ...sample(probe, subjects), raf }
    if (observations.length < 20) observations.push(current)
    const ready = ['sender', 'recipient'].every(name => {
      const clock = current.clocks[name], feedback = current.cards[name]?.feedback
      return !current.hidden && !current.reduced && feedback?.active && feedback.pulseId !== previousPulseIds[name] && feedback.visible && feedback.paint?.hit && feedback.paint.nativeCheckVisibility &&
        clock?.pending === false && clock.state === 'running' && Number.isFinite(clock.startTime) && clock.startTime > 0 &&
        Number.isFinite(clock.currentTime) && clock.currentTime > 0 && Number.isFinite(clock.duration) && clock.duration > 0 && clock.iterations === 1 && clock.progress > 0 && clock.progress < 1
    })
    if (!ready) { previous = undefined; continue }
    const held = targets()
    if (previous && current.raf > previous.raf && current.timeline > previous.timeline && ['sender', 'recipient'].every((name, index) =>
      current.cards[name].feedback.pulseId === previous.cards[name].feedback.pulseId && current.clocks[name].startTime === previous.clocks[name].startTime &&
      current.clocks[name].delay === previous.clocks[name].delay && current.clocks[name].currentTime > previous.clocks[name].currentTime &&
      held[index].mark === previousMarks[index] && held[index].animation === previousAnimations[index])) {
      return { event, previousPulseIds, previous, before: current, observations, originalMarksRetainedAcrossRAF: true, originalAnimationsRetainedAcrossRAF: true }
    }
    previous = current; previousMarks = held.map(value => value.mark); previousAnimations = held.map(value => value.animation)
  } while (performance.now() - started < 1500)
  return { event, previousPulseIds, observations, failure: 'No two advancing original rAF frames exposed started, nonpending, finite intermediate CSSAnimations.' }
}

function verifyClockSample(sample) {
  assert.equal(sample.hidden, false); assert.equal(sample.reduced, false); assert.equal(sample.listVisible, true)
  assert.equal(sample.theme, 'dark'); assert.deepEqual(sample.viewport, [1440, 900])
  for (const name of ['sender', 'recipient']) {
    const feedback = sample.cards[name]?.feedback, clock = sample.clocks[name]
    assert.ok(feedback?.active && feedback.visible && feedback.paint?.hit && feedback.paint.nativeCheckVisibility)
    assert.equal(feedback.direction, name === 'sender' ? 'sent' : 'received'); assert.equal(feedback.kind, 'communication')
    assert.ok(Number(feedback.opacity) > 0)
    assert.equal(clock?.pending, false, 'Positive delayed progress is not a started native animation')
    assert.equal(clock.state, 'running'); assert.equal(clock.iterations, 1); assert.equal(clock.playbackRate, 1)
    assert.ok(Number.isFinite(clock.startTime) && clock.startTime > 0 && Number.isFinite(clock.currentTime) && clock.currentTime > 0)
    assert.ok(Number.isFinite(clock.duration) && clock.duration > 0 && Number.isFinite(clock.delay) && clock.progress > 0 && clock.progress < 1)
  }
  assert.equal(sample.cards.sender.feedback.pulseId, sample.cards.recipient.feedback.pulseId)
}

function verifyPaintedAdvance(previous, before) {
  verifyClockSample(previous); verifyClockSample(before)
  assert.ok(before.raf > previous.raf && before.timeline > previous.timeline, 'Two original native rAF frames must advance')
  for (const name of ['sender', 'recipient']) {
    const first = previous.clocks[name], second = before.clocks[name]
    assert.equal(previous.cards[name].feedback.pulseId, before.cards[name].feedback.pulseId)
    assert.equal(first.startTime, second.startTime); assert.equal(first.delay, second.delay); assert.equal(first.duration, second.duration)
    assert.ok(second.currentTime > first.currentTime, 'The started original CSS clock must actually advance across native rAF')
  }
}

async function viewportTrip(probe, subjects) {
  const subject = subjects.sender
  const selector = `.focus-context-card[data-focus-agent-host=${JSON.stringify(subject.hostId)}][data-focus-agent-session=${JSON.stringify(subject.agentSessionId)}]`
  const card = document.querySelector(selector), body = card?.querySelector('button.focus-context')
  if (!body) throw Error('The original sender card body must be mounted for the viewport observation')
  let scrollport = card.parentElement
  while (scrollport && !(scrollport.scrollHeight > scrollport.clientHeight && /auto|scroll/.test(getComputedStyle(scrollport).overflowY))) scrollport = scrollport.parentElement
  if (!scrollport) throw Error('The original List must have a real scrollport with retained members')
  const originalTop = scrollport.scrollTop, oldPulse = card.querySelector('.focus-communication-feedback')?.dataset.activityId
  const event = window.graphCapture.live(true, subjects.sender.agentSessionId, subjects.recipient.agentSessionId, 'message', subject.hostId)
  const samples = [], observations = [], start = performance.now()
  let step = 'initial', failure, parkedTop = null
  const take = () => { const snapshot = probe(subjects); if (observations.length < 24) observations.push({ step, ...snapshot }); return snapshot }
  const tick = () => new Promise(done => requestAnimationFrame(() => { samples.push(performance.now()); done() }))
  const wait = async predicate => {
    do { await tick(); if (predicate()) return } while (performance.now() - start < 1000)
    throw Error('The original viewport owner did not expose the requested finite state')
  }
  let before, parked, returned, mark, parkedMark, returnedMark
  try {
    await wait(() => {
      const snapshot = take(), feedback = snapshot.cards.sender?.feedback, motion = feedback?.animations.find(value => value.name === 'focus-list-communication-arrive')
      if (!feedback?.active || feedback.pulseId === oldPulse || !(motion?.currentTime >= motion.duration * .2 && motion.progress > 0 && motion.progress < 1)) return false
      before = snapshot; return true
    })
    mark = card.querySelector('.focus-communication-feedback__mark')
    const target = mark.getBoundingClientRect(), clip = scrollport.getBoundingClientRect(), forward = originalTop + target.bottom - clip.top + 12
    const backward = originalTop - (clip.bottom - target.top + 12)
    parkedTop = forward <= scrollport.scrollHeight - scrollport.clientHeight ? forward : backward >= 0 ? backward : null
    if (parkedTop === null) throw Error('The real List scrollport has no room to park this mark without changing layout')
    step = 'parked'; scrollport.scrollTop = parkedTop
    await wait(() => { const snapshot = take(); if (snapshot.cards.sender?.feedback?.active !== false) return false; parked = snapshot; return true })
    parkedMark = card.querySelector('.focus-communication-feedback__mark')
    step = 'returned'; scrollport.scrollTop = originalTop
    await wait(() => { const snapshot = take(); if (!snapshot.cards.sender?.feedback?.active) return false; returned = snapshot; return true })
    returnedMark = card.querySelector('.focus-communication-feedback__mark')
  } catch (error) { failure = { step, message: error.message, stack: error.stack } }
  finally { scrollport.scrollTop = originalTop }
  return { event, before, parked, returned, observations, ...(failure ? { failure } : {}),
    sameCard: card === document.querySelector(selector), sameBody: body === card.querySelector('button.focus-context'),
    sameMark: mark === parkedMark && mark === returnedMark, scroll: { before: originalTop, parked: parkedTop, returned: scrollport.scrollTop },
    frameIntervals: samples.slice(1).map((value, index) => value - samples[index]) }
}

function feedback(sample, name, direction, kind = 'communication') {
  const card = sample.cards[name], value = card?.feedback
  assert.ok(card && value, 'Actual original List feedback: ' + name)
  assert.equal(value.direction, direction); assert.equal(value.kind, kind)
  assert.equal(value.text, { sent: '观察到发送', received: '观察到接收', self: '观察到自发自收', updated: '派发记录更新' }[direction])
  assert.ok(value.pulseId && Number(value.opacity) > 0)
  return value
}

function protectedFacts(value, before) {
  for (const field of ['sameTabs', 'layoutsPreserved', 'sameDrafts', 'draftMounted', 'sameDraft']) assert.equal(value[field], true, 'Original ' + field)
  for (const field of ['draft', 'storedDraft', 'range', 'originalRun']) assert.deepEqual(value[field], before[field], 'Original ' + field)
  assert.deepEqual(value.chrome.preferences, before.chrome.preferences)
}

function verifyMiddle(record) {
  assert.equal(record.failure, undefined, record.failure)
  verifyPaintedAdvance(record.previous, record.before); verifyClockSample(record.after)
  assert.ok(record.originalMarksRetainedAcrossRAF && record.originalAnimationsRetainedAcrossRAF)
  for (const name of ['sender', 'recipient']) {
    assert.notEqual(record.before.cards[name].feedback.pulseId, record.previousPulseIds[name])
    assert.equal(record.before.clocks[name].startTime, record.after.clocks[name].startTime)
    assert.equal(record.before.clocks[name].delay, record.after.clocks[name].delay)
    assert.equal(record.before.clocks[name].duration, record.after.clocks[name].duration)
    assert.ok(record.after.clocks[name].currentTime >= record.before.clocks[name].currentTime)
  }
  for (const sample of [record.before, record.after]) {
    const sender = feedback(sample, 'sender', 'sent'), recipient = feedback(sample, 'recipient', 'received')
    assert.equal(sender.pulseId, recipient.pulseId); assert.equal(sender.pulseId, record.before.cards.sender.feedback.pulseId)
    for (const value of [sender, recipient]) {
      const motion = value.animations.find(item => item.name === 'focus-list-communication-arrive')
      assert.ok(value.visible && value.active && motion?.progress > 0 && motion.progress < 1,
        'The complete PNG must be bracketed by actual finite native intermediate frames, not a completed mark')
      assert.ok(value.paint?.nativeCheckVisibility && value.paint.hit && value.paint.bounds.height > 0, 'The actual feedback text must not be replaced in hit testing by the original footer or another card')
      for (const owner of value.paint.ancestors.filter(owner => owner.contentVisibility === 'auto')) assert.ok(value.paint.bounds.top >= owner.bounds.top - .5 && value.paint.bounds.bottom <= owner.bounds.bottom + .5, 'The original paint-contained card must naturally enclose its feedback text')
    }
  }
}

function verifyViewport(value) {
  assert.equal(value?.failure, undefined, 'Original native viewport observation is unconfirmed: ' + JSON.stringify(value?.failure))
  assert.ok(value?.sameCard && value.sameBody, 'Viewport parking must preserve the original card body')
  const initial = feedback(value.before, 'sender', 'sent'), parked = feedback(value.parked, 'sender', 'sent'), returned = feedback(value.returned, 'sender', 'sent')
  assert.equal(initial.pulseId, parked.pulseId); assert.equal(initial.pulseId, returned.pulseId)
  assert.equal(parked.active, false); assert.equal(parked.visible, false); assert.equal(returned.active, true); assert.equal(returned.visible, true)
  assert.equal(value.scroll.before, value.scroll.returned); assert.notEqual(value.scroll.before, value.scroll.parked)
  const motion = returned.animations.find(item => item.name === 'focus-list-communication-arrive')
  assert.ok(motion && Number.isFinite(motion.currentTime) && Number.isFinite(motion.delay) && Number.isFinite(motion.duration))
  assert.ok(Number.isFinite(value.event.wallBefore) && value.event.wallAfter >= value.event.wallBefore)
  const age = { lower: value.returned.wall - value.event.wallAfter, upper: value.returned.wall - value.event.wallBefore }
  assert.ok(age.lower >= 0 && age.upper < motion.duration && motion.progress > 0 && motion.progress < 1,
    'A completed or late viewport return is terminal evidence, not proof of an intermediate native phase')
  assert.ok(value.frameIntervals.length > 1 && value.frameIntervals.every(interval => Number.isFinite(interval) && interval > 0))
  const tolerance = Math.max(...value.frameIntervals) + value.event.wallAfter - value.event.wallBefore + 2
  const previous = initial.animations.find(item => item.name === 'focus-list-communication-arrive')
  assert.ok(previous?.currentTime > tolerance * 1.5, 'The early played interval must exceed measured native frame uncertainty; otherwise phase is unconfirmed')
  const effective = motion.currentTime - motion.delay
  assert.ok(effective >= age.lower - tolerance && effective <= age.upper + tolerance,
    'Native CSSAnimation currentTime minus effect.delay must track original pulse age without accumulated playback: ' + JSON.stringify({ effective, age, tolerance, sameMark: value.sameMark }))
  assert.ok(parked.animations.every(item => item.state !== 'running'), 'A parked original mark is actually paused')
}

function verifyStopTargets(calls, subjects) {
  assert.equal(calls.length, 3)
  assert.equal(new Set(calls.map(call => call.operationId)).size, 3)
  assert.equal(new Set(calls.map(call => JSON.stringify([call.control.hostId, call.control.agentSessionId, call.control.run.runId]))).size, 3,
    'Separate native Stop cases must not bypass the original same-Run pending intent and flight')
  for (const [index, name] of ['sender', 'recipient', 'neighbor'].entries()) {
    assert.equal(calls[index].control.hostId, subjects[name].hostId, 'Separately confirmed original Host')
    assert.equal(calls[index].control.agentSessionId, subjects[name].agentSessionId, 'Separately confirmed original subject')
    assert.ok(calls[index].operationId && calls[index].control.run.runId)
  }
}

function verify(data, captured) {
  assert.equal(data?.schema, 'agentmux.focus-list-feedback-native.v1')
  assert.deepEqual(data.stages.map(stage => stage.label), frames)
  assert.deepEqual(captured.filter(frame => frames.includes(frame.label)).map(frame => frame.label), frames)
  for (const stage of data.stages) {
    for (const sample of [stage.before, stage.after]) {
      assert.equal(sample.listVisible, true); assert.equal(sample.hidden, false)
      assert.equal(sample.theme, stage.label.includes('-light-') ? 'light' : 'dark')
      assert.equal(sample.viewport[0], stage.label.includes('-narrow-') ? 620 : 1440)
    }
  }
  const stage = name => data.stages.find(item => item.label === name)
  verifyMiddle(stage('list-feedback-wide-dark-message-middle'))
  const settled = stage('list-feedback-wide-dark-message-settled').after
  for (const name of ['sender', 'recipient']) assert.ok(settled.cards[name].feedback.animations.every(item => item.state !== 'running'))
  feedback(stage('list-feedback-wide-light-self').after, 'sender', 'self')
  for (const name of ['sender', 'recipient']) feedback(stage('list-feedback-narrow-light-supervision').after, name, 'updated', 'supervision')
  const isolation = stage('list-feedback-narrow-dark-host-isolation').after
  assert.notEqual(data.subjects.sender.hostId, data.subjects.otherHost.hostId)
  assert.ok(typeof isolation.cards.sender.name === 'string' && isolation.cards.sender.name.length > 0 && typeof isolation.cards.otherHost.name === 'string')
  assert.equal(isolation.cards.sender.name, isolation.cards.otherHost.name)
  feedback(isolation, 'sender', 'sent'); feedback(isolation, 'otherHost', 'self')
  assert.equal(isolation.cards.sender.feedback.pulseId, data.isolation.before.cards.sender.feedback.pulseId)
  assert.equal(isolation.cards.recipient.feedback.pulseId, data.isolation.before.cards.recipient.feedback.pulseId)
  assert.equal(isolation.cards.neighbor.feedback, null)
  verifyViewport(data.viewport)
  const reduced = stage('list-feedback-system-reduce').after
  assert.equal(reduced.reduced, true)
  for (const name of ['sender', 'recipient']) assert.ok(feedback(reduced, name, name === 'sender' ? 'sent' : 'received').animations.every(item => item.state !== 'running'))
  assert.equal(data.policies.independentOff, 'not-applicable')
  assert.equal(data.policies.hidden.hidden, true); assert.equal(data.policies.hidden.visibility, 'hidden')
  assert.equal(data.policies.nativeVisibility.focusEmulationAtReturn, false)
  assert.deepEqual(data.policies.nativeVisibility.controls.map(control => control.focusEmulation), [false, true])
  assert.ok(data.policies.nativeVisibility.events.some(event => event.hidden && event.visibility === 'hidden'))
  assert.ok(data.policies.nativeVisibility.events.some(event => !event.hidden && event.visibility === 'visible'))
  for (const sample of [data.policies.hidden, data.policies.returned]) for (const name of ['sender', 'recipient']) {
    const value = sample.cards[name]?.feedback
    assert.ok(!value || !value.active && value.animations.every(item => item.state !== 'running'))
  }
  assert.equal(data.policies.returned.hidden, false)
  assert.equal(data.beforeStop.calls.length, 0)
  verifyStopTargets(data.stop.calls, data.subjects)
  const pending = data.stop.calls[0]
  assert.equal(pending.settled, false, 'The same original Stop remains pending through the native cost handoff')
  assert.equal(pending.control.hostId, data.subjects.sender.hostId); assert.equal(pending.control.agentSessionId, data.subjects.sender.agentSessionId)
  const byId = (sample, id, subject = 'sender') => sample.cards[subject].operations.find(item => item.operationId === id)
  const closed = byId(stage('list-feedback-stop-detail-closed-focus').after, pending.operationId)
  assert.ok(closed && !closed.open && closed.inert && closed.ariaHidden === 'true' && closed.triggerFocus)
  assert.equal(closed.controls, closed.detailId); assert.equal(closed.expanded, 'false')
  const opened = byId(stage('list-feedback-stop-detail-open').after, pending.operationId)
  assert.ok(opened.open && !opened.inert && opened.ariaHidden === 'false' && opened.insideFocus)
  assert.equal(data.stop.insideClose, true); assert.equal(data.stop.tabEnteredClosedDetail, false)
  for (const [index, phase, label, subject] of [[1, 'unconfirmed', 'list-feedback-stop-unconfirmed-narrow-light-detail', 'recipient'], [2, 'failed', 'list-feedback-stop-failed', 'neighbor']]) {
    const call = data.stop.calls[index], operation = byId(stage(label).after, call.operationId, subject)
    assert.equal(call.settled, true)
    assert.equal(call.control.hostId, data.subjects[subject].hostId); assert.equal(call.control.agentSessionId, data.subjects[subject].agentSessionId)
    assert.equal(operation?.phase, phase)
    assert.ok(operation.open && !operation.inert && operation.ariaHidden === 'false' && operation.controls === operation.detailId)
    assert.ok(operation.actions.some(action => action.text === '核对原操作' && !action.disabled))
  }
  assert.deepEqual(data.after.controls, [...data.original.controls, 'stop', 'stop', 'stop'])
  protectedFacts(data.after, data.original)
  for (const event of data.events) assert.ok(event.live === true && Number.isFinite(event.wallBefore) && event.wallAfter >= event.wallBefore)
  assert.deepEqual(data.observationBeforeStop.controls, data.original.controls, 'A2A observations do not perform lifecycle work')
}

async function showSubject({ read, until, settle }, subject) {
  await read(`(()=>{const element=document.querySelector(${JSON.stringify(cardSelector(subject))});if(!element)throw Error('Exact original List card is absent');element.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'})})()`)
  await until('original exact List card body', () => read(`Boolean(document.querySelector(${JSON.stringify(cardSelector(subject) + ' button.focus-context')}))`)); await settle()
}

async function markOriginalButton({ read }, selector, text, label) {
  const marked = await read(`(()=>{const element=[...document.querySelectorAll(${JSON.stringify(selector)})].find(element=>element.textContent.trim()===${JSON.stringify(text)});if(!element)return false;element.setAttribute('data-list-capture-control',${JSON.stringify(label)});return true})()`)
  assert.equal(marked, true, 'Original visible control: ' + text)
  return `[data-list-capture-control=${JSON.stringify(label)}]`
}

async function requestOriginalStop(ctx, subjects, subject) {
  const { win, read, rect, until, click } = ctx
  await showSubject(ctx, subjects[subject])
  const before = await read('window.graphCapture.listStopStatus()'), point = await rect(cardSelector(subjects[subject]) + ' button.focus-context')
  assert.equal(point.hit, true)
  for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'right', clickCount: 1 })
  await until('original List context menu', () => read(`Boolean(document.querySelector('[role="menu"] [role="menuitem"]'))`))
  await click(await markOriginalButton(ctx, '[role="menuitem"]', 'Stop Agent', 'stop-menu'))
  await until('original Stop confirmation', () => read(`Boolean(document.querySelector('.confirmation-dialog [data-confirm-label="Stop Agent"]'))`))
  await click('.confirmation-dialog [data-confirm-label="Stop Agent"]')
  await until('one original deferred Stop call', async () => (await read('window.graphCapture.listStopStatus()')).calls.length === before.calls.length + 1)
  const current = await read('window.graphCapture.listStopStatus()'), call = current.calls.at(-1)
  assert.equal(call.settled, false); assert.equal(call.control.hostId, subjects[subject].hostId); assert.equal(call.control.agentSessionId, subjects[subject].agentSessionId)
  assert.ok(call.operationId && call.control.run.runId)
  await until('original operation consumes its actual Stop promise', async () => (await read(`(${observe.toString()})(${JSON.stringify(subjects)})`)).cards[subject].operations.some(item => item.operationId === call.operationId && item.phase === 'pending'))
  return call
}

module.exports = async function listFeedback(ctx) {
  const { win, result, read, click, key, move, closeReader, frame, check, facts, intact, pause, until, settle } = ctx
  const data = result.listFeedback = { schema: 'agentmux.focus-list-feedback-native.v1', stages: [], events: [], policies: { independentOff: 'not-applicable' },
    boundary: 'Original App/List/card/operation owners; typed private Host notifications and deferred original API Stop promises only. Native keyboard/pointer, CSSAnimation clocks, actual scrollport and BrowserWindow visibility. No operation/phase props, Provider/Run execution, duration overrides, installed package, persistence, cost or aesthetic approval.' }
  const required = ['listSubjects', 'live', 'listStopStatus', 'listRejectStop']
  assert.equal(await read(`(${JSON.stringify(required)}).every(name=>typeof window.graphCapture[name]==='function')`), true, 'Declared typed fixture seams must be wired by the original entry owner')
  data.subjects = await read('window.graphCapture.listSubjects()')
  for (const name of ['sender', 'recipient', 'otherHost', 'neighbor']) assert.ok(typeof data.subjects[name]?.hostId === 'string' && typeof data.subjects[name]?.agentSessionId === 'string')
  assert.equal(new Set(Object.values(data.subjects).map(subjectKey)).size, Object.keys(data.subjects).length)
  data.original = await facts(); data.beforeStop = await read('window.graphCapture.listStopStatus()')
  const sample = () => read(`(${observe.toString()})(${JSON.stringify(data.subjects)})`)
  const guardedCheck = async (name, action) => { await check(name, action); if (result.failures.length) throw Error('List scene stopped at its first failed native criterion: ' + name) }
  const show = subject => showSubject(ctx, subject)
  const prepare = async (narrow, theme) => {
    await read(`window.graphCapture.appearance(${JSON.stringify(theme)})`)
    win.setContentSize(...(narrow ? [620, 820] : [1440, 900])); await settle(); await show(data.subjects.sender)
    await until('original List appearance', async () => (await sample()).theme === theme)
  }
  const emit = async (sender = data.subjects.sender, recipient = data.subjects.recipient, kind = 'message') => {
    const event = await read(`window.graphCapture.live(true,${JSON.stringify(sender.agentSessionId)},${JSON.stringify(recipient.agentSessionId)},${JSON.stringify(kind)},${JSON.stringify(sender.hostId)})`)
    data.events.push(event); return event
  }
  const capture = async label => {
    const record = { label, before: await sample() }; data.stages.push(record)
    await frame(label, { motion: true }); record.after = await sample(); return record
  }
  const markButton = (selector, text, label) => markOriginalButton(ctx, selector, text, label)
  const openOperation = async (operationId, subject = 'sender') => {
    const readerBefore = await read("Boolean(document.querySelector('.agent-information-reader'))")
    await move('[aria-label="Search contexts"]'); await closeReader()
    ;(data.readerDepartures ??= []).push({ operationId, readerBefore, readerAfter: await read("Boolean(document.querySelector('.agent-information-reader'))"), boundary: 'Original pointer departure and original Close Agent reading control; no CSS, focus assignment, operation replay or skipped summary.' })
    assert.equal(await read(`(()=>{const item=[...document.querySelectorAll(${JSON.stringify(cardSelector(data.subjects[subject]) + ' .agent-operation-feedback__item')})].find(item=>item.querySelector('code')?.textContent===${JSON.stringify(operationId)});if(!item)return false;item.setAttribute('data-list-capture-operation',${JSON.stringify(operationId)});return true})()`), true)
    const selector = `[data-list-capture-operation=${JSON.stringify(operationId)}]`
    const reveal = await read(`(()=>{const summary=document.querySelector(${JSON.stringify(selector + ' summary.agent-operation-feedback__label')}),rows=summary.closest('.focus-project-lanes__rows');const before={bounds:summary.getBoundingClientRect().toJSON(),scrollTop:rows.scrollTop,clip:rows.getBoundingClientRect().toJSON()};summary.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});return before})()`)
    await settle()
    const revealed = await read(`(()=>{const summary=document.querySelector(${JSON.stringify(selector + ' summary.agent-operation-feedback__label')}),rows=summary.closest('.focus-project-lanes__rows');return{bounds:summary.getBoundingClientRect().toJSON(),scrollTop:rows.scrollTop,clip:rows.getBoundingClientRect().toJSON()}})()`)
    ;(data.summaryReveals ??= []).push({ operationId, subject: data.subjects[subject], before: reveal, after: revealed, boundary: 'Reveal the same already-created original operation summary through its real List scrollport, after the original Reader exits. No focus, layout assignment or Stop replay.' })
    await click(selector + ' summary.agent-operation-feedback__label')
    return selector
  }
  const originalStop = subject => requestOriginalStop(ctx, data.subjects, subject)
  await click('button.surface-navigation__focus'); await click('[aria-label="List"]')
  await until('original App List mounted', async () => (await sample()).listVisible)
  data.nativeWindow = { beforeShow: { visible: win.isVisible(), focused: win.isFocused() } }
  win.showInactive(); result.conditions.privateWindowShown = true
  data.nativeWindow.afterShow = { visible: win.isVisible(), focused: win.isFocused() }
  assert.equal(data.nativeWindow.afterShow.visible, true); assert.equal(data.nativeWindow.afterShow.focused, data.nativeWindow.beforeShow.focused)
  await guardedCheck(checks[0], async () => {
    await prepare(false, 'dark'); await capture(frames[0])
    const middle = { label: frames[1], ...await read(`(${movingMiddle.toString()})(${observe.toString()},${paintObservation.toString()},${JSON.stringify(data.subjects)})`) }
    data.events.push(middle.event); data.stages.push(middle)
    assert.equal(middle.failure, undefined, middle.failure); verifyPaintedAdvance(middle.previous, middle.before)
    middle.after = await frame(frames[1], { motion: true, immediateObservation: `(${paintObservation.toString()})(${observe.toString()},${JSON.stringify(data.subjects)})` })
    verifyMiddle(middle); await pause(180); await capture(frames[2])
    await prepare(false, 'light'); await emit(data.subjects.sender, data.subjects.sender); await pause(180); await capture(frames[3])
    await prepare(true, 'light'); await emit(data.subjects.sender, data.subjects.recipient, 'dispatch-open'); await pause(180); await capture(frames[4])
    await prepare(true, 'dark'); await emit(); await pause(180); data.isolation = { before: await sample() }
    await emit(data.subjects.otherHost, data.subjects.otherHost); await pause(180); await capture(frames[5])
    data.observationBeforeStop = await intact(false, false)
  })
  await guardedCheck(checks[1], async () => {
    await prepare(false, 'dark'); await show(data.subjects.sender)
    data.viewport = await read(`(${viewportTrip.toString()})(${observe.toString()},${JSON.stringify(data.subjects)})`)
    data.events.push(data.viewport.event); await capture(frames[6]); verifyViewport(data.viewport)
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    try { await emit(); await pause(180); await capture(frames[7]) }
    finally { await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }) }
    data.policies.nativeVisibility = { focusEmulationBefore: result.conditions.focusEmulated, controls: [] }
    await read(`(()=>{globalThis.__listVisibilityEvents=[];globalThis.__listVisibilityListener=()=>globalThis.__listVisibilityEvents.push({at:performance.now(),wall:Date.now(),hidden:document.hidden,visibility:document.visibilityState,focused:document.hasFocus()});document.addEventListener('visibilitychange',globalThis.__listVisibilityListener)})()`)
    win.webContents.setBackgroundThrottling(true); win.showInactive(); result.conditions.privateWindowShown = true
    try {
      await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false })
      data.policies.nativeVisibility.controls.push({ focusEmulation: false, observed: await sample() })
      await pause(80); win.hide()
      await until('actual source document becomes hidden', () => read('document.hidden&&document.visibilityState==="hidden"'))
      await until('original hidden List work owner parks', async () => { const current = await sample(); return current.hidden && ['sender', 'recipient'].every(name => !current.cards[name]?.feedback?.active) })
      await emit(); data.policies.hidden = await sample()
      win.showInactive()
      await until('actual source document returns visible without focus emulation', () => read('!document.hidden&&document.visibilityState==="visible"'))
      await settle(); data.policies.returned = await sample(); data.policies.nativeVisibility.focusEmulationAtReturn = false
    } finally {
      win.showInactive()
      await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
      win.webContents.setBackgroundThrottling(false)
      data.policies.nativeVisibility.controls.push({ focusEmulation: true, observed: await sample() })
      data.policies.nativeVisibility.events = await read(`(()=>{document.removeEventListener('visibilitychange',globalThis.__listVisibilityListener);return globalThis.__listVisibilityEvents})()`)
    }
    await capture(frames[8]); await intact(false, false)
  })
  await guardedCheck(checks[2], async () => {
    await prepare(false, 'dark')
    const pending = await originalStop('sender'); await capture(frames[9])
    const selector = cardSelector(data.subjects.sender), summary = selector + ' summary.agent-operation-feedback__label'
    await click(summary); await key('Tab'); await capture(frames[10])
    const close = await markButton(selector + ' .agent-operation-feedback__actions button', '收起', 'close-original-detail')
    for (let attempts = 0; attempts < 5 && !await read(`document.activeElement===document.querySelector(${JSON.stringify(close)})`); attempts++) await key('Tab')
    const insideClose = await read(`document.activeElement===document.querySelector(${JSON.stringify(close)})&&Boolean(document.activeElement.closest('.agent-operation-feedback__detail'))`)
    assert.equal(insideClose, true); await key('Enter'); await capture(frames[11])
    await key('Tab'); const tabEnteredClosedDetail = await read(`Boolean(document.activeElement?.closest('.agent-operation-feedback__detail[inert]'))`)
    assert.equal(tabEnteredClosedDetail, false)
    await prepare(true, 'light'); const unknown = await originalStop('recipient')
    await read(`window.graphCapture.listRejectStop(${JSON.stringify(unknown.operationId)},{code:'FIXTURE_OBSERVATION_UNAVAILABLE',message:'Private typed Stop transport observation unavailable; keep this original request.'})`)
    await until('original unconfirmed Stop reference', async () => (await sample()).cards.recipient.operations.some(item => item.operationId === unknown.operationId && item.phase === 'unconfirmed'))
    const unknownPanel = await openOperation(unknown.operationId, 'recipient'); await capture(frames[12])
    await click(await markButton(unknownPanel + ' .agent-operation-feedback__actions button', '收起', 'close-unconfirmed-detail'))
    await prepare(false, 'dark'); const failed = await originalStop('neighbor')
    await read(`window.graphCapture.listRejectStop(${JSON.stringify(failed.operationId)},{code:'STALE_AGENT_SESSION',message:'Private typed Stop result identifies the original Run as stale.'})`)
    await until('original failed Stop reference', async () => (await sample()).cards.neighbor.operations.some(item => item.operationId === failed.operationId && item.phase === 'failed'))
    await openOperation(failed.operationId, 'neighbor'); await capture(frames[13]); await show(data.subjects.sender)
    data.stop = { ...await read('window.graphCapture.listStopStatus()'), insideClose, tabEnteredClosedDetail }
    assert.equal(data.stop.calls[0].operationId, pending.operationId)
    data.after = await facts(); protectedFacts(data.after, data.original)
  })
  verify(data, result.frames)
}
module.exports.verify = verify
module.exports.observe = observe
module.exports.paintObservation = paintObservation
module.exports.movingMiddle = movingMiddle
module.exports.verifyClockSample = verifyClockSample
module.exports.verifyPaintedAdvance = verifyPaintedAdvance
module.exports.requestOriginalStop = requestOriginalStop
module.exports.verifyViewport = verifyViewport
module.exports.verifyStopTargets = verifyStopTargets
module.exports.frames = frames
module.exports.checks = checks
