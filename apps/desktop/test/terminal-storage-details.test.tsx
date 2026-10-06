import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import type { Root } from 'react-dom/client'
import type { AgentMuxRunStorageObservation } from '@agentmux/core'
import type { SessionControl } from '../src/shared/contracts'
import { TerminalServiceNotices } from '../src/renderer/src/components/TerminalServiceNotices'
import { api } from '../src/renderer/src/lib/api'

const original: SessionControl = { kind: 'terminal', hostId: 'local', runId: 'original-run', run: { runId: 'original-run' } }
const MiB = 1024 * 1024
const observed = (): AgentMuxRunStorageObservation => ({ run: original.run, runtime: {
  hostId: 'local', instanceId: 'native-owner', buildIdentity: 'fixture', protocolVersion: 22, processId: 1
}, observedAt: _reshape_fixtureEpoch(0, 0, 1000), status: 'observed', storage: {
  memory: { firstAvailableByte: 5 * MiB, latestOutputByte: 8 * MiB },
  persistence: { firstFailure: 'append_commit: SQLITE_FULL original error', actorStopped: true,
    queuedAppendCommands: 1, offeredByte: 8 * MiB, confirmedByte: 3 * MiB },
  policy: { memoryPerRunBytes: 3 * MiB, memorySharedBytes: 19 * MiB, replayPerRunBytes: 7 * MiB,
    replaySharedBytes: 23 * MiB, databaseBytes: 5 * 1024 * MiB, walCheckpointBytes: 11 * MiB,
    terminalHistoryRows: 2000, terminalCheckpointBytes: 123 * 1024 }
} })
let root: Root, container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() })
async function render(control = original, visible = true, reason?: string) {
  await act(async () => root.render(<TerminalServiceNotices scope={JSON.stringify(control)} visible={visible}
    reveal={null} replayGeometry={null} viewportSync={null} continuation={null}
    attachment={{ kind: 'indeterminate', notice: { step: 'Output observation unconfirmed', mode: 'Original Run remains kept.', restore: 'Read scoped facts.' } }}
    storageControl={control} continuationReason={reason} />))
}
const text = () => container.querySelector('.terminal-storage-details')?.textContent ?? ''
async function check() { const button = container.querySelector<HTMLButtonElement>('.terminal-storage-details button'); expect(button, 'real service-window storage action must be mounted').not.toBeNull(); await act(async () => button!.click()) }

describe('real Terminal service-window storage consumer', () => {
  it('reports responsive writer facts without treating absent failure or stop as operation progress', async () => {
    const value = observed()
    value.storage!.persistence!.firstFailure = null
    value.storage!.persistence!.actorStopped = false
    const read = vi.spyOn(api.sessions, 'observeStorage').mockResolvedValue(value)
    await render(); await check()
    expect(read).toHaveBeenCalledExactlyOnceWith(original)
    expect(text()).toContain('No stop reported · progress unconfirmed')
    expect(text()).toContain('does not settle an outstanding operation')
    expect(text()).not.toContain('Storage persistence failure')
  })
  it('reads only on deliberate checks and shows original owner values without confusing lag, queue or disk floor', async () => {
    const read = vi.spyOn(api.sessions, 'observeStorage').mockResolvedValue(observed())
    const write = vi.spyOn(api.sessions, 'write'), paste = vi.spyOn(api.sessions, 'paste'), attach = vi.spyOn(api.sessions, 'attach')
    const input = document.createElement('textarea'); document.body.append(input); input.focus()
    await render(); await render()
    expect(read).not.toHaveBeenCalled()
    await check()
    expect(read).toHaveBeenCalledExactlyOnceWith(original)
    expect(text()).toContain('append_commit: SQLITE_FULL original error')
    expect(text()).toContain('native-owner')
    expect(text()).toContain('[5,242,880, 8,388,608) B')
    expect(text()).toContain('3,145,728 B')
    expect(text()).toContain('5 MiB · not a lost-byte count')
    expect(text()).toContain('1 · excludes in-flight work')
    expect(text()).toContain('Unknown · not exposed by this observation')
    expect(text()).toContain('3 MiB / 19 MiB'); expect(text()).toContain('7 MiB / 23 MiB')
    expect(text()).toContain('5 GiB'); expect(text()).toContain('11 MiB')
    expect(text()).toContain('2,000 rows'); expect(text()).toContain('123 KiB')
    expect(document.activeElement).toBe(input)
    await render(); expect(read).toHaveBeenCalledOnce()
    await check(); expect(read).toHaveBeenCalledTimes(2)
    expect(read.mock.calls[1]![0]).toEqual(original)
    expect(write).not.toHaveBeenCalled(); expect(paste).not.toHaveBeenCalled(); expect(attach).not.toHaveBeenCalled()
    input.remove()
  })

  it('reports unsupported old Runtime without guessed capacity or disabling another terminal capability', async () => {
    const read = vi.spyOn(api.sessions, 'observeStorage').mockResolvedValue({ ...observed(), status: 'unsupported',
      message: 'This Runtime does not advertise storage_observation:1.' } as AgentMuxRunStorageObservation)
    await render(); await check()
    expect(text()).toContain('This Runtime does not advertise storage_observation:1.')
    expect(text()).toContain('Storage limits and persistence state are unknown')
    expect(text()).not.toContain('Effective capacity policy'); expect(text()).not.toContain('4 MiB')
    expect(container.querySelector('.terminal-storage-details button')?.hasAttribute('disabled')).toBe(false)
    expect(read).toHaveBeenCalledOnce()
  })

  it.each(['source_gap', 'tail_evicted'])('keeps %s distinct from storage failure and capacity policy', async reason => {
    vi.spyOn(api.sessions, 'observeStorage').mockResolvedValue(observed())
    await render(original, true, reason); await check()
    expect(text()).toContain('Storage persistence failure')
    expect(text()).toContain(reason === 'source_gap' ? 'Source gap reported.' : 'Retained tail evicted.')
    expect(text()).not.toContain(reason === 'source_gap' ? 'Retained tail evicted.' : 'Source gap reported.')
  })

  it('does not apply a late sample to a replacement Run and clears only its own pending state', async () => {
    let resolve!: (value: AgentMuxRunStorageObservation) => void
    const read = vi.spyOn(api.sessions, 'observeStorage').mockImplementationOnce(() => new Promise(yes => { resolve = yes }))
      .mockResolvedValue({ ...observed(), run: { runId: 'replacement-run' } })
    await render(); await check()
    expect(container.querySelector('.terminal-storage-details button')?.hasAttribute('disabled')).toBe(true)
    const replacement: SessionControl = { ...original, runId: 'replacement-run', run: { runId: 'replacement-run' } }
    await render(replacement)
    await act(async () => resolve(observed()))
    expect(text()).not.toContain('append_commit'); expect(text()).not.toContain('native-owner')
    await check()
    expect(text()).toContain('replacement-run')
    expect(read.mock.calls[1]![0]).toEqual(replacement)
  })

  it('releases a completed old request while another Run is visible so returning does not leave a stuck button', async () => {
    let resolve!: (value: AgentMuxRunStorageObservation) => void
    const read = vi.spyOn(api.sessions, 'observeStorage').mockImplementationOnce(() => new Promise(yes => { resolve = yes })).mockResolvedValue(observed())
    await render(); await check()
    await render({ ...original, runId: 'replacement-run', run: { runId: 'replacement-run' } })
    await act(async () => resolve(observed()))
    await render(); expect(text()).not.toContain('append_commit')
    expect(container.querySelector('.terminal-storage-details button')?.hasAttribute('disabled')).toBe(false)
    await check(); expect(read).toHaveBeenCalledTimes(2)
  })

  it('ignores hidden late facts and keeps a reachable explicit recheck when the same terminal returns', async () => {
    let resolve!: (value: AgentMuxRunStorageObservation) => void
    const read = vi.spyOn(api.sessions, 'observeStorage').mockImplementationOnce(() => new Promise(yes => { resolve = yes })).mockResolvedValue(observed())
    await render(); await check(); await render(original, false)
    await act(async () => resolve(observed()))
    await render(); expect(text()).not.toContain('append_commit')
    expect(container.querySelector('.terminal-storage-details button')?.hasAttribute('disabled')).toBe(false)
    await check(); expect(read).toHaveBeenCalledTimes(2); expect(text()).toContain('append_commit')
  })

  it.each(['host', 'run'])('rejects a %s-mismatched observation locally and preserves the original retry target', async mismatch => {
    const value = observed(); if (mismatch === 'host') value.runtime.hostId = 'another-host'; else value.run = { runId: 'another-run' }
    const read = vi.spyOn(api.sessions, 'observeStorage').mockResolvedValueOnce(value).mockResolvedValue(observed())
    await render(); await check()
    expect(text()).toContain('Storage observation returned another Host or Run')
    expect(text()).not.toContain('Effective capacity policy')
    await check(); expect(read.mock.calls[1]![0]).toEqual(original); expect(text()).toContain('native-owner')
  })

  it('keeps the last explicit sample after a refresh error without presenting it as a newer observation', async () => {
    vi.spyOn(api.sessions, 'observeStorage').mockResolvedValueOnce(observed()).mockRejectedValueOnce(new Error('Owner read unavailable'))
    await render(); await check(); await check()
    expect(text()).toContain('Owner read unavailable'); expect(text()).toContain('append_commit: SQLITE_FULL original error')
    expect(text()).toContain('Sampled'); expect(container.querySelector('.terminal-storage-details button')?.textContent).toContain('Refresh storage')
  })
})
