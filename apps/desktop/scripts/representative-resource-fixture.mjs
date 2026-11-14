import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { connectHostedAgentMux } from '@agentmux/core/hosted'
import { folderSpaceFacts } from '@agentmux/core/space-folder'
import { createWorkbenchViewLayout, createWorkspaceLayout } from '@agentmux/core/spatial-layout'
import {
  REPRESENTATIVE_BURST_BYTES,
  REPRESENTATIVE_HISTORY_BYTES,
  REPRESENTATIVE_RUN_COUNT,
  REPRESENTATIVE_TAB_COUNT
} from '../src/main/representative-resource-budget.ts'

// Each original PTY has real retained output, a bounded stream, and a typed-key echo.
// Sequence numbers make these normal scrollback lines with multiple distinct frames.
async function terminalProgram(directory) {
  const path = join(directory, 'terminal-workload.cjs')
  await writeFile(path, String.raw`
let line = 0
function emit(minimumBytes) {
  const lines = []
  let total = 0
  while (total < minimumBytes) {
    const row = String(++line).padStart(6, '0') + ' compiling example module with a retained status line\r\n'
    lines.push(row); total += row.length
  }
  process.stdout.write(lines.join(''))
}
process.stdin.setRawMode(true)
process.stdin.on('data', bytes => {
  for (const key of bytes.toString()) {
    if (!'wapr'.includes(key)) continue
    if (key === 'p') emit(${REPRESENTATIVE_BURST_BYTES})
    process.stdout.write('resource-probe-echo:' + key + '\r\n')
  }
})
emit(${REPRESENTATIVE_HISTORY_BYTES})
const timer = setInterval(() => emit(4096), 500)
setTimeout(() => { clearInterval(timer); process.exit(0) }, 150_000).unref()
`, { mode: 0o600 })
  return path
}

export async function seedRepresentativeWorkface({ rpc, storePath, directory, workspaces, fixturePath }) {
  const client = await connectHostedAgentMux({ rpc, expectedStorePath: storePath, connectOnDemand: true })
  try {
    const command = await terminalProgram(directory)
    const graph = { spaces: [], zones: [], bindings: [], tabs: [], regions: [], layouts: {}, tabLayouts: {}, resources: {} }
    const tabs = [], runs = []
    const runsPerWorkspace = REPRESENTATIVE_RUN_COUNT / workspaces.length
    let remainingTabs = REPRESENTATIVE_TAB_COUNT
    for (const [workspaceIndex, workspace] of workspaces.entries()) {
      const { space, zone } = folderSpaceFacts(workspace)
      graph.spaces.push(space)
      graph.zones.push(zone)
      graph.bindings.push({ spaceId: space.spaceId, zoneId: zone.zoneId })
      graph.resources[`zone:${zone.zoneId}`] = { spaceId: space.spaceId, workspaceId: workspace.id, workspacePath: workspace.path }
      const groupId = `resource-group-${workspaceIndex}`
      const count = Math.ceil(remainingTabs / (workspaces.length - workspaceIndex))
      remainingTabs -= count
      const filesPath = join(workspace.path, 'modules')
      await mkdir(filesPath)
      const tabIds = []
      for (let index = 0; index < count; index++) {
        const id = `resource-tab-${workspaceIndex}-${index}`
        const regionId = `${id}-region`
        const terminal = index < runsPerWorkspace
        const run = terminal ? await client.createTerminal({ workspacePath: workspace.path, command: process.execPath, args: [command], cols: 100, rows: 28 }) : null
        if (run) runs.push({ runId: run.runId, pid: run.pid, workspaceId: workspace.id, regionId })
        const path = `modules/example-${index}.ts`
        if (!run) {
          const rules = Array.from({ length: 220 }, (_, row) => `export const rule${row} = { module: ${index}, row: ${row}, enabled: true }\n`)
          await writeFile(join(workspace.path, path), rules.join(''))
        }
        const region = { tabId: id, regionId, kind: run ? 'terminal' : 'file', agentSessionId: null,
          runId: run?.runId ?? null, execution: run ? { hostId: workspace.hostId, cwd: workspace.path } : null,
          ...(run ? {} : { file: { workspaceId: workspace.id, path, zoneRelativePath: path } }) }
        graph.tabs.push({ tabId: id, workspaceId: workspace.id, zoneId: zone.zoneId, name: null, regionIds: [regionId] })
        graph.regions.push(region)
        graph.tabLayouts[id] = createWorkbenchViewLayout(regionId)
        graph.resources[`tab:${id}`] = { titleRegionId: regionId, space: { spaceId: space.spaceId, zoneId: zone.zoneId } }
        graph.resources[`region:${regionId}`] = run ? { workspaceId: workspace.id, phase: 'attached', sessionId: run.runId } : { workspaceId: workspace.id, path }
        tabIds.push(id)
        tabs.push({ id, workspaceId: workspace.id, groupId, regionId })
      }
      graph.layouts[workspace.id] = createWorkspaceLayout(groupId, tabIds)
    }
    if (tabs.length !== REPRESENTATIVE_TAB_COUNT || runs.length !== REPRESENTATIVE_RUN_COUNT) throw new Error('Representative fixture cardinality differs from its contract.')
    await Promise.all(runs.map(async terminal => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const { run } = await client.runtimeSubject({ kind: 'terminal-run', runId: terminal.runId })
        if (!run || !run.pid || run.pid !== terminal.pid || run.state !== 'running') throw new Error(`Fixture Run ${terminal.runId} changed identity before save.`)
        if (run.latestOutputBytes >= REPRESENTATIVE_HISTORY_BYTES) {
          terminal.seededOutputBytes = run.latestOutputBytes
          return
        }
        await delay(100)
      }
      throw new Error(`Fixture Run ${terminal.runId} did not produce retained output history.`)
    }))
    const { state } = await rpc.call('space.commit', { expectedRevision: 0, graph }, { signal: AbortSignal.timeout(15_000) })
    if (state.revision <= 0) throw new Error('Representative fixture durable layout was not confirmed.')
    await writeFile(fixturePath, JSON.stringify({ revision: state.revision, tabs, runs }) + '\n', { mode: 0o600 })
  } finally {
    await client.dispose()
  }
}
