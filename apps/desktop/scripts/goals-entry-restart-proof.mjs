import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

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
  'src/renderer/src/lib/workbench-persistence.ts', 'src/renderer/src/store.ts', 'src/renderer/src/styles/goals.css'
]

async function sources(desktopRoot) {
  return Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, digest(await readFile(join(desktopRoot, file)))])))
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
export async function createGoalsEntryFixture({ root, topicsPath, desktopRoot }) {
  const directory = join(root, 'goals-entry-runs'), executable = join(root, 'goals-entry-cat.sh')
  await mkdir(directory, { mode: 0o700 })
  await writeFile(executable, `#!/bin/sh\numask 077\nproof_directory=${quote(directory)}\ntest -n "$AGENTMUX_AGENT_SESSION_ID" || exit 64\nLC_ALL=C /bin/ps -p "$$" -o pid=,pgid=,lstart= > "$proof_directory/$AGENTMUX_AGENT_SESSION_ID.birth"\nprintf '%s\\0' "$@" > "$proof_directory/$AGENTMUX_AGENT_SESSION_ID.argv"\nprintf 'Private Goals entry PTY\\n'\nexec /bin/cat\n`, { mode: 0o700 })
  return { directory, executable, topicsPath, topicsMode: (await stat(topicsPath)).mode & 0o777,
    sourceBefore: await sources(desktopRoot), desktopRoot, agents: [] }
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
  const created = await waitFor('Core confirms the provider launch request', async () => {
    const reply = await cdp.evaluate(`window.agentmux.sessions.creation('local', ${JSON.stringify(snapshot.id)})`)
    return reply.creation?.initialPrompt === 'confirmed' ? reply : null
  })
  const argv = await readFile(join(fixture.directory, `${snapshot.id}.argv`))
  assert.ok(argv.length > 0, 'Actual exec argv must be nonempty')
  const args = argv.toString('utf8').split('\0').filter(Boolean)
  const matching = args.filter(arg => arg.includes(request))
  assert.equal(matching.length, 1, 'The visible request must reach exactly one actual launch argument')
  assert.equal(matching[0].split(request).length - 1, 1, 'The launch argument contains the exact request once')
  assert.equal(matching[0].split('\n').at(-1), request, 'The user request line remains byte-for-byte equal to the visible CTA')
  const recordedBirth = (await readFile(join(fixture.directory, `${snapshot.id}.birth`), 'utf8')).trim()
  const process = parseBirth(recordedBirth)
  assert.equal(await birth(process.pid), recordedBirth, 'The actual private cat process is still the recorded birth')
  const agent = { tabId: topic.tab.id, topicId: topic.tab.topicId, regionId: topic.region.regionId,
    agentSessionId: snapshot.id, run: snapshot.control.run, process, birth: recordedBirth,
    request, requestDigest: digest(request), inputTransport: 'provider-launch-argv',
    requestOccurrences: 1, initialPrompt: created.creation.initialPrompt }
  fixture.agents.push(agent)
  return agent
}

export async function clickGoalsEntryInActualUI({ cdp, fixture, activateButton, waitFor, expectedOriginalWorkbench, expectedOriginalFocus }) {
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
  const metadata = await cdp.evaluate(`window.agentmux.scratch.readTopic('__scratch__', ${JSON.stringify(normal.tab.topicId)})`)
  assert.equal(metadata?.id, normal.tab.topicId); assert.ok(metadata.soul, 'A real prepared Mote owns this Topic')
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
      return shown?.includes('preparation') && shown.includes('not been sent') ? topic : null
    })
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
  assert.ok(Number.isFinite(run.acceptedInputBytes) && run.acceptedInputBytes >= 0)
  assert.equal(await birth(run.pid), fixture.normal.birth)
  fixture.normal.inputBeforeRestore = run.acceptedInputBytes
}

export async function restoreGoalsEntryBeforeSpace({ cdp, fixture, activateButton, waitFor, focusOriginal }) {
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
    sourceBefore: fixture.sourceBefore, agents: fixture.agents,
    limitations: ['Synthetic private Codex command records actual launch argv and then execs cat; argv receipt is distinct from PTY input and does not prove model understanding.',
      'Only original workbench facts were seeded; both new Topics, Regions and Agent Sessions came from actual mounted product actions.'] }
}

export async function finishGoalsEntryNativeProof({ client, fixture, result }) {
  const runs = await client.listRuns()
  for (const agent of fixture.agents) {
    const run = runs.find(item => item.runId === agent.run.runId)
    assert.equal(run?.state, 'running'); assert.equal(run.pid, agent.process.pid)
    assert.equal(await birth(run.pid), agent.birth)
    agent.inputAfterRestore = run.acceptedInputBytes
  }
  assert.equal(fixture.normal.inputAfterRestore, fixture.normal.inputBeforeRestore, 'Ordinary restart must not write duplicate PTY input to the already launched request')
  assert.deepEqual(await sources(fixture.desktopRoot), fixture.sourceBefore, 'Executed proof sources must stay exact throughout this candidate')
  result.noDuplicatePtyInput = true
}

export async function cleanupGoalsEntryRuns(fixture) {
  if (!fixture) return []
  await chmod(fixture.topicsPath, fixture.topicsMode)
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
