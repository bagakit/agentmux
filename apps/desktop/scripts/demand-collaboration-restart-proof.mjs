import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'
import { PMO_TEAMS_TOPIC_ID, scratchTopicLogicalPath } from '../src/shared/scratch-topics.ts'
import { openDemandStore } from '../../../packages/demand/dist/src/index.js'
import { readRecoverySpatialState, assertOriginalRecoveryGraph } from './goals-alignment-restart-proof.mjs'

const exec = promisify(execFile), digest = bytes => createHash('sha256').update(bytes).digest('hex')
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
const draft = 'Private independent conversation draft\n  Exact spacing survives both App processes.'
const intents = ['Private human finite intent: preserve this original Goal and workspace.', 'Private human ongoing intent: verify original work and preserve its exact identity.']
const sourcePaths = ['src/main/ipc.ts', 'src/main/goal-dispatch-input.ts', 'src/main/demand-participation.ts', 'src/preload/index.ts', 'src/renderer/src/store.ts', 'src/renderer/src/components/GoalDetail.tsx', 'src/renderer/src/components/GoalAgentPicker.tsx', 'src/renderer/src/components/GoalContinuationControl.tsx', 'src/renderer/src/components/RegionCurrentDemand.tsx', 'src/renderer/src/lib/goal-current-work.ts', 'src/renderer/src/lib/primary-mote-executor.ts', 'src/renderer/src/components/settings/GoalsSettingsPane.tsx']

async function sourceHashes(desktopRoot) { return Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, digest(await readFile(join(desktopRoot, path)))]))) }
async function uiState(cdp) { return { ...await cdp.evaluate(`JSON.parse(localStorage.getItem('agentmux-workbench-v1')).state`), spatial: await readRecoverySpatialState(cdp), presentations: await cdp.evaluate('window.agentmux.sessions.snapshot()') } }
function mappedGoal(value, goalId) {
  const tabId = value.demandPmoTabIds?.[goalId], graph = value.spatial.graph
  const tab = graph.tabs.find(tab => tab.tabId === tabId), layout = graph.tabLayouts[tabId]
  const tabResource = graph.resources['tab:' + tabId]
  const region = layout && graph.regions.find(region => region.regionId === layout.activeRegionId && region.tabId === tabId)
  const regionResource = region && graph.resources['region:' + region.regionId]
  const matches = region ? value.presentations.sessions.filter(session => session.kind === 'agent' && session.control.agentSessionId === region.agentSessionId && session.control.hostId === region.execution?.hostId) : []
  const presentationId = matches.length === 1 ? matches[0].id : undefined
  return tab && tabResource && region && regionResource && presentationId ? { goalId, tab, tabResource, region, regionResource, presentationId,
    draft: value.agentComposerDrafts[presentationId] ?? null, note: value.agentComposerNotes?.[presentationId] ?? null } : null
}
// Ordinary initialization lets the original Core name owner adopt observed aliases once.
// Predict only these two already-created PMO Tab labels from the pre-crash document;
// the second process's observations never determine its expected graph or revision.
function expectedPmoNameRetention(before, agents) {
  const expected = structuredClone(before), document = expected.graph.resources['agentmux:display-labels'], added = []
  assert.ok(document && document.labels && Array.isArray(document.records))
  assert.equal(agents.length, 2); assert.equal(new Set(agents.map(agent=>agent.tabId)).size, 2)
  for (const agent of agents) {
    const tab = expected.graph.tabs.find(tab=>tab.tabId===agent.tabId)
    assert.ok(tab && typeof tab.name === 'string' && tab.name.length > 0)
    const target = {kind:'tab',id:tab.tabId}, key = JSON.stringify([target.kind,target.id])
    if (Object.hasOwn(document.labels,key)) continue
    const label = {target,value:tab.name,source:'retained',nameRevision:1,operationId:'retained:'+key}
    document.labels[key] = label; added.push({key,label})
  }
  if (added.length) expected.revision++ // One original owner's batch commit, never one per Tab.
  return {expected,added}
}
async function birth(pid) { try { return (await exec('/bin/ps', ['-p', String(pid), '-o', 'pid=,pgid=,lstart='], { env: { ...process.env, LC_ALL: 'C' }, timeout: 5000 })).stdout.trim() } catch (error) { if (error.code === 1) return null; throw error } }
function parseBirth(text) { const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(text); assert.ok(m); const pid = Number(m[1]), group = Number(m[2]); assert.ok(pid > 1); assert.equal(group, pid); return { pid, group, born: m[3] } }
async function retain(fixture, name, bytes) { const path = join(fixture.rawDirectory, name); await writeFile(path, bytes, { mode: 0o600 }); return { path, sha256: digest(bytes), bytes: bytes.length } }
async function capture(cdp, fixture, name) { const { data } = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); return retain(fixture, name + '.png', Buffer.from(data, 'base64')) }
async function closeMote(cdp, activateButton, waitFor) {
  if (!await cdp.evaluate(`Boolean(document.querySelector('[data-pmo-teams-topic-floating][data-state="open"]'))`)) return
  await activateButton(cdp, `document.querySelector('[data-pmo-teams-topic-floating] [aria-label="Close Mote"]')`)
  await waitFor('original Mote closes', () => cdp.evaluate(`!document.querySelector('[data-pmo-teams-topic-floating][data-state="open"]')`))
}
async function cli(fixture, args, actor, allowFocusPartial = false) {
  const environment = { ...process.env }
  if (actor) {
    const credential = JSON.parse(await readFile(join(fixture.directory, actor.agentSessionId + '.capability.json'), 'utf8'))
    assert.equal(credential.agentSessionId, actor.agentSessionId)
    environment.AGENTMUX_AGENT_SESSION_ID = credential.agentSessionId
    environment.AGENTMUX_AGENT_CAPABILITY = credential.capability
  }
  let reply, exitCode = 0
  try { reply = await exec(process.execPath, [join(fixture.repositoryRoot, 'packages/core/bin/amux'), '--endpoint', 'unix:' + join(process.env.AGENTMUX_RUNTIME_DIRECTORY, 'control.sock'), ...args], { env: environment, cwd: fixture.repositoryRoot, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }) }
  catch (error) {
    const raw = await retain(fixture, 'public-cli-' + fixture.cliOperations.length + '.json', Buffer.from(JSON.stringify({ args, stdout: error.stdout ?? '', stderr: error.stderr ?? '', exitCode: error.code })))
    fixture.cliFailure = { args, raw, exitCode: error.code }
    if (!allowFocusPartial || error.code !== 1) throw error
    reply = error; exitCode = error.code
  }
  const parsed = JSON.parse(reply.stdout)
  assert.equal(parsed.ok, true, 'Actual Source CLI returns its original owner result')
  if (exitCode) { assert.equal(parsed.operation, 'space.focus'); assert.equal(parsed.result.partial, true) }
  const raw = await retain(fixture, 'public-cli-' + fixture.cliOperations.length + '.json', Buffer.from(JSON.stringify({ args, reply: parsed, exitCode })))
  fixture.cliOperations.push({ args, operation: parsed.operation, operationId: parsed.operationId ?? null, result: parsed.result, exitCode, raw })
  return parsed.result
}

export async function createDemandCollaborationFixture({ root, userData, topicsPath, desktopRoot, receiptPath }) {
  const directory = join(root, 'collaboration-runs'), executable = join(root, 'collaboration-codex.sh')
  const repositoryRoot = join(desktopRoot, '../..'), nativeHome = join(root, 'native-home'), nativeRecords = join(nativeHome, '.codex/sessions')
  await mkdir(directory, { mode: 0o700 }); await mkdir(nativeRecords, { recursive: true, mode: 0o700 })
  await writeFile(executable, `#!/bin/sh\numask 077\nproof_directory=${quote(directory)}\ntest -n "$AGENTMUX_AGENT_SESSION_ID" && test -n "$AGENTMUX_AGENT_CAPABILITY" && test -n "$AGENTMUX_LIFECYCLE_OPERATION_ID" || exit 64\nLC_ALL=C /bin/ps -p "$$" -o pid=,pgid=,lstart= > "$proof_directory/$AGENTMUX_AGENT_SESSION_ID.birth"\nprintf '%s\\0' "$@" > "$proof_directory/$AGENTMUX_AGENT_SESSION_ID.argv"\nexport AGENTMUX_FAKE_CAPABILITY_RECEIPT="$proof_directory/$AGENTMUX_AGENT_SESSION_ID.capability.json"\nexec ${quote(process.execPath)} ${quote(join(repositoryRoot, 'packages/core/test/fixtures/fake-codex-cli.mjs'))} "$@"\n`, { mode: 0o700 })
  const rawDirectory = join(dirname(receiptPath), 'raw'); await mkdir(rawDirectory, { recursive: true, mode: 0o700 })
  return { directory, executable, nativeHome, nativeRecords, repositoryRoot, topicsPath, topicsMode: (await stat(topicsPath)).mode & 0o777,
    sourceBefore: await sourceHashes(desktopRoot), desktopRoot, agents: [], rawDirectory,
    owner: openDemandStore({ root: join(userData, 'demands') }), demandStorePath: join(userData, 'demands/store.json'), cliOperations: [], navigation: [], frames: [], actions: [] }
}

async function prepareMote(cdp, fixture) {
  const topic = await cdp.evaluate(`window.agentmux.scratch.ensureMote('__scratch__', ${JSON.stringify(PMO_TEAMS_TOPIC_ID)})`)
  const path = scratchTopicLogicalPath({ path: fixture.topicsPath }, topic) + '/MOTE.md'
  assert.ok(!path.startsWith('null'))
  const document = await cdp.evaluate(`window.agentmux.files.read('__scratch__', ${JSON.stringify(path)})`)
  assert.ok(['read', 'deleted'].includes(document.status))
  const content = '---\nversion: 1\ndefaults:\n  executorId: probe\n---\n'
  const written = await cdp.evaluate(`window.agentmux.files.write('__scratch__', ${JSON.stringify({ path, content, expectedRevision: document.status === 'read' ? document.document.revision : null })})`)
  assert.equal(written.status, 'written')
  const saved = await cdp.evaluate(`window.agentmux.scratch.readTopic('__scratch__', ${JSON.stringify(PMO_TEAMS_TOPIC_ID)})`)
  assert.equal(saved.quickMode.status, 'saved'); assert.equal(saved.quickMode.defaults.executorId, 'probe')
  return { topicId: topic.id, path, documentRevision: written.document?.revision, status: saved.quickMode.status, executorId: saved.quickMode.defaults.executorId, contentSha256: digest(content) }
}
async function settings(cdp, fixture, activateButton, waitFor, expected, saveNext) {
  const publicSettings = await cli(fixture, ['settings', 'inspect', 'goals.requesterAsSupervisor'])
  assert.equal(publicSettings.entries[0].key, 'goals.requesterAsSupervisor'); assert.equal(publicSettings.entries[0].value, expected)
  await activateButton(cdp, `Array.from(document.querySelectorAll('button[aria-label="Settings"]')).find(e => e.getClientRects().length > 0)`)
  await waitFor('actual Settings sections', () => cdp.evaluate(`Boolean(document.querySelector('button[data-settings-target="goals"]'))`))
  await activateButton(cdp, `document.querySelector('button[data-settings-target="goals"]')`)
  await waitFor('actual Goals preference checkbox', () => cdp.evaluate(`Boolean(document.querySelector('[data-settings-pane="goals"] input[aria-label="Use the requesting Agent as Supervisor"]'))`))
  const observed = await cdp.evaluate(`({checked:document.querySelector('[data-settings-pane="goals"] input[aria-label="Use the requesting Agent as Supervisor"]').checked,text:document.querySelector('[data-settings-pane="goals"]').innerText})`)
  assert.equal(observed.checked, expected)
  fixture.frames.push(await capture(cdp, fixture, 'settings-' + (expected ? 'on' : 'off') + '-' + fixture.frames.length))
  if (saveNext !== undefined) {
    // Native checkbox keyboard activation is Space, whereas buttons use Enter.
    assert.equal(await cdp.evaluate(`(() => {const e=document.querySelector('[data-settings-pane="goals"] input[aria-label="Use the requesting Agent as Supervisor"]');e.focus();return document.activeElement===e})()`), true)
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 })
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 })
    await waitFor('native checkbox draft enables actual Save', () => cdp.evaluate(`document.querySelector('[data-settings-pane="goals"] input[aria-label="Use the requesting Agent as Supervisor"]').checked===${saveNext} && !document.querySelector('[data-settings-pane="goals"] [data-settings-save-bar] button').disabled`))
    await activateButton(cdp, `document.querySelector('[data-settings-pane="goals"] [data-settings-save-bar] button')`)
    await waitFor('actual Main config saved Goals default', async () => (await cdp.evaluate('window.agentmux.config.get()')).goals?.requesterAsSupervisor === saveNext)
    assert.equal((await cli(fixture, ['settings', 'inspect', 'goals.requesterAsSupervisor'])).entries[0].value, saveNext)
    fixture.actions.push({ action: 'actual-Goals-Settings-checkbox-and-save', previous: expected, next: saveNext })
  }
  await activateButton(cdp, `document.querySelector('button[aria-label="Close settings"]')`)
  await waitFor('Settings closed', () => cdp.evaluate(`!document.querySelector('button[aria-label="Close settings"]')`))
  return { ...observed, publicSettings }
}
async function newGoal(cdp, fixture, activateButton, waitFor, policy) {
  await activateButton(cdp, `document.querySelector('[aria-label="Goals: show goals and progress"]')`)
  await waitFor('actual mounted New Goal', () => cdp.evaluate(`Boolean(document.querySelector('button[data-new-goal]:not(:disabled)'))`))
  const ids = (await fixture.owner.list()).map(goal => goal.id)
  await activateButton(cdp, `document.querySelector('button[data-new-goal]')`)
  const goal = await waitFor('actual new durable Goal with exact original first source', async () => {
    const goals = (await fixture.owner.list()).filter(goal => !ids.includes(goal.id))
    assert.ok(goals.length <= 1)
    return goals[0]?.creationOrigin?.requesterParticipationId ? goals[0] : null
  }, 90_000)
  assert.equal(goal.description, ''); assert.equal(goal.projectId, null); assert.equal(goal.projectName, null)
  assert.equal(goal.creationOrigin.requesterAsSupervisor, policy); assert.equal(goal.creationOrigin.supervisorDefaultPending, false)
  const mapped = await waitFor('original canonical Host uniquely binds the actual mapped PMO', async () => mappedGoal(await uiState(cdp), goal.id)); assert.ok(mapped); assert.equal(mapped.region.kind, 'agent'); assert.equal(mapped.regionResource.phase, 'attached')
  const source = goal.participations.find(source => source.id === goal.creationOrigin.requesterParticipationId)
  assert.ok(source); assert.equal(source.hostId, 'local')
  const snapshot = await waitFor('same mapped canonical Session is running and has native readiness', async () => {
    const reply = await cdp.evaluate('window.agentmux.sessions.snapshot()')
    return reply.sessions.find(session => session.control.agentSessionId === source.agentSessionId && session.control.hostId === source.hostId && session.processState === 'running' && session.nativeSessionId && session.semanticStatus?.state === 'done')
  }, 90_000)
  assert.equal(mapped.region.agentSessionId, snapshot.control.agentSessionId); assert.equal(mapped.presentationId, snapshot.id)
  const original = await cdp.evaluate(`window.agentmux.sessions.creation('local', ${JSON.stringify(source.agentSessionId)})`)
  assert.equal(original.creation.initialPrompt, 'confirmed'); assert.ok(original.creation.createOperationId); assert.ok(original.nativeHandle); assert.equal(original.semanticStatus.state, 'done')
  assert.equal(goal.supervisorSessionId, policy ? source.agentSessionId : null)
  assert.deepEqual(goal.assigneeSessionIds, policy ? [source.agentSessionId] : [])
  assert.deepEqual(goal.sessionIds, policy ? [source.agentSessionId] : [])
  assert.deepEqual(goal.dispatches, [])
  assert.deepEqual(await cdp.evaluate(`window.agentmux.continuousProgress.goals(${JSON.stringify(goal.id)})`), [])
  assert.equal(await cdp.evaluate(`Boolean(document.querySelector('[data-workbench-region-id="${mapped.region.regionId}"] [data-current-demand-state]'))`), false, 'Creation source alone is not dispatch')
  assert.ok(source.mote?.identityDirectoryPath, 'Main admitted the actual canonical Mote execution directory')
  const cwd = await realpath(source.mote.identityDirectoryPath)
  assert.equal(mapped.region.execution.hostId, source.hostId); assert.equal(mapped.region.execution.cwd, cwd)
  assert.equal(snapshot.workspacePath, cwd)
  const argsBytes = await readFile(join(fixture.directory, source.agentSessionId + '.argv'))
  const args = argsBytes.toString('utf8').split('\0').filter(Boolean)
  const note = args.filter(arg => arg.includes('You are Mote for existing Goal ' + goal.id + '.'))
  assert.equal(note.length, 1); assert.ok(note[0].includes('Do not create another Goal'))
  const recordedBirth = (await readFile(join(fixture.directory, source.agentSessionId + '.birth'), 'utf8')).trim()
  const process = parseBirth(recordedBirth); assert.equal(await birth(process.pid), recordedBirth)
  const nativeBytes = await readFile(join(fixture.nativeRecords, 'rollout-' + source.agentSessionId + '.jsonl'))
  const nativeMeta = JSON.parse(nativeBytes.toString().split('\n')[0]); assert.equal(nativeMeta.payload.id, original.nativeHandle.sessionId); assert.equal(nativeMeta.payload.cwd, cwd)
  const agent = { goalId: goal.id, sourcePolicy: policy, createdGoal: goal, tabId: mapped.tab.tabId, topicId: source.mote.topicId, regionId: mapped.region.regionId,
    presentationId: snapshot.id, agentSessionId: source.agentSessionId, hostId: source.hostId, run: snapshot.control.run, workspacePath: cwd, process, birth: recordedBirth,
    source, coreCreation: original.creation, nativeHandle: original.nativeHandle, initialPrompt: original.creation.initialPrompt, initialPromptArgOccurrences: 1,
    argv: await retain(fixture, source.agentSessionId + '.argv', argsBytes), nativeRecord: await retain(fixture, source.agentSessionId + '-native-before.jsonl', nativeBytes) }
  fixture.agents.push(agent); fixture.actions.push({ action: 'actual-New-Goal', goalId: goal.id, policy })
  await closeMote(cdp, activateButton, waitFor)
  await waitFor('exact new Goal detail mounted', () => cdp.evaluate(`Boolean(document.querySelector('[data-goal-detail-id="${goal.id}"]'))`))
  return agent
}
async function description(cdp, fixture, agent, text, waitFor) {
  await cdp.evaluate(`(() => {const e=document.querySelector('[data-goal-detail-id="${agent.goalId}"] [aria-label="Goal description"]'); if(!e)throw Error('Exact actual Goal description is absent');e.focus(); if(e instanceof HTMLTextAreaElement)e.select();else getSelection().selectAllChildren(e);return true})()`)
  await cdp.call('Input.insertText', { text })
  await cdp.evaluate('document.activeElement.blur()')
  await waitFor('actual authored human description saved by Main', async () => (await fixture.owner.get(agent.goalId)).description === text)
}
async function putDraft(cdp, fixture, agent, waitFor) {
  // A Mote may be an observed floating presentation. CLI exit 1 retains that
  // partial public fact; it is not a refusal of already confirmed navigation.
  const focus = await cli(fixture, ['space', 'focus', '--region', agent.regionId, '--expect-session', agent.presentationId], undefined, true)
  assert.ok(['applied', 'unchanged'].includes(focus.navigation.state))
  assert.equal(focus.navigation.selection.space.regionId, agent.regionId)
  assert.equal(focus.navigation.selection.space.tabId, agent.tabId)
  assert.equal(focus.navigation.expectedAgentSessionId, agent.presentationId)
  fixture.actions.push({ action: 'private-explicit-mounted-Composer-focus-after-public-navigation', goalId: agent.goalId, publicPresentation: focus.presentation, publicInput: focus.input, publicPartial: focus.partial })
  await waitFor('actual PMO Region Composer visible', () => cdp.evaluate(`Boolean(document.querySelector('[data-workbench-region-id="${agent.regionId}"] .composer [role="textbox"]')?.getClientRects().length)`))
  await cdp.evaluate(`(async () => {const e=document.querySelector('[data-workbench-region-id="${agent.regionId}"] .composer [role="textbox"]');e.focus();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));e.focus();getSelection().selectAllChildren(e);return true})()`)
  await cdp.call('Input.insertText', { text: draft })
  await waitFor('actual independent PMO draft is durable', async () => (await uiState(cdp)).agentComposerDrafts[agent.presentationId] === draft)
}
function stable(value, agent) {
  const mapped = mappedGoal(value, agent.goalId)
  return { tab: mapped.tab, tabResource: mapped.tabResource, region: mapped.region, regionResource: mapped.regionResource,
    draft: mapped.draft, note: mapped.note, mapping: value.demandPmoTabIds, graphLayouts: value.spatial.graph.layouts, tabLayouts: value.spatial.graph.tabLayouts }
}
async function navigate(cdp, fixture, agent, activateButton, waitFor, label) {
  const before = await uiState(cdp), controlBefore = await cdp.evaluate('window.agentmux.sessions.snapshot()')
  const badge = `[data-workbench-region-id="${agent.regionId}"] [data-current-demand-state="current"] button`
  await waitFor('confirmed current Demand badge in original Region', () => cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(badge)}))`))
  fixture.frames.push(await capture(cdp, fixture, label + '-current-region'))
  await activateButton(cdp, `document.querySelector(${JSON.stringify(badge)})`)
  await waitFor('Region opens exact Goal detail', () => cdp.evaluate(`Boolean(document.querySelector('[data-goal-detail-id="${agent.goalId}"]'))`))
  const after = await uiState(cdp), afterSession = (await cdp.evaluate('window.agentmux.sessions.snapshot()')).sessions.find(source => source.control.agentSessionId === agent.agentSessionId)
  assert.equal(after.selectedDemandId, agent.goalId); assert.deepEqual(stable(after, agent), stable(before, agent))
  const beforeSession = controlBefore.sessions.find(source => source.control.agentSessionId === agent.agentSessionId)
  assert.deepEqual(afterSession.control, beforeSession.control); assert.equal(afterSession.workspacePath, beforeSession.workspacePath)
  fixture.navigation.push({ label, goalId: agent.goalId, before: stable(before, agent), after: stable(after, agent), selectedGoal: after.selectedDemandId, control: afterSession.control })
  fixture.frames.push(await capture(cdp, fixture, label + '-exact-goal-detail'))
}

export async function clickDemandCollaborationInActualUI({ cdp, fixture, activateButton, waitFor, expectedOriginalWorkbench, expectedOriginalFocus }) {
  assert.deepEqual(await fixture.owner.list(), [], 'No final Goals, roles or dispatches are seeded')
  fixture.mote = await prepareMote(cdp, fixture)
  fixture.settingsOn = await settings(cdp, fixture, activateButton, waitFor, true)
  fixture.normal = await newGoal(cdp, fixture, activateButton, waitFor, true)
  await description(cdp, fixture, fixture.normal, intents[0], waitFor)
  fixture.activity = await cli(fixture, ['goal', 'activity', 'append', '--goal', fixture.normal.goalId, '--kind', 'progress', '--message', 'Private actual authenticated activity appears in the same GUI.', '--operation-id', 'native6-original-activity'], fixture.normal)
  const replay = await cli(fixture, ['goal', 'activity', 'append', '--goal', fixture.normal.goalId, '--kind', 'progress', '--message', 'Private actual authenticated activity appears in the same GUI.', '--operation-id', 'native6-original-activity'], fixture.normal)
  assert.deepEqual(replay.activity, fixture.activity.activity); assert.equal(replay.receipt.replayed, true)
  assert.equal(fixture.activity.activity.actorId, fixture.normal.agentSessionId)
  const inspected = await cli(fixture, ['goal', 'activity', 'inspect', '--goal', fixture.normal.goalId, '--operation-id', 'native6-original-activity'], fixture.normal)
  assert.deepEqual(inspected.activity, fixture.activity.activity)
  await waitFor('same public activity appears exactly once in GUI', () => cdp.evaluate(`Array.from(document.querySelectorAll('[data-goal-detail-id="${fixture.normal.goalId}"] .goals-activity__row')).filter(e=>e.textContent.includes('Private actual authenticated activity appears in the same GUI.')).length===1`))
  await activateButton(cdp, `document.querySelector('[data-goal-detail-id="${fixture.normal.goalId}"] .goals-activity summary')`)
  fixture.frames.push(await capture(cdp, fixture, 'first-public-activity-gui'))
  await cli(fixture, ['goal', 'start', '--goal', fixture.normal.goalId, '--session', fixture.normal.agentSessionId, '--operation-id', 'native6-finite-start'])
  fixture.normal.dispatch = await waitFor('actual finite Core input durably confirmed', async () => {
    const dispatch = await cdp.evaluate(`window.agentmux.demands.inspectDispatch(${JSON.stringify({ goalId: fixture.normal.goalId, operationId: 'native6-finite-start' })})`)
    return dispatch?.stage === 'confirmed' ? dispatch : null
  }, 90_000)
  assert.equal(fixture.normal.dispatch.prompt, intents[0]); assert.equal(fixture.normal.dispatch.agentSessionId, fixture.normal.agentSessionId); assert.equal(fixture.normal.dispatch.runId, fixture.normal.run.runId)
  assert.equal(fixture.normal.dispatch.receipt.itemId, 'prompt:native6-finite-start')
  await putDraft(cdp, fixture, fixture.normal, waitFor)
  await navigate(cdp, fixture, fixture.normal, activateButton, waitFor, 'first-finite')
  // Both public setter and real Settings consumer use the original ConfigOwner.
  await cli(fixture, ['settings', 'set', 'goals.requesterAsSupervisor', 'false'])
  fixture.settingsOff = await settings(cdp, fixture, activateButton, waitFor, false)
  fixture.off = await newGoal(cdp, fixture, activateButton, waitFor, false)
  assert.notEqual(fixture.off.agentSessionId, fixture.normal.agentSessionId)
  await description(cdp, fixture, fixture.off, intents[1], waitFor)
  await settings(cdp, fixture, activateButton, waitFor, false, true)
  assert.equal((await fixture.owner.get(fixture.off.goalId)).supervisorSessionId, null, 'Later ON never backfills older OFF Goal')
  await activateButton(cdp, `Array.from(document.querySelectorAll('[data-goal-detail-id="${fixture.off.goalId}"] button')).find(e=>e.title===${JSON.stringify(fixture.off.agentSessionId)}&&e.getAttribute('aria-label')?.startsWith('Assign '))`)
  await waitFor('actual one-click recommended Supervisor saved', async () => (await fixture.owner.get(fixture.off.goalId)).supervisorSessionId === fixture.off.agentSessionId)
  await cli(fixture, ['goal', 'update', '--goal', fixture.off.goalId, '--alignment', JSON.stringify({ summary: intents[1], criteria: [{ id: 'identity', text: 'Original Goal, Agent and work surface remain recoverable.' }], openQuestions: [] })])
  await waitFor('actual proposed private human scope confirmation', () => cdp.evaluate(`Boolean(document.querySelector('[data-goal-detail-id="${fixture.off.goalId}"] [data-goal-confirm]'))`))
  await activateButton(cdp, `document.querySelector('[data-goal-detail-id="${fixture.off.goalId}"] [data-goal-confirm]')`)
  await waitFor('Main records actual private human scope confirmation', async () => (await fixture.owner.get(fixture.off.goalId)).alignment?.confirmedAt)
  await waitFor('actual mounted Start and continue enabled', () => cdp.evaluate(`Boolean(document.querySelector('[data-goal-detail-id="${fixture.off.goalId}"] .goals-continuation button[type="submit"]:not(:disabled)'))`))
  await activateButton(cdp, `document.querySelector('[data-goal-detail-id="${fixture.off.goalId}"] .goals-continuation button[type="submit"]')`)
  fixture.loop = await waitFor('actual original mounted Continue confirms same Agent input', async () => {
    const loops = await cdp.evaluate(`window.agentmux.continuousProgress.goals(${JSON.stringify(fixture.off.goalId)})`)
    return loops.find(loop => loop.initialDelivery?.state === 'confirmed')
  }, 90_000)
  assert.equal(fixture.loop.agentSessionId, fixture.off.agentSessionId); assert.equal(fixture.loop.initialDelivery.condition.expectedRun.runId, fixture.off.run.runId)
  fixture.off.dispatch = await waitFor('same original Continue operation becomes durably confirmed', async () => {
    const dispatch = await cdp.evaluate(`window.agentmux.demands.inspectDispatch(${JSON.stringify({ goalId: fixture.off.goalId, operationId: fixture.loop.creationOperationId })})`)
    return dispatch?.stage === 'confirmed' ? dispatch : null
  }, 90_000)
  assert.equal(fixture.off.dispatch.stage, 'confirmed'); assert.equal(fixture.off.dispatch.execution, 'continue'); assert.equal(fixture.off.dispatch.loopId, fixture.loop.loopId)
  await waitFor('actual mounted Continue result exposes enabled original Pause', () => cdp.evaluate(`Boolean(Array.from(document.querySelectorAll('[data-goal-detail-id="${fixture.off.goalId}"] .goals-continuation__actions button')).find(e=>e.textContent==='Pause'&&!e.disabled))`), 90_000)
  await activateButton(cdp, `Array.from(document.querySelectorAll('[data-goal-detail-id="${fixture.off.goalId}"] .goals-continuation__actions button')).find(e=>e.textContent==='Pause')`)
  fixture.loop = await waitFor('actual mounted Pause preserves original Loop/Run', async () => (await cdp.evaluate(`window.agentmux.continuousProgress.goals(${JSON.stringify(fixture.off.goalId)})`)).find(loop => loop.loopId === fixture.loop.loopId && loop.status === 'paused'))
  await putDraft(cdp, fixture, fixture.off, waitFor)
  await navigate(cdp, fixture, fixture.off, activateButton, waitFor, 'first-continue')
  fixture.frames.push(await capture(cdp, fixture, 'first-pre-crash-goals'))
  const after = await uiState(cdp)
  assertOriginalRecoveryGraph(after.spatial, expectedOriginalWorkbench)
  assert.deepEqual(after.agentFocus.execution, expectedOriginalFocus.execution)
  fixture.expectedWorkbench = after.spatial; fixture.expectedFocus = after.agentFocus; fixture.expectedMapping = after.demandPmoTabIds
  const retainedNames = expectedPmoNameRetention(after.spatial, fixture.agents)
  fixture.expectedRestoredWorkbench = retainedNames.expected
  fixture.nameRetention = {owner:'original Store.initialize → Main spatial:retainLabels → Core.retainDisplayLabels',added:retainedNames.added,
    before:await retain(fixture,'spatial-before-restart.json',Buffer.from(JSON.stringify(after.spatial))),
    predicted:await retain(fixture,'spatial-expected-after-name-retention.json',Buffer.from(JSON.stringify(retainedNames.expected)))}
  fixture.expectedGoals = await fixture.owner.list(); fixture.beforeStore = await retain(fixture, 'demands-before-restart.json', await readFile(fixture.demandStorePath))
  fixture.retained = fixture.agents.map(agent => ({ goalId: agent.goalId, facts: stable(after, agent) }))
  fixture.retry = fixture.normal // original worker's group-qualification seam names the already existing first Run.
  return { workbench: fixture.expectedWorkbench, focus: fixture.expectedFocus }
}

export async function readDemandCollaborationNativeBaseline({ client, fixture }) {
  for (const agent of fixture.agents) {
    const run = (await client.listRuns()).find(run => run.runId === agent.run.runId)
    assert.equal(run?.state, 'running'); assert.equal(run.pid, agent.process.pid); assert.equal(run.workspacePath, agent.workspacePath)
    assert.equal(await birth(run.pid), agent.birth); assert.ok(Number.isFinite(run.acceptedInputBytes)); agent.inputBeforeRestore = run.acceptedInputBytes
  }
}
export async function restoreDemandCollaborationBeforeSpace({ cdp, fixture, activateButton, waitFor, focusOriginal }) {
  let observedRestoration, restored
  try {
    restored = await waitFor('original Goals and exact Core name-owner acknowledgement before navigation', async () => {
      const value = await uiState(cdp); observedRestoration = value
      return value.selectedDemandId === fixture.off.goalId && value.mainSurface === 'board' &&
        fixture.agents.every(agent => mappedGoal(value, agent.goalId)?.region.kind === 'agent') &&
        isDeepStrictEqual(value.spatial, fixture.expectedRestoredWorkbench) ? value : null
    })
  } finally {
    if (observedRestoration) fixture.nameRetention.actual = await retain(fixture,'spatial-actual-after-restart.json',Buffer.from(JSON.stringify(observedRestoration.spatial)))
  }
  assert.deepEqual(restored.spatial, fixture.expectedRestoredWorkbench, 'Only exact precomputed original name-owner retention is allowed; all other facts stay exact')
  assert.deepEqual(restored.agentFocus, fixture.expectedFocus); assert.deepEqual(restored.demandPmoTabIds, fixture.expectedMapping)
  assert.deepEqual(await fixture.owner.list(), fixture.expectedGoals)
  assert.deepEqual(await cdp.evaluate('window.agentmux.demands.list()'), fixture.expectedGoals)
  const afterStore = await retain(fixture, 'demands-after-restart.json', await readFile(fixture.demandStorePath)); assert.equal(afterStore.sha256, fixture.beforeStore.sha256)
  assert.equal((await readdir(fixture.directory)).filter(name=>name.endsWith('.argv')).length, 2, 'Restart never creates another PMO')
  for (const agent of fixture.agents) {
    const current = await waitFor('same original PMO automatically attached', async () => (await cdp.evaluate('window.agentmux.sessions.snapshot()')).sessions.find(source => source.control.agentSessionId === agent.agentSessionId && source.control.hostId === agent.hostId && source.processState === 'running'))
    assert.deepEqual(current.control.run, agent.run); assert.equal(current.workspacePath, agent.workspacePath)
    assert.deepEqual(stable(restored, agent), fixture.retained.find(item=>item.goalId===agent.goalId).facts)
    assert.equal(stable(restored, agent).draft, draft)
  }
  assert.deepEqual(await cdp.evaluate(`window.agentmux.continuousProgress.goals(${JSON.stringify(fixture.off.goalId)})`), [fixture.loop])
  fixture.frames.push(await capture(cdp, fixture, 'second-restored-before-navigation'))
  await putDraft(cdp, fixture, fixture.normal, waitFor)
  await navigate(cdp, fixture, fixture.normal, activateButton, waitFor, 'second-finite')
  await putDraft(cdp, fixture, fixture.off, waitFor)
  await navigate(cdp, fixture, fixture.off, activateButton, waitFor, 'second-continue')
  const after = await uiState(cdp); fixture.expectedWorkbench = after.spatial; fixture.expectedFocus = after.agentFocus
  await closeMote(cdp, activateButton, waitFor); await focusOriginal()
  return { passed: true, exactFlag: '--demand-collaboration', buildReceiptPath: process.env.AGENTMUX_DEMAND_COLLABORATION_BUILD_RECEIPT,
    actualMountedClicks: ['New Goal ON', 'New Goal OFF', 'Goals Settings toggle and save', 'Assign recommended Supervisor', 'Confirm Goal scope', 'Start and continue', 'Pause', 'Current Goal focus'],
    sourceOnlyNeverDispatch: true, laterOnNeverBackfillsOff: true, noFinalRoleSeed: true, noMockConfirmed: true,
    initialPromptTransport: 'original Core creation/native CLI argv', humanScope: 'explicit private fixture human authored proposal and actual mounted confirmation; not user approval',
    samePmoRunsAutomaticallyAttached: true, restartAutomaticallyCreatedGoal: false, restartAutomaticallySent: false,
    durableStore: { before: fixture.beforeStore, after: afterStore }, nameRetention: fixture.nameRetention, mote: fixture.mote, settingsOn: fixture.settingsOn, settingsOff: fixture.settingsOff,
    agents: fixture.agents, loop: fixture.loop, cliOperations: fixture.cliOperations, navigation: fixture.navigation, frames: fixture.frames,
    originalOutputBeforeRestart: fixture.originalOutput, sourceBefore: fixture.sourceBefore,
    limitations: ['Private exact Core fake-codex Native protocol CLI; actual Run/native record/Hook/receipt, no paid model discussion or model understanding.', 'The exact private fake-codex CLI does not implement read-only app-server native-history requests; its actual nonblocking read service window is retained, and native history is not qualified.', 'Only original baseline workface/queue was seeded; new Goals/PMOs/roles/confirmation/dispatch came from actual product actions.', 'Paused original Loop is preserved; no automatic tick is claimed. Independent visual acceptance remains a separate review.'] }
}
export async function finishDemandCollaborationNativeProof({ client, fixture, result }) {
  for (const agent of fixture.agents) {
    const run = (await client.listRuns()).find(run=>run.runId===agent.run.runId)
    assert.equal(run?.state, 'running'); assert.equal(run.pid, agent.process.pid); assert.equal(run.workspacePath, agent.workspacePath)
    assert.equal(await birth(run.pid), agent.birth); assert.equal(run.acceptedInputBytes, agent.inputBeforeRestore, 'Restoration and Region navigation never resend original creation or Start')
    agent.inputAfterRestore = run.acceptedInputBytes
  }
  assert.deepEqual(await sourceHashes(fixture.desktopRoot), fixture.sourceBefore)
  assert.equal((await readdir(fixture.directory)).filter(name=>name.endsWith('.argv')).length, 2)
  result.noDuplicatePtyInput = true
}
