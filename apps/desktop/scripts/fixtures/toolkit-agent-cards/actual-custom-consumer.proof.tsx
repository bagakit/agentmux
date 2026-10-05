// @vitest-environment happy-dom
// Cross-task qualification is collected only by the explicit card proof driver.
// Ordinary Root test/spec globs do not collect this artifact-dependent proof.
import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { parseToolkitSnapshot, parseToolkitResultDocument } from '@agentmux/core/control'
import { UserToolkitResult } from '../../../src/renderer/src/components/toolkit/UserToolkitResult'
import { SettingsNavigation } from '../../../src/renderer/src/components/SettingsNavigation'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { composerDOM, composerSession } from '../../../test/helpers/composer-dom-fixture'

const dom = composerDOM()
function agent(id: string, hostId: string, sid: string, runId: string) {
  const value = composerSession(id)
  return { ...value, hostId, label: `Named ${id}`, status: { ...value.status, state: 'working' as const },
    control: { ...value.control, hostId, agentSessionId: sid, run: { runId } } }
}
function node() {
  const result = dom.container.querySelector<HTMLElement>('[data-toolkit-agent-card]')
  expect(result).not.toBeNull()
  return result!
}

it('actual ordinary script confirmed by the Toolkit owner and public CLI reaches the real Custom result consumer', async () => {
  const path = process.env.AGENTMUX_TOOLKIT_AGENT_CARDS_CUSTOM_RESULT
  expect(path, 'T001 actual script execution artifact is required').toBeTruthy()
  const artifact = JSON.parse(readFileSync(path!, 'utf8'))
  const snapshot = parseToolkitSnapshot(artifact.snapshot)
  expect(snapshot.kind).toBe('script')
  if (snapshot.kind !== 'script') throw Error('Expected the ordinary Custom owner snapshot')
  expect(snapshot.state).toBe('succeeded'); expect(snapshot.admission).toBeNull()
  expect(snapshot.latestConfirmed?.state).toBe('succeeded'); expect(snapshot.latestConfirmed?.exitCode).toBe(0)
  const document = parseToolkitResultDocument(JSON.parse(snapshot.latestConfirmed!.text.trim()))
  const reference = document.agentCards!.items[0]!.reference
  expect(reference.kind).toBe('session')
  if (reference.kind !== 'session') throw Error('Expected an exact public Session card reference')
  expect(snapshot.latestConfirmed?.run?.runId).toBeTruthy()
  expect(artifact.executionProof.privateChildExited).toBe(true); expect(artifact.executionProof.childPid).toBeGreaterThan(0)
  useAppStore.setState({ sessions: [agent('display-id', reference.hostId, reference.sessionId, 'agent-original-run')] })
  const run = vi.spyOn(api.toolkit, 'run'), stop = vi.spyOn(api.toolkit, 'stop'), action = vi.spyOn(api.toolkit, 'action')
  vi.spyOn(api.toolkit, 'observe').mockImplementation((_id, read) => { read(snapshot); return { dispose() {} } })
  await dom.render(<SettingsNavigation.Provider value={{ open() {}, openToolkit() {}, openHost() {} }}><UserToolkitResult definition={snapshot.definition} active close={() => {}} /></SettingsNavigation.Provider>)
  expect(node().dataset.agentCardState).toBe('resolved'); expect(node().textContent).toContain('Named display-id')
  expect(node().querySelector('.agent-avatar')).not.toBeNull()
  const metrics = node().querySelectorAll('[data-toolkit-card-metric]')
  expect(metrics).toHaveLength(document.agentCards!.items[0]!.metrics.length)
  expect(metrics.length).toBeGreaterThan(0)
  for (const [index, metric] of document.agentCards!.items[0]!.metrics.entries()) expect(metrics[index]!.textContent).toBe(metric.label + metric.value)
  expect(dom.container.querySelector('[data-toolkit-output]')).toBeNull()
  expect(run).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(action).not.toHaveBeenCalled()
})
