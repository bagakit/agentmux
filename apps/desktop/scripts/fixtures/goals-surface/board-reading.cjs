const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { readFile } = require('node:fs/promises')

/** A portable public sample. Original user records enter only via the explicit private snapshot. */
function sample() {
  const createdAt = Date.UTC(2025, 0, 8)
  const base = { description: 'Preserve the selected workspace and its unsent changes.', projectId: 'workspace', projectName: 'Workspace',
    priority: 'normal', executorId: null, assigneeSessionIds: [], supervisorSessionId: null, participations: [], tags: [],
    activities: [], decisions: [], plannedStartAt: null, targetAt: null, parentGoalId: null, phaseIndex: null, createdAt, updatedAt: createdAt, sessionIds: [], source: 'default-topic' }
  const prompt = '# Workspace navigation\n\n## Reading position\n\nKeep the selected document and restore its reading position.\n\n- Open the original document.\n- Restore the selection.\n\n## Verification\n\nRecord the expected and observed selection after reopening the workspace.'
  const start = { operationId: 'open-document', execution: 'finite', hostId: 'workstation', agentSessionId: 'navigation-editor',
    runId: 'original-navigation-run', stage: 'confirmed', prompt, preparedAt: createdAt, submittedAt: createdAt,
    receipt: { kind: 'core-prompt', itemId: 'document-request-receipt', createdAt } }
  const inventory = [
    { ...base, id: 'document-recovery', title: 'Restore the active document', status: 'done' },
    { ...base, id: 'navigation', title: 'Keep the navigation history', status: 'in_progress', dispatches: [start] },
    { ...base, id: 'draft', title: 'Preserve unsent changes', status: 'backlog' },
    { ...base, id: 'workspace-check', title: 'Verify the original workspace', status: 'done', alignment: {
      summary: 'Keep working in the same workspace.', revision: 1, confirmedAt: null, openQuestions: [], criteria: [{ id: 'workspace', text: 'Restore the same workspace.' }] } }
  ]
  const observations = Object.fromEntries(inventory.map(goal => [goal.id, { goalId: goal.id, goalUpdatedAt: createdAt,
    delegations: [], diskDurability: 'confirmed', dispatches: goal.dispatches ?? [] }]))
  return { inventory, observations, startGoal: 'navigation', unverifiedGoal: 'document-recovery' }
}

const q = selector => 'document.querySelector(' + JSON.stringify(selector) + ')'
const goalRow = id => '.goals-board [data-demand-id=' + JSON.stringify(id) + ']'
const pressEnter = async session => {
  for (const type of ['rawKeyDown', 'char', 'keyUp']) await session.sendCommand('Input.dispatchKeyEvent', {
    type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    ...(type === 'char' ? { text: String.fromCharCode(13) } : {}) })
}

module.exports = async ({ evaluate, size, click, capture, waitFor, paint, result, debuggerSession }) => {
  const snapshot = process.env.AGENTMUX_BOARD_READING_SNAPSHOT
  const source = snapshot ? await readFile(snapshot) : Buffer.from(JSON.stringify(sample()))
  const input = JSON.parse(source), { inventory, unverifiedGoal, startGoal } = input
  const original = inventory.find(goal => goal.id === startGoal)?.dispatches.find(start => start.execution === 'finite' && typeof start.prompt === 'string')
  const done = inventory.find(goal => goal.id === unverifiedGoal)
  assert.ok(original && done?.status === 'done' && !done.grounding && !done.alignment)
  assert.ok(inventory.length > 2 && new Set(inventory.map(goal => goal.id)).size === inventory.length)
  assert.ok(inventory.every(goal => input.observations[goal.id]?.goalId === goal.id), 'Every displayed Goal has its own read receipt')
  result.source = { kind: snapshot ? 'explicit-private-snapshot' : 'portable-sample', sha256: createHash('sha256').update(source).digest('hex'),
    goals: inventory.length, originalRequestCharacters: original.prompt.length }

  await evaluate('goalsWorkScenes.readBoard(' + JSON.stringify(input) + ')')
  await waitFor('Boolean(' + q('[aria-label="Board view"]') + ')')
  await click(q('[aria-label="Board view"]'))
  const attention = '[data-goal-flow-stage="attention"]', all = '[data-goal-flow-all]', cards = '.goals-board [data-demand-id]'
  const ids = () => evaluate('[...document.querySelectorAll(' + JSON.stringify(cards) + ')].map(row => row.dataset.demandId).sort()')
  const detail = '.goals-detail', work = '[data-goal-work-kind="start"]', reader = work + ' .goal-request-reader'
  const take = async (name, width) => {
    assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false, 'Frame fits the actual workface')
    await capture(name, width)
  }
  const open = async id => {
    await click(q(goalRow(id) + ' .goals-row__copy > strong'))
    await waitFor(q(detail) + '?.dataset.goalDetailId === ' + JSON.stringify(id))
  }
  const back = async () => {
    await click(q('[aria-label="Back to goals"]'))
    await waitFor('Boolean(' + q('.goals-board') + ')')
  }

  for (const [width, height, theme] of [[1600, 980, 'dark'], [620, 840, 'light']]) {
    await size(width, height)
    await debuggerSession.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: width === 620 ? 'reduce' : 'no-preference' }] })
    await evaluate('goalsVisual.appearance(' + JSON.stringify(theme) + ')')
    await waitFor('Boolean(' + q(attention) + ')')
    const visible = await ids()
    assert.ok(visible.includes(unverifiedGoal) && visible.includes(startGoal))
    assert.equal(new Set(visible).size, visible.length)
    await take(width + '-' + theme + '-board', width)
    const roleBounds = await evaluate(`[...document.querySelectorAll('.goals-board [data-goal-board-role]')].map(role => {
      const bounds = role.getBoundingClientRect(), card = role.closest('[data-demand-id]').getBoundingClientRect()
      return { left: bounds.left - card.left, right: card.right - bounds.right }
    })`)
    assert.ok(roleBounds.length > 0 && roleBounds.every(item => item.left >= -1 && item.right >= -1),
      'Each visible role fits its own card, including historical team references')
    if (width === 1600) {
      await evaluate(`document.addEventListener('animationstart', function record(event) {
        if (!event.target.closest('[data-goal-flow-stage="attention"]')) return
        const animation = event.target.getAnimations().find(item => item.animationName === event.animationName)
        if (!animation) return
        document.removeEventListener('animationstart', record)
        animation.pause()
        animation.currentTime = Number(animation.effect.getTiming().duration) / 2
        window.boardSelectionAnimation = animation
      })`)
    }
    await evaluate(q(attention) + '.focus()')
    await pressEnter(debuggerSession)
    await waitFor(q(attention) + '.getAttribute("aria-pressed") === "true"')
    if (width === 1600) {
      await waitFor('Boolean(window.boardSelectionAnimation)')
      await take('1600-dark-selection-motion', width)
      await evaluate('window.boardSelectionAnimation.play()')
      await evaluate('window.boardSelectionAnimation.finished.then(() => true)')
    } else {
      assert.equal(await evaluate(q(attention) + '.getAnimations({ subtree: true }).length'), 0, 'Reduced motion keeps the selected control static')
    }
    const filtered = await ids()
    assert.ok(filtered.includes(unverifiedGoal) && filtered.length < visible.length && filtered.every(id => visible.includes(id)), 'Attention selects the original unverified Goal and narrows the board')
    await take(width + '-' + theme + '-attention', width)

    const cardConclusion = await evaluate(q(goalRow(unverifiedGoal) + ' .goals-row__next') + '.textContent')
    await open(unverifiedGoal)
    const stage = await evaluate(q('[data-goal-detail-stage]') + '.textContent')
    assert.equal(stage, cardConclusion, 'Board and detail read the same conclusion')
    assert.match(stage, /marked done.*no verification report/i)
    const actions = await evaluate('[...document.querySelectorAll(".goals-detail__actions button")].map(button => button.textContent.trim())')
    assert.ok(!actions.includes('Read results'), 'A missing result never offers a report to read')
    assert.equal(await evaluate(q('[data-goal-grill]') + '.textContent.trim()'), 'Draft criteria from brief')
    await take(width + '-' + theme + '-unverified', width)
    if (width === 1600) {
      const properties = '.goals-detail__properties'
      await click(q(properties + ' > summary'))
      await waitFor(q(properties) + '.open')
      await evaluate('Promise.all(' + q(properties) + '.getAnimations({subtree: true}).map(a => a.finished))')
      const lastField = properties + ' .goals-properties > summary'
      await evaluate(q(lastField) + '.scrollIntoView({block: "nearest"})')
      await paint()
      const rail = await evaluate(`(() => {
        const side = ${q('.goals-detail__side')}, last = ${q(lastField)}, edge = last.getBoundingClientRect()
        return { clientHeight: side.clientHeight, scrollHeight: side.scrollHeight, bottom: side.getBoundingClientRect().bottom,
          lastBottom: edge.bottom, reachable: last.contains(document.elementFromPoint(edge.left + edge.width / 2, edge.top + edge.height / 2)) }
      })()`)
      assert.ok(rail.reachable && rail.lastBottom <= rail.bottom + 1, 'The final property control is fully exposed after the disclosure settles')
      result.observations.push({ scene: 'properties-expanded', rail })
      await take('1600-dark-properties', width)
      await click(q(properties + ' > summary'))
    }
    await back()
    assert.deepEqual(await ids(), filtered, 'Returning restores the exact filtered board')
    await click(q(all))
    await waitFor(q(attention) + '.getAttribute("aria-pressed") === "false"')
    assert.deepEqual(await ids(), visible)
    await open(startGoal)
    if (inventory.find(goal => goal.id === startGoal)?.plan == null) {
      assert.equal(await evaluate(q('.goal-plan__assignment-toggle') + ' === null'), true)
      const discussion = '[aria-label^="Open discussion for "]'
      assert.equal(await evaluate('document.querySelectorAll(' + JSON.stringify(discussion) + ').length'), 1)
      const discussionPlacement = await evaluate(`(() => {
        const header = ${q('.goals-detail__overview-heading')}, title = header.querySelector('h2').getBoundingClientRect(),
          button = header.querySelector(${JSON.stringify(discussion)}).getBoundingClientRect();
        return { gap: button.left - title.right, centers: Math.abs((title.top + title.bottom - button.top - button.bottom) / 2) };
      })()`)
      assert.ok(discussionPlacement.gap >= 0 && discussionPlacement.gap <= 28 && discussionPlacement.centers < 3,
        'Discussion stays visually attached to the overview title: ' + JSON.stringify(discussionPlacement))
      await take(width + '-' + theme + '-goal-detail', width)
    }
    const originalInspection = '.goals-detail__current-work'
    if (await evaluate(q(originalInspection) + '?.textContent === "View original inspection"')) {
      await click(q(originalInspection))
      const inspection = '.goals-detail__side [data-goal-work-kind="patrol"]'
      await waitFor('document.activeElement === ' + q(inspection))
      assert.equal(await evaluate('document.querySelectorAll("[data-goal-work-kind=patrol]").length'), 1)
      assert.equal(await evaluate(q('.goal-work-area .goal-patrol') + ' === null'), true)
      await take(width + '-' + theme + '-supervisor-inspection', width)
      if (width === 620) {
        await click(q('[data-goal-supervisor-toggle]'))
        await waitFor(q(detail) + '.dataset.goalView === "work"')
      }
      const planning = '.goal-supervisor-rail__planning'
      assert.ok(await evaluate(q(planning + ' [data-goal-plan-request]') + ' && !' + q('.goal-plan [data-goal-plan-request]')))
      const openPlanning = '[aria-label="Goal plan"] .goal-plan__tools button:last-child'
      await evaluate(q(openPlanning) + '.scrollIntoView({block: "center"})')
      await paint()
      await click(q(openPlanning))
      await waitFor('document.activeElement === ' + q(planning))
      await take(width + '-' + theme + '-supervisor-planning', width)
      if (width === 620) {
        const progress = '.goal-supervisor-rail__progress > summary'
        await evaluate(q(progress) + '.scrollIntoView({block: "center"})')
        await paint()
        await click(q(progress))
        await waitFor('Boolean(' + q('.goal-supervisor-rail__progress[open] .goals-continuation') + ')')
        await take(width + '-' + theme + '-supervisor-progress', width)
        await click(q(progress))
        await click(q('[data-goal-supervisor-toggle]'))
        await waitFor(q(detail) + '.dataset.goalView === "work"')
      }
    }
    const records = '[data-goal-other-work]'
    if (await evaluate('Boolean(' + q(records) + ') && !' + q(records) + '.parentElement.open')) await click(q(records))
    await click(q(reader + ' > summary'))
    await waitFor('Boolean(' + q(reader + ' .goal-request-reader__document') + ')')
    // Position the real original work item exactly as a reader scrolling down to it would.
    await evaluate(q(work) + '.scrollIntoView({ block: "start" })')
    await paint()
    const headings = await evaluate(q(reader + ' .goal-request-reader__document') + '.querySelectorAll("h1,h2,h3").length')
    assert.ok(headings > 0, 'The saved Markdown request has rendered document headings')
    await take(width + '-' + theme + '-original-request', width)
    await click(q(reader + ' [data-option="source"]'))
    assert.equal(await evaluate(q(reader + ' pre') + '.textContent'), original.prompt, 'Source preserves every character of the original request')
    await click(q(reader + ' [data-option="execution"]'))
    assert.ok(await evaluate(q(reader + ' .goal-request-reader__details') + '.textContent.includes(' + JSON.stringify(original.operationId) + ')'))
    await evaluate(q(work) + '.scrollIntoView({ block: "start" })')
    await take(width + '-' + theme + '-execution-details', width)
    await back()
    result.observations.push({ width, theme, visibleCount: visible.length, attentionCount: filtered.length, stage, headings })
  }
}
