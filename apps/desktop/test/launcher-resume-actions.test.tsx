// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LauncherResumeActions } from '../src/renderer/src/components/LauncherResumeActions'
import { launcherTakeoverSource } from '../src/renderer/src/lib/launcher-resume-actions'
import type { LauncherResumeRow } from '../src/renderer/src/lib/launcher-resume'
import { createClientUiRoot } from './helpers/client-ui-render'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'

const initial = useAppStore.getState()
let container: HTMLDivElement, root: Root
function saved(providerId: 'codex' | 'claude', managed = true): LauncherResumeRow {
  return { candidate: { hostId: 'original-host', executorId: 'original-executor', providerId, workspacePath: fixturePath('original'),
    label: 'Saved task', createdAt: 1, updatedAt: 2, capabilities: { providerResume: true } as never,
    nativeSessionId: 'provider-origin', native: { source: { nativeHandle: { kind: 'provider', providerId, sessionId: 'provider-origin',
      transcriptPath: fixturePath('history/original.jsonl') }, workspacePath: fixturePath('original'), revision: 'original-file' }, updatedAt: 2,
      ...(managed ? { managed: { agentSessionId: 'core-original', executorId: 'original-executor', run: { runId: 'retired-run' }, state: 'retired' as const } } : {}) } },
    name: 'Saved task', projectName: 'Original', hostName: 'Original Host', executorName: 'Original executor',
    workspace: undefined, recap: null, inProject: false, stateLabel: 'Saved', stateDetail: 'History preview unavailable' }
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks() })
async function click(label: string) {
  const button = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
  expect(button, label).not.toBeNull(); await act(async () => button!.click())
}
it.each(['codex', 'claude'] as const)('copies the original %s Core link and Provider ID independently of its retired Run', async provider => {
  const write = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined), launch = vi.spyOn(api.sessions, 'launchAgent')
  await act(async () => root.render(<LauncherResumeActions row={saved(provider)} />))
  await click('Copy Agent link'); expect(write).toHaveBeenLastCalledWith('amux://agent/core-original')
  await click('Copy origin session ID'); expect(write).toHaveBeenLastCalledWith('provider-origin')
  expect(launch).not.toHaveBeenCalled()
})
it('keeps unmanaged native identity distinct, copies it and retains the complete locator for takeover', async () => {
  const row = saved('codex', false), choose = vi.fn(), write = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await act(async () => root.render(<LauncherResumeActions row={row} onTakeOver={choose} />))
  expect(document.querySelector('[aria-label="Copy Agent link"]')).toBeNull()
  await click('Copy origin session ID'); expect(write).toHaveBeenCalledWith('provider-origin')
  const trigger = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Take over'))!
  await act(async () => trigger.click()); expect(choose).toHaveBeenCalledWith(row, trigger)
  const origin = { workspaceId: 'display', tabGroupId: 'group', tabId: 'launcher', regionId: 'launcher-region' }
  const source = launcherTakeoverSource(row, origin)
  expect(source.agentSessionId).toBeUndefined(); expect(source.kind).toBe('saved')
  expect(source.nativeSource).toEqual('native' in row.candidate ? row.candidate.native.source : null)
  expect(source).toMatchObject({ hostId: 'original-host', cwd: fixturePath('original'), executorId: 'original-executor', origin })
  if ('native' in row.candidate) row.candidate.native.source.revision = 'replacement'
  expect(source.nativeSource?.revision).toBe('original-file')
})
it('reports a failed copy and leaves the same original identity available for retry', async () => {
  const report = vi.fn(), write = vi.spyOn(api.ui, 'writeClipboardText').mockRejectedValueOnce(new Error('Clipboard unavailable')).mockResolvedValue(undefined)
  useAppStore.setState({ reportError: report })
  await act(async () => root.render(<LauncherResumeActions row={saved('codex')} />))
  await click('Copy Agent link'); expect(report).toHaveBeenCalledOnce(); expect(document.body.textContent).toContain('Retry copy')
  await click('Copy Agent link'); expect(write).toHaveBeenLastCalledWith('amux://agent/core-original')
})
