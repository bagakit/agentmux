import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openDemandStore } from '../../../packages/demand/dist/src/index.js'

// Reuses the ordinary Desktop crash harness. Only proposal data is seeded; all approvals
// come from keyboard activation of the mounted production UI through the actual Main owner.
export async function createGoalsRestartFixture({ root, userData, workspaceId, session }) {
  const evidence = join(root, 'verification.log')
  await writeFile(evidence, 'Private proof: original Run remains input-capable across UI restart.\n')
  const owner = openDemandStore({ root: join(userData, 'demands') })
  const id = 'private-goals-restart'
  await owner.create({ id, title: 'Keep the goal and original workspace after restart',
    description: 'Grill aligns the goal. Grounding checks the result against this goal.',
    projectId: workspaceId, projectName: 'Crash fixture', sessionIds: [session.agentSessionId] })
  await owner.proposeAlignment(id, { summary: 'Restore this goal and the exact existing workspace.',
    criteria: [{ id: 'workspace', text: 'The original Session, Run and split workspace stay recoverable.' }], openQuestions: [] })
  const proposed = await owner.get(id)
  await owner.proposeGrounding(id, { alignmentRevision: proposed.alignment.revision,
    summary: 'The private restart fixture checks the saved workspace and live Run.',
    checks: [{ criterionId: 'workspace', outcome: 'met', evidence: [evidence], note: 'Synthetic fixture evidence, requiring explicit human review.' }] })
  const initial = await owner.get(id)
  assert.equal(initial.alignment.confirmedAt, null)
  assert.equal(initial.grounding.acceptedAt, null)
  return { id, owner, initial, evidenceDigest: createHash('sha256').update(await readFile(evidence)).digest('hex') }
}

export async function approveGoalsInActualUI({ cdp, fixture, activateButton, waitFor }) {
  await activateButton(cdp, 'document.querySelector(\'[aria-label="Goals: show goals and progress"]\')')
  await waitFor('actual saved Goal row', () => cdp.evaluate(`Boolean(document.querySelector('[data-demand-id="${fixture.id}"]'))`))
  await activateButton(cdp, `document.querySelector('[data-demand-id="${fixture.id}"]')`)
  await waitFor('actual goal confirmation', () => cdp.evaluate('Boolean(document.querySelector("[data-goal-confirm]"))'))
  await activateButton(cdp, 'document.querySelector("[data-goal-confirm]")')
  await waitFor('Main owner durable goal approval', async () => (await fixture.owner.get(fixture.id)).alignment.confirmedAt)
  await waitFor('actual result acceptance', () => cdp.evaluate('Boolean(document.querySelector("[data-goal-accept]:not(:disabled)"))'))
  await activateButton(cdp, 'document.querySelector("[data-goal-accept]")')
  const accepted = await waitFor('Main owner durable result acceptance', async () => {
    const goal = await fixture.owner.get(fixture.id)
    return goal.grounding.acceptedAt ? goal : null
  })
  assert.equal(accepted.alignment.revision, fixture.initial.alignment.revision)
  assert.equal(accepted.grounding.submissionId, fixture.initial.grounding.submissionId)
  assert.equal(accepted.status, fixture.initial.status, 'Human acceptance is independent of execution status')
  return accepted
}

export async function readGoalsSurface(cdp) {
  return cdp.evaluate(`(()=>{const state=JSON.parse(localStorage.getItem('agentmux-workbench-v1')).state;
    return {surface:state.mainSurface,selectedDemandId:state.selectedDemandId,workbench:state.restoredWorkbench,
      focus:state.agentFocus,text:document.querySelector('.goals-detail')?.innerText,
      goal:document.querySelector('[data-goal-alignment-revision]')?.dataset,
      result:document.querySelector('[data-goal-grounding-submission]')?.dataset}})()`)
}

export async function restoreGoalsBeforeSpace({ cdp, fixture, accepted, expectedWorkbench, expectedFocus, waitFor, focusOriginal }) {
  const observed = await waitFor('restored Goals selected detail before Space navigation', async () => {
    const value = await readGoalsSurface(cdp)
    return value.surface === 'board' && value.selectedDemandId === fixture.id && value.text ? value : null
  })
  assert.deepEqual(observed.workbench, expectedWorkbench)
  assert.deepEqual(observed.focus, expectedFocus)
  assert.deepEqual(await fixture.owner.get(fixture.id), accepted, 'Proposal identities and owner approval survive another real Electron process')
  const mainRead = await cdp.evaluate('window.agentmux.demands.list()')
  assert.deepEqual(mainRead.find(goal => goal.id === fixture.id), accepted)
  assert.ok(observed.text.includes(fixture.initial.alignment.summary))
  assert.ok(observed.text.includes(fixture.initial.grounding.summary))
  await focusOriginal()
  return { selectedGoalRestoredBeforeNavigation: true, exactProposalAndApprovalRestored: true,
    originalWorkspaceRestoredBeforeNavigation: true, selectedDemandId: observed.selectedDemandId,
    alignmentRevision: accepted.alignment.revision, submissionId: accepted.grounding.submissionId,
    confirmedAt: accepted.alignment.confirmedAt, acceptedAt: accepted.grounding.acceptedAt,
    evidenceDigest: fixture.evidenceDigest }
}
