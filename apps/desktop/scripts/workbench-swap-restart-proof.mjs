import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { reapDetachedRuns } from './probe-owned-run.mjs'
const exec = promisify(execFile)
export async function swapRunBirth(pid) {
  return (await exec('/bin/ps', ['-p', String(pid), '-o', 'pid=,pgid=,lstart='], { env: { ...process.env, LC_ALL: 'C' }, timeout: 5000 })).stdout.trim()
}

// A separate three-Agent input case for the original ordinary crash/restart owner.
// Every peer is a real private Core Session/Run. Parent watchdog cleanup can read
// each durable birth record even if SIGKILL prevents this Node's finally.
export async function createSwapPeers({ client, root, workspacePath, codexHome, peers }) {
  for (let index = 0; index < 2; index++) {
    const directory = await mkdtemp(join(dirname(root), 'workbench-crash-peer-'))
    const executable = join(directory, 'private-cat.sh')
    await mkdir(directory, { recursive: true })
    await writeFile(executable, `#!/bin/sh\numask 077\nLC_ALL=C /bin/ps -p "$$" -o pid=,pgid=,lstart= > '${join(directory, 'owned-run-process.txt')}'\nprintf 'Private Swap peer PTY\\n'\nexec /bin/cat\n`, { mode: 0o700 })
    const session = await client.createAgent({ createOperationId: randomUUID(), executorId: 'probe', providerId: 'codex',
      commandOverride: executable, workspacePath, env: { CODEX_HOME: codexHome }, injectAgentMuxGuide: false, cols: 100, rows: 30 })
    const run = (await client.listRuns()).find(run => run.runId === session.run.runId)
    assert.equal(run?.state, 'running'); assert.ok(run.pid); assert.ok(Number.isFinite(run.acceptedInputBytes))
    const birth = await swapRunBirth(run.pid); assert.ok(birth)
    peers.push({ directory, session, run, birth })
  }
  assert.equal(peers.length, 2)
}

export function seedSwapRegions(seed, { session, peers, tabId, agentRegionId, fileRegionId, workspaceId, identityName }) {
  const thirdId = 'crash-third', tab = seed.state.restoredWorkbench.tabs[tabId]
  const all = [session, ...peers.map(peer => peer.session)]
  seed.state.agentNames = { [session.agentSessionId]: identityName,
    [peers[0].session.agentSessionId]: 'Private saved reviewer', [peers[1].session.agentSessionId]: identityName }
  for (const peer of peers) {
    const id = peer.session.agentSessionId
    seed.state.agentComposerDrafts[id] = `Unsent peer ${id}`
    seed.state.agentSteerQueues[id] = [{ operationId: `peer-queue-${id}`, runId: peer.session.run.runId,
      text: `Pending peer ${id}`, status: 'queued', enqueuedAt: 1_790_832_090_000 }]
  }
  const ids = [agentRegionId, fileRegionId, thirdId]
  tab.regions = Object.fromEntries(all.map((agent, index) => [ids[index], {
    regionId: ids[index], kind: 'agent', phase: 'attached', workspaceId, sessionId: agent.agentSessionId
  }]))
  tab.layout.root.second = { type: 'split', direction: 'horizontal', ratio: 0.5,
    first: { type: 'leaf', regionId: fileRegionId }, second: { type: 'leaf', regionId: thirdId } }
  return { ids, sessions: all.map(agent => agent.agentSessionId) }
}

export async function readSwapFacts(cdp, ids) {
  return cdp.evaluate(`(()=>{const state=JSON.parse(localStorage.getItem('agentmux-workbench-v1')).state;
    return{names:state.agentNames,drafts:state.agentComposerDrafts,queues:state.agentSteerQueues,
      headers:${JSON.stringify(ids)}.map(id=>{const region=document.querySelector('[data-workbench-region-id="'+id+'"]'),name=region?.querySelector('.agent-region-header strong');return{regionId:id,name:name?.textContent,title:name?.title,visible:!!region&&region.checkVisibility()}})}})()`)
}

export async function selectSwapTarget({ cdp, key, activateButton, waitFor, focusNeighbor, agentRegionId, fileRegionId, identityName, tabId }) {
  await cdp.evaluate(`(()=>{window.__swapRestartEvents=[];for(const type of ['keydown','click'])document.addEventListener(type,event=>{
    const item=event.target instanceof Element?event.target.closest('[role="menuitem"]'):null,menu=item?.closest('.agent-region-menu');
    if(menu&&(type!=='keydown'||event.key==='Enter')){const state=JSON.parse(localStorage.getItem('agentmux-workbench-v1')).state;
      window.__swapRestartEvents.push({type,trusted:event.isTrusted,label:item.textContent.trim(),owner:menu.dataset.ownerRegionId,open:menu.dataset.state==='open',active:state.restoredWorkbench.tabs[${JSON.stringify(tabId)}].layout.activeRegionId})}
  },true)})()`)
  await activateButton(cdp, `document.querySelector('[data-workbench-region-id="${agentRegionId}"] .agent-region-header__more')`)
  await waitFor('original three-Agent menu is open', () => cdp.evaluate(`document.querySelector('.agent-region-menu[data-owner-region-id="${agentRegionId}"]')?.dataset.state==='open'`))
  const focusReceipt = await focusNeighbor()
  const menu = `document.querySelector('.agent-region-menu[data-owner-region-id="${agentRegionId}"]')`
  const observed = await waitFor('three Agent Swap targets', () => cdp.evaluate(`(()=>{const menu=${menu};if(!menu)return null;return{open:menu.dataset.state==='open',active:JSON.parse(localStorage.getItem('agentmux-workbench-v1')).state.restoredWorkbench.tabs[${JSON.stringify(tabId)}].layout.activeRegionId,
    entries:[...menu.querySelectorAll('[role="menuitem"]')].filter(item=>item.textContent.trim().startsWith('Swap with ')).map(item=>item.textContent.trim())}})()`)
    .then(value => value?.open && value.active === fileRegionId ? value : null))
  assert.deepEqual(observed, { open: true, active: fileRegionId, entries: ['Swap with Private saved reviewer', `Swap with ${identityName} 2`] })
  const target = await cdp.evaluate(`(()=>{const items=[...${menu}.querySelectorAll('[role="menuitem"]')].filter(item=>item.textContent.trim().startsWith('Swap with '));const item=items[1];if(!item||!item.checkVisibility())return false;item.focus();return document.activeElement===item})()`)
  assert.equal(target, true); await key(cdp, 'Enter', 'Enter')
  const events = await waitFor('trusted original Swap selection', () => cdp.evaluate('window.__swapRestartEvents.length===2&&window.__swapRestartEvents'))
  assert.deepEqual(events, [
    { type: 'keydown', trusted: true, label: `Swap with ${identityName} 2`, owner: agentRegionId, open: true, active: fileRegionId },
    { type: 'click', trusted: false, label: `Swap with ${identityName} 2`, owner: agentRegionId, open: true, active: fileRegionId }
  ])
  return { observed, events, focusReceipt }
}

export async function restoreSwapMenu({ cdp, key, activateButton, waitFor, agentRegionId, identityName }) {
  await activateButton(cdp, `document.querySelector('[data-workbench-region-id="${agentRegionId}"] .agent-region-header__more')`)
  const menu = `document.querySelector('.agent-region-menu[data-owner-region-id="${agentRegionId}"]')`
  const entries = await waitFor('restored three-Agent numbered Swap menu', () => cdp.evaluate(`(()=>{const menu=${menu};return menu&&[...menu.querySelectorAll('[role="menuitem"]')].filter(item=>item.textContent.trim().startsWith('Swap with ')).map(item=>item.textContent.trim())})()`))
  assert.deepEqual(entries, [`Swap with ${identityName} 1`, 'Swap with Private saved reviewer'])
  await key(cdp, 'Escape', 'Escape'); await waitFor('restored Swap dismissed', () => cdp.evaluate(`!${menu}`))
  return entries
}

export async function cleanupSwapPeers(root, peers) {
  if (!peers.length) return []
  const records = await reapDetachedRuns(dirname(root))
  for (const peer of peers) await rm(peer.directory, { recursive: true })
  return records
}
