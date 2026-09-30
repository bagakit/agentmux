import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { PMO_TEAMS_TOPIC_ID, scratchTopicDirectoryName } from '../src/shared/scratch-topics.ts'
import { openDemandStore } from '../../../packages/demand/dist/src/index.js'

const exec = promisify(execFile)
const digest = value => createHash('sha256').update(value).digest('hex')
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
const requests = {
  understand: '我还不知道能做什么，可以了解我并给我建议吗？',
  ideas: '我有一些点子，我们开始尝试一个项目'
}
const sourceFiles = [
  'scripts/goals-entry-restart-proof.mjs', 'scripts/verify-workbench-persistence-restart.mjs',
  'src/renderer/src/components/GlobalBoardSurface.tsx', 'src/renderer/src/components/NewTabSurface.tsx',
  'src/renderer/src/lib/goals-entry-actions.ts', 'src/renderer/src/lib/workbench-tabs.ts',
  'src/renderer/src/lib/workbench-persistence.ts', 'src/renderer/src/store.ts', 'src/renderer/src/styles/goals.css',
  'src/shared/scratch-topics.ts', 'src/renderer/src/lib/goals-direct-pmo.ts',
  'src/renderer/src/components/GoalDetail.tsx', 'src/renderer/src/components/GoalAlignment.tsx'
]

async function sources(desktopRoot) {
  const facts = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, digest(await readFile(join(desktopRoot, file)))])))
  const context = 'src/renderer/src/lib/goal-project-context.ts'
  try { facts[context] = digest(await readFile(join(desktopRoot, context))) }
  catch (error) { if (error.code !== 'ENOENT') throw error; facts[context] = null }
  return facts
}

async function birth(pid) {
  try {
    const { stdout } = await exec('/bin/ps', ['-p', String(pid), '-o', 'pid=,pgid=,lstart='], { env: { ...process.env, LC_ALL: 'C' }, timeout: 5000 })
    return stdout.trim()
  } catch (error) { if (error.code === 1) return null; throw error }
}

function parseBirth(text) {
  const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(text)
  assert.ok(match, 'Only an exact private PID/group/birth record permits cleanup')
  const pid = Number(match[1]), group = Number(match[2])
  assert.ok(pid > 1 && group > 1)
  assert.equal(group, pid, 'The exact private wrapper/cat must lead its own detached group; never reap a shared Runtime group')
  return { pid, group, born: match[3] }
}

// The ordinary crash harness creates only its original workspace/Run. New Topic identities and
// launch requests below always come from keyboard activation of the mounted production CTA.
export async function createGoalsEntryFixture({ root, userData, topicsPath, desktopRoot, directGoal = false, receiptPath }) {
  const directory = join(root, 'goals-entry-runs'), executable = join(root, 'goals-entry-cat.sh')
  await mkdir(directory, { mode: 0o700 })
  await writeFile(executable, `#!/bin/sh\numask 077\nproof_directory=${quote(directory)}\ntest -n "$AGENTMUX_AGENT_SESSION_ID" && test -n "$AGENTMUX_AGENT_CAPABILITY" && test -n "$AGENTMUX_LIFECYCLE_OPERATION_ID" || exit 64\nLC_ALL=C /bin/ps -p "$$" -o pid=,pgid=,lstart= > "$proof_directory/$AGENTMUX_AGENT_SESSION_ID.birth"\nprintf '%s\\0' "$@" > "$proof_directory/$AGENTMUX_AGENT_SESSION_ID.argv"\nprintf 'Private Goals entry PTY\\n'\nexec /bin/cat\n`, { mode: 0o700 })
  const rawDirectory = receiptPath ? join(dirname(receiptPath), 'raw') : null
  if (rawDirectory) await mkdir(rawDirectory, { recursive: true, mode: 0o700 })
  return { directory, executable, topicsPath, topicsMode: (await stat(topicsPath)).mode & 0o777,
    sourceBefore: await sources(desktopRoot), desktopRoot, agents: [], directGoal, rawDirectory,
    ...(directGoal ? { owner: openDemandStore({ root: join(userData, 'demands') }), demandStorePath: join(userData, 'demands/store.json') } : {}) }
}

async function retainRaw(fixture, name, bytes) {
  const evidence = { sha256: digest(bytes), bytes: bytes.length }
  if (fixture.rawDirectory) {
    evidence.path = join(fixture.rawDirectory, name)
    await writeFile(evidence.path, bytes, { mode: 0o600 })
  }
  return evidence
}

async function state(cdp) {
  return cdp.evaluate(`JSON.parse(localStorage.getItem('agentmux-workbench-v1')).state`)
}

function newTopic(value, previousIds) {
  const tabs = Object.values(value.restoredWorkbench.tabs).filter(tab => !previousIds.includes(tab.id) && tab.workspaceId === '__scratch__' && tab.topicId)
  assert.ok(tabs.length <= 1, 'One real CTA click must not create multiple Topic Tabs')
  if (!tabs.length) return null
  const tab = tabs[0], region = tab.regions[tab.layout.activeRegionId]
  return { tab, region, draft: value.agentComposerDrafts[region.regionId] ?? null }
}

async function launchEvidence(cdp, fixture, topic, request, waitFor) {
  const snapshot = await waitFor('same CTA Region has a live Main/Core Session', async () => {
    const reply = await cdp.evaluate('window.agentmux.sessions.snapshot()')
    return reply.sessions.find(session => session.id === topic.region.sessionId && session.processState === 'running')
  })
  const metadata = await cdp.evaluate(`window.agentmux.scratch.readTopic('__scratch__', ${JSON.stringify(topic.tab.topicId)})`)
  assert.equal(metadata?.id, topic.tab.topicId)
  if (!fixture.directGoal) assert.ok(metadata.soul?.content, 'The same real Topic has a prepared Mote SOUL')
  assert.equal(metadata.directoryPath, scratchTopicDirectoryName(topic.tab.topicId))
  const directory = await realpath(join(fixture.topicsPath, metadata.directoryPath))
  assert.equal(snapshot.workspacePath, directory, 'Main launches the CTA Session in its exact real Topic directory')
  const created = await waitFor('Core confirms the provider launch request', async () => {
    const reply = await cdp.evaluate(`window.agentmux.sessions.creation('local', ${JSON.stringify(snapshot.id)})`)
    return reply.creation?.initialPrompt === 'confirmed' ? reply : null
  })
  const argv = await readFile(join(fixture.directory, `${snapshot.id}.argv`))
  assert.ok(argv.length > 0, 'Actual exec argv must be nonempty')
  const args = argv.toString('utf8').split('\0').filter(Boolean)
  const matching = args.filter(arg => arg.includes(fixture.directGoal ? `You are Mote for existing Goal ${topic.goalId}.` : request))
  assert.equal(matching.length, 1, 'The visible request must reach exactly one actual launch argument')
  if (fixture.directGoal) {
    assert.ok(matching[0].includes('existing undefined Goal draft'))
    assert.ok(matching[0].includes('update this same Goal ID'))
    assert.ok(matching[0].includes('Do not create another Goal'))
    assert.ok(matching[0].includes(`"id": "${topic.goalId}"`))
    assert.ok(matching[0].includes('"description": ""'))
  } else {
    assert.equal(matching[0].split(request).length - 1, 1, 'The launch argument contains the exact request once')
    assert.equal(matching[0].split('\n').at(-1), request, 'The user request line remains byte-for-byte equal to the visible CTA')
  }
  const recordedBirth = (await readFile(join(fixture.directory, `${snapshot.id}.birth`), 'utf8')).trim()
  const process = parseBirth(recordedBirth)
  assert.equal(await birth(process.pid), recordedBirth, 'The actual private cat process is still the recorded birth')
  const agent = { tabId: topic.tab.id, topicId: topic.tab.topicId, regionId: topic.region.regionId,
    agentSessionId: snapshot.id, run: snapshot.control.run, workspacePath: directory,
    soulDigest: metadata.soul?.content ? digest(metadata.soul.content) : null, process, birth: recordedBirth,
    request, requestDigest: digest(request), inputTransport: 'provider-launch-argv',
    requestOccurrences: 1, initialPrompt: created.creation.initialPrompt,
    ...(fixture.directGoal ? { goalId: topic.goalId, launchArgument: matching[0],
      argv: await retainRaw(fixture, `${snapshot.id}.argv`, argv),
      processBirth: await retainRaw(fixture, `${snapshot.id}.birth`, Buffer.from(recordedBirth)) } : {}) }
  fixture.agents.push(agent)
  return agent
}

export async function clickGoalsEntryInActualUI({ cdp, fixture, activateButton, waitFor, expectedOriginalWorkbench, expectedOriginalFocus }) {
  if (fixture.directGoal) return await clickDirectGoalInActualUI({ cdp, fixture, activateButton, waitFor, expectedOriginalWorkbench, expectedOriginalFocus })
  await activateButton(cdp, `document.querySelector('[aria-label="Goals: show goals and progress"]')`)
  await waitFor('real Goals understand CTA', () => cdp.evaluate(`Boolean(document.querySelector('button[data-goals-entry-action="understand"]'))`))
  const before = await state(cdp)
  await activateButton(cdp, `document.querySelector('button[data-goals-entry-action="understand"]')`)
  const normal = await waitFor('CTA creates an attached real Topic Region', async () => {
    const value = await state(cdp), topic = newTopic(value, Object.keys(before.restoredWorkbench.tabs))
    return topic?.region.kind === 'agent' && topic.region.phase === 'attached' ? topic : null
  })
  assert.equal(normal.tab.topicPreparation, undefined)
  assert.notEqual(normal.draft, requests.understand, 'Successful launch clears the original Region request')
  fixture.normal = await launchEvidence(cdp, fixture, normal, requests.understand, waitFor)
  await activateButton(cdp, `document.querySelector('[aria-label="Goals: show goals and progress"]')`)
  await waitFor('real Goals ideas CTA', () => cdp.evaluate(`Boolean(document.querySelector('button[data-goals-entry-action="ideas"]'))`))
  const beforeFailure = await state(cdp)
  try {
    // Only this private filesystem becomes temporarily unwritable. The actual Main owner must
    // fail preparation; no transport/function replacement and no expected Topic is seeded.
    await chmod(fixture.topicsPath, 0o500)
    await activateButton(cdp, `document.querySelector('button[data-goals-entry-action="ideas"]')`)
    fixture.failed = await waitFor('failed preparation retains the exact real launcher and request', async () => {
      const value = await state(cdp), topic = newTopic(value, Object.keys(beforeFailure.restoredWorkbench.tabs))
      if (topic?.region.kind !== 'launcher' || topic.tab.topicPreparation !== 'mote' || topic.draft !== requests.ideas) return null
      const shown = await cdp.evaluate(`document.querySelector('[data-workbench-region-id="${topic.region.regionId}"]')?.innerText.toLowerCase()`)
      if (!shown?.includes('preparation') || !shown.includes('not been sent')) return null
      const directory = join(await realpath(fixture.topicsPath), scratchTopicDirectoryName(topic.tab.topicId))
      const cause = await cdp.evaluate(`Array.from(document.querySelectorAll('.error-notice__original')).map(node => node.textContent).find(text => text.includes('EACCES') && text.includes('mkdir') && text.includes(${JSON.stringify(directory)}))`)
      if (!cause) return null
      fixture.preparationFailure = { code: 'EACCES', operation: 'mkdir', workspacePath: directory }
      return topic
    })
    // Expand the actual error details while the filesystem is still unwritable; the initial
    // preparation marker alone says unknown and cannot establish this failed Main mkdir.
    await activateButton(cdp, `Array.from(document.querySelectorAll('.error-notice__original')).find(node => node.textContent.includes(${JSON.stringify(fixture.preparationFailure.workspacePath)})).closest('details').querySelector('summary')`)
    await waitFor('actual preparation cause is visible', () => cdp.evaluate(`Array.from(document.querySelectorAll('.error-notice__original')).some(node => node.textContent.includes(${JSON.stringify(fixture.preparationFailure.workspacePath)}) && node.getClientRects().length > 0)`))
  } finally { await chmod(fixture.topicsPath, fixture.topicsMode) }
  assert.notEqual(fixture.failed.tab.id, fixture.normal.tabId)
  assert.notEqual(fixture.failed.tab.topicId, fixture.normal.topicId)
  assert.equal((await readdir(fixture.directory)).filter(name => name.endsWith('.argv')).length, 1, 'Preparation failure starts no second Agent')
  const after = await state(cdp)
  for (const [id, tab] of Object.entries(expectedOriginalWorkbench.tabs)) assert.deepEqual(after.restoredWorkbench.tabs[id], tab)
  for (const [id, layout] of Object.entries(expectedOriginalWorkbench.layouts)) {
    if (id !== '__scratch__') assert.deepEqual(after.restoredWorkbench.layouts[id], layout)
  }
  assert.deepEqual(after.agentFocus.execution, expectedOriginalFocus.execution, 'Exploration never steals the original execution focus')
  fixture.expectedWorkbench = after.restoredWorkbench
  fixture.expectedFocus = after.agentFocus
  return { workbench: fixture.expectedWorkbench, focus: fixture.expectedFocus }
}

export async function readGoalsEntryNativeBaseline({ client, fixture }) {
  const runs = await client.listRuns(), run = runs.find(item => item.runId === fixture.normal.run.runId)
  assert.equal(run?.state, 'running'); assert.equal(run.pid, fixture.normal.process.pid)
  assert.equal(run.workspacePath, fixture.normal.workspacePath)
  assert.ok(Number.isFinite(run.acceptedInputBytes) && run.acceptedInputBytes >= 0)
  assert.equal(await birth(run.pid), fixture.normal.birth)
  fixture.normal.inputBeforeRestore = run.acceptedInputBytes
}

export async function restoreGoalsEntryBeforeSpace({ cdp, fixture, activateButton, waitFor, focusOriginal }) {
  if (fixture.directGoal) return await restoreDirectGoalBeforeSpace({ cdp, fixture, activateButton, waitFor, focusOriginal })
  const restored = await waitFor('same failed CTA launcher is visible after an ordinary process restart', async () => {
    const value = await state(cdp), tab = value.restoredWorkbench.tabs[fixture.failed.tab.id]
    const text = await cdp.evaluate(`document.querySelector('[data-workbench-region-id="${fixture.failed.region.regionId}"]')?.innerText.toLowerCase()`)
    return tab && text?.includes('not been sent') ? value : null
  })
  assert.deepEqual(restored.restoredWorkbench, fixture.expectedWorkbench)
  assert.deepEqual(restored.agentFocus, fixture.expectedFocus)
  assert.equal(restored.agentComposerDrafts[fixture.failed.region.regionId], requests.ideas)
  assert.equal(restored.restoredWorkbench.tabs[fixture.failed.tab.id].topicPreparation, 'mote')
  assert.equal((await readdir(fixture.directory)).filter(name => name.endsWith('.argv')).length, 1, 'Restart does not launch or send the failed request')
  const reply = await cdp.evaluate('window.agentmux.sessions.snapshot()')
  const normal = reply.sessions.find(session => session.id === fixture.normal.agentSessionId)
  assert.equal(normal?.processState, 'running'); assert.deepEqual(normal.control.run, fixture.normal.run)
  await activateButton(cdp, `Array.from(document.querySelectorAll('[data-workbench-region-id="${fixture.failed.region.regionId}"] button')).find(button => button.textContent.trim() === 'Launch agent')`)
  const retry = await waitFor('explicit Launch agent retries preparation in the same Topic and Region', async () => {
    const value = await state(cdp), tab = value.restoredWorkbench.tabs[fixture.failed.tab.id]
    const region = tab?.regions[fixture.failed.region.regionId]
    return region?.kind === 'agent' && region.phase === 'attached' ? { tab, region, draft: value.agentComposerDrafts[region.regionId] ?? null } : null
  })
  assert.equal(retry.tab.topicId, fixture.failed.tab.topicId); assert.equal(retry.tab.topicPreparation, undefined)
  assert.notEqual(retry.draft, requests.ideas)
  fixture.retry = await launchEvidence(cdp, fixture, retry, requests.ideas, waitFor)
  assert.equal((await readdir(fixture.directory)).filter(name => name.endsWith('.argv')).length, 2)
  fixture.expectedWorkbench = (await state(cdp)).restoredWorkbench
  fixture.expectedFocus = (await state(cdp)).agentFocus
  await focusOriginal()
  return { actualMountedClicks: ['understand', 'ideas'], preparedTopic: fixture.normal.topicId,
    retainedFailureTopic: fixture.failed.tab.topicId, retainedFailureTab: fixture.failed.tab.id,
    retainedFailureRegion: fixture.failed.region.regionId, sameOwnerExplicitRetry: true, restartAutomaticallySent: false,
    preparationFailure: fixture.preparationFailure, sourceBefore: fixture.sourceBefore, agents: fixture.agents,
    limitations: ['Synthetic private Codex command records actual launch argv and then execs cat; argv receipt is distinct from PTY input and does not prove model understanding.',
      'Only original workbench facts were seeded; both new Topics, Regions and Agent Sessions came from actual mounted product actions.'] }
}

export async function finishGoalsEntryNativeProof({ client, fixture, result }) {
  const runs = await client.listRuns()
  for (const agent of fixture.agents) {
    const run = runs.find(item => item.runId === agent.run.runId)
    assert.equal(run?.state, 'running'); assert.equal(run.pid, agent.process.pid)
    assert.equal(run.workspacePath, agent.workspacePath, 'The Runtime Run belongs to the same real Topic directory as Main/Core Session')
    assert.equal(await birth(run.pid), agent.birth)
    agent.inputAfterRestore = run.acceptedInputBytes
  }
  assert.equal(fixture.normal.inputAfterRestore, fixture.normal.inputBeforeRestore, 'Ordinary restart must not write duplicate PTY input to the already launched request')
  const records = await readdir(fixture.directory)
  assert.deepEqual(records.filter(name => name.endsWith('.argv')).sort(), fixture.agents.map(agent => `${agent.agentSessionId}.argv`).sort(), 'Only real Core-created CTA Sessions have launch argv records')
  assert.deepEqual(records.filter(name => name.endsWith('.birth')).sort(), fixture.agents.map(agent => `${agent.agentSessionId}.birth`).sort())
  assert.deepEqual(await sources(fixture.desktopRoot), fixture.sourceBefore, 'Executed proof sources must stay exact throughout this candidate')
  result.noDuplicatePtyInput = true
}

function assertUndefinedGoal(goal) {
  assert.ok(goal.id && goal.title.trim(), 'The Main durable owner returns a real nonempty Goal identity/title')
  assert.equal(goal.description, ''); assert.equal(goal.status, 'backlog')
  assert.equal(goal.projectId, null); assert.equal(goal.projectName, null)
  assert.equal(goal.alignment, undefined); assert.equal(goal.grounding, undefined)
  assert.deepEqual(goal.sessionIds, [])
}

function mappedGoal(value, goalId) {
  const tabId = value.demandPmoTabIds?.[goalId], tab = value.restoredWorkbench.tabs[tabId]
  if (!tab) return null
  assert.equal(tab.workspaceId, '__scratch__'); assert.equal(tab.topicId, PMO_TEAMS_TOPIC_ID)
  const group = value.restoredWorkbench.layouts.__scratch__?.groups.find(group => group.tabOrder.includes(tabId))
  assert.ok(group, 'The dedicated mapped PMO Tab is actually placed in the original workbench')
  const region = tab.regions[tab.layout.activeRegionId]
  assert.ok(region, 'The mapped PMO Tab has its actual active Region')
  return { goalId, tab, region, draft: value.agentComposerDrafts[region.regionId] ?? null }
}

async function closeMote(cdp, activateButton, waitFor) {
  const open = await cdp.evaluate(`Boolean(document.querySelector('[data-pmo-teams-topic-floating][data-state="open"]'))`)
  if (!open) return
  await activateButton(cdp, `document.querySelector('[data-pmo-teams-topic-floating] [aria-label="Close Mote"]')`)
  await waitFor('actual Mote closes', () => cdp.evaluate(`!document.querySelector('[data-pmo-teams-topic-floating][data-state="open"]')`))
}

async function clickDirectGoalInActualUI({ cdp, fixture, activateButton, waitFor, expectedOriginalWorkbench, expectedOriginalFocus }) {
  await activateButton(cdp, `document.querySelector('[aria-label="Goals: show goals and progress"]')`)
  await waitFor('actual mounted New Goal button', () => cdp.evaluate(`Boolean(document.querySelector('button[data-new-goal]:not(:disabled)'))`))
  assert.deepEqual(await fixture.owner.list(), [], 'Only the original workspace/Run is seeded; no final Goal is seeded')
  const create = async previousIds => {
    await activateButton(cdp, `document.querySelector('button[data-new-goal]')`)
    const goal = await waitFor('mounted New Goal creates exactly one real Main-owned undefined Goal', async () => {
      const goals = (await fixture.owner.list()).filter(goal => !previousIds.includes(goal.id))
      assert.ok(goals.length <= 1, 'One actual New Goal click never creates multiple durable Goals')
      return goals[0]
    })
    assertUndefinedGoal(goal)
    assert.deepEqual((await cdp.evaluate('window.agentmux.demands.list()')).find(item => item.id === goal.id), goal)
    assert.equal(await cdp.evaluate(`Boolean(document.querySelector('.goals-intake'))`), false, 'The actual click enters without an intake form')
    return goal
  }
  const normalGoal = await create([])
  const normal = await waitFor('the same new Goal has a dedicated attached PMO Region', async () => {
    const value = await state(cdp), mapped = mappedGoal(value, normalGoal.id)
    return mapped?.region.kind === 'agent' && mapped.region.phase === 'attached' ? mapped : null
  })
  fixture.normal = await launchEvidence(cdp, fixture, normal, normalGoal.id, waitFor)
  fixture.normal.goal = normalGoal
  assert.equal(await cdp.evaluate(`document.querySelector('[data-pmo-teams-topic-floating][data-state="open"]')?.dataset.moteTargetTab`), normal.tab.id)
  await closeMote(cdp, activateButton, waitFor)
  try {
    // A definite private executable preparation failure occurs AFTER the real mapped Tab is
    // created. No API is replaced, no fake launch result or Goal/mapping is seeded.
    await chmod(fixture.executable, 0o600)
    fixture.failedGoal = await create([normalGoal.id])
    fixture.failed = await waitFor('Core launch failure preserves the actual mapped launcher and exact request', async () => {
      const value = await state(cdp), mapped = mappedGoal(value, fixture.failedGoal.id)
      if (mapped?.region.kind !== 'launcher' || !mapped.draft?.includes(`existing Goal ${fixture.failedGoal.id}`)) return null
      const notice = await cdp.evaluate(`document.querySelector('[data-direct-goal-id="${fixture.failedGoal.id}"]')?.textContent`)
      if (!notice?.includes('目标已保存') || !notice.includes('重试专属讨论')) return null
      fixture.preparationFailure = { step: 'Core executable preparation', executableMode: '0600', notice }
      return mapped
    })
  } finally { await chmod(fixture.executable, 0o700) }
  assert.notEqual(fixture.failed.tab.id, fixture.normal.tabId)
  assert.notEqual(fixture.failedGoal.id, normalGoal.id)
  assert.equal((await readdir(fixture.directory)).filter(name => name.endsWith('.argv')).length, 1, 'A failed preparation never starts a second Agent')
  const after = await state(cdp)
  assert.equal(after.selectedDemandId, fixture.failedGoal.id)
  for (const [id, tab] of Object.entries(expectedOriginalWorkbench.tabs)) assert.deepEqual(after.restoredWorkbench.tabs[id], tab)
  for (const [id, layout] of Object.entries(expectedOriginalWorkbench.layouts)) if (id !== '__scratch__') assert.deepEqual(after.restoredWorkbench.layouts[id], layout)
  assert.deepEqual(after.agentFocus.execution, expectedOriginalFocus.execution, 'New Goal PMO never takes the original execution focus')
  fixture.expectedWorkbench = after.restoredWorkbench; fixture.expectedFocus = after.agentFocus
  fixture.expectedMapping = after.demandPmoTabIds
  fixture.beforeStore = await retainRaw(fixture, 'demands-before-restart.json', await readFile(fixture.demandStorePath))
  return { workbench: fixture.expectedWorkbench, focus: fixture.expectedFocus }
}

async function restoreDirectGoalBeforeSpace({ cdp, fixture, activateButton, waitFor, focusOriginal }) {
  const restored = await waitFor('same selected durable Goal and failed mapped launcher return in the ordinary second process', async () => {
    const value = await state(cdp), mapped = mappedGoal(value, fixture.failedGoal.id)
    const shown = await cdp.evaluate(`document.querySelector('[data-pmo-teams-topic-floating][data-state="open"]')?.dataset.moteTargetRegion`)
    return value.mainSurface === 'board' && value.selectedDemandId === fixture.failedGoal.id &&
      mapped?.region.kind === 'launcher' && shown === fixture.failed.region.regionId ? value : null
  })
  assert.deepEqual(restored.restoredWorkbench, fixture.expectedWorkbench)
  assert.deepEqual(restored.agentFocus, fixture.expectedFocus)
  assert.deepEqual(restored.demandPmoTabIds, fixture.expectedMapping)
  assert.equal(restored.agentComposerDrafts[fixture.failed.region.regionId], fixture.failed.draft)
  const durableGoals = await fixture.owner.list()
  assert.equal(durableGoals.length, 2)
  assert.deepEqual(durableGoals.find(goal => goal.id === fixture.normal.goalId), fixture.normal.goal)
  assert.deepEqual(durableGoals.find(goal => goal.id === fixture.failedGoal.id), fixture.failedGoal)
  assert.deepEqual(await cdp.evaluate('window.agentmux.demands.list()'), durableGoals)
  const afterStore = await retainRaw(fixture, 'demands-after-restart.json', await readFile(fixture.demandStorePath))
  assert.equal(afterStore.sha256, fixture.beforeStore.sha256, 'Ordinary restart neither recreates nor edits either Goal')
  assert.equal((await readdir(fixture.directory)).filter(name => name.endsWith('.argv')).length, 1)
  const snapshot = await waitFor('normal dedicated PMO Session automatically rejoins its original healthy Run', async () => {
    const reply = await cdp.evaluate('window.agentmux.sessions.snapshot()')
    return reply.sessions.find(session => session.id === fixture.normal.agentSessionId && session.processState === 'running')
  })
  assert.deepEqual(snapshot.control.run, fixture.normal.run)
  const automaticallyRestored = mappedGoal(restored, fixture.normal.goalId)
  assert.equal(automaticallyRestored.region.kind, 'agent'); assert.equal(automaticallyRestored.region.phase, 'attached')
  assert.equal(automaticallyRestored.region.sessionId, snapshot.id)
  await closeMote(cdp, activateButton, waitFor)
  await activateButton(cdp, `document.querySelector('.goals-detail button[data-goal-grill]')`)
  const retry = await waitFor('actual Goal request retries its existing PMO Tab and Region', async () => {
    const value = await state(cdp), mapped = mappedGoal(value, fixture.failedGoal.id)
    return mapped?.region.kind === 'agent' && mapped.region.phase === 'attached' ? mapped : null
  })
  assert.equal(retry.tab.id, fixture.failed.tab.id); assert.equal(retry.region.regionId, fixture.failed.region.regionId)
  fixture.retry = await launchEvidence(cdp, fixture, retry, fixture.failedGoal.id, waitFor)
  assert.deepEqual(await fixture.owner.list(), durableGoals, 'Explicit mapped retry does not create or rewrite a Goal')
  assert.equal((await readdir(fixture.directory)).filter(name => name.endsWith('.argv')).length, 2)
  const after = await state(cdp)
  assert.deepEqual(after.demandPmoTabIds, fixture.expectedMapping)
  fixture.expectedWorkbench = after.restoredWorkbench; fixture.expectedFocus = after.agentFocus
  await closeMote(cdp, activateButton, waitFor)
  await focusOriginal()
  return { passed: true, exactFlag: '--goals-direct-pmo', actualMountedClicks: ['New Goal', 'New Goal', 'Clarify goal'],
    durableGoalIds: durableGoals.map(goal => goal.id), normalGoalId: fixture.normal.goalId, failedGoalId: fixture.failedGoal.id,
    retainedFailureTab: fixture.failed.tab.id, retainedFailureRegion: fixture.failed.region.regionId,
    retainedDraftSha256: digest(fixture.failed.draft), mapping: fixture.expectedMapping,
    sameOwnerExplicitRetry: true, automaticallyAttachedSamePmoRun: true, restartAutomaticallyCreatedGoal: false,
    restartAutomaticallySent: false, preparationFailure: fixture.preparationFailure,
    durableStore: { before: fixture.beforeStore, after: afterStore }, sourceBefore: fixture.sourceBefore, agents: fixture.agents,
    originalOutputBeforeRestart: fixture.originalOutput,
    limitations: ['The private Codex command records actual Main/Core launch argv and execs cat. This proves lifecycle/transport; it does not prove a paid model discussion or model understanding.',
      'Only original workspace/Run facts were seeded. Both durable Goals and PMO mappings came from mounted New Goal actions.'] }
}

/** Actual public Core input/output before restart; public Main/Core input/output while the second App is alive. */
export async function proveOriginalRunOutput({ client, cdp, session, run, baseline, marker, waitFor }) {
  const replayBytes = value => Buffer.concat(value.replay.map(chunk => Buffer.from(ArrayBuffer.isView(chunk.dataBytes) || Array.isArray(chunk.dataBytes) ? chunk.dataBytes : Object.values(chunk.dataBytes))))
  if (client) {
    await client.writeTerminal(session.run, { ownerInstanceId: client.runtimeIdentity().instanceId, operationId: randomUUID(), expectedByte: run.acceptedInputBytes, data: `${marker}\r` })
    const observed = await waitFor('original healthy Run emits real before-restart input', async () => {
      const replay = await client.readRunReplay(session.run)
      return replayBytes(replay).includes(Buffer.from(marker)) ? replay : null
    })
    const bytes = replayBytes(observed)
    assert.ok(bytes.length > 0); assert.equal(observed.gap, null)
    return { runId: session.run.runId, pid: observed.run.pid, acceptedInputBytes: observed.run.acceptedInputBytes,
      outputBytes: bytes.length, outputSha256: digest(bytes), outputBase64: bytes.toString('base64'), marker }
  }
  const ref = { kind: 'agent', hostId: 'local', agentSessionId: session.agentSessionId, run: session.run }
  const attached = await cdp.evaluate(`window.agentmux.sessions.attach(${JSON.stringify(ref)}, 0)`)
  try {
    // Desktop attachment hydrates the terminal snapshot; its byte replay can be empty.
    // Read ordered history through the existing lease's public raw replay operation.
    const retained = await cdp.evaluate(`window.agentmux.sessions.replay(${JSON.stringify(attached.attachmentId)}, 0)`)
    const bytes = replayBytes(retained)
    assert.equal(attached.gap, null); assert.equal(retained.gap, null); assert.ok(bytes.length > 0)
    assert.ok(bytes.subarray(0, baseline.outputBytes).equals(Buffer.from(baseline.outputBase64, 'base64')), 'The original output byte prefix survives ordinary process restart')
    assert.equal(attached.session.control.run.runId, baseline.runId)
    const before = attached.session
    await cdp.evaluate(`window.agentmux.sessions.write(${JSON.stringify(ref)}, ${JSON.stringify(`${marker}\r`)}, 'user')`)
    const observed = await waitFor('same original Run emits actual input sent through the alive second Main', async () => {
      const replay = await cdp.evaluate(`window.agentmux.sessions.replay(${JSON.stringify(attached.attachmentId)}, 0)`)
      return replayBytes(replay).includes(Buffer.from(marker)) ? replay : null
    })
    const result = replayBytes(observed)
    return { runId: baseline.runId, pid: baseline.pid, acceptedInputBytes: baseline.acceptedInputBytes + Buffer.byteLength(`${marker}\r`),
      originalOutputPrefixPreserved: true, aliveSecondMainInputOutput: true, outputBytes: result.length,
      outputSha256: digest(result), marker, sameMainSession: before.id }
  } finally { await cdp.evaluate(`window.agentmux.sessions.detach(${JSON.stringify(attached.attachmentId)})`) }
}

export async function cleanupGoalsEntryRuns(fixture) {
  if (!fixture) return []
  await chmod(fixture.topicsPath, fixture.topicsMode)
  await chmod(fixture.executable, 0o700)
  const result = []
  for (const name of (await readdir(fixture.directory)).filter(name => name.endsWith('.birth'))) {
    const recorded = (await readFile(join(fixture.directory, name), 'utf8')).trim(), owned = parseBirth(recorded)
    const current = await birth(owned.pid)
    if (current === recorded) {
      try { process.kill(-owned.group, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    for (let i = 0; i < 40 && await birth(owned.pid) === recorded; i++) await new Promise(done => setTimeout(done, 50))
    assert.notEqual(await birth(owned.pid), recorded, 'Only the exact private CTA Run is reaped')
    result.push({ ...owned, reaped: true })
  }
  return result
}
