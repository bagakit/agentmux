// @vitest-environment happy-dom
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner'
import { agentPromptSubmissionOutcome } from '@agentmux/core/mote-dialogue'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, nativeImage: {} }))
import { RuntimeController } from '../src/main/runtime-controller'
import { sessionInputOperationResult, unwrapSessionInputOperationResult } from '../src/shared/session-input-result'

it('Desktop reads an original submission without a controlled-wait journal; inspection cannot dispatch or retarget it', async () => {
  // Real Core, original Store and controller. Only PTY byte I/O is a deterministic port.
  const f = await rpcOwnerFixture(['original-heartbeat'])
  const controller = new RuntimeController(f.store, async () => f.client)
  try {
    const session = f.client.agentSession('original-heartbeat')!
    const key = { kind: 'prompt' as const, agentSessionId: session.agentSessionId, expectedRun: session.run, submissionId: 'original-platform-tick' }
    await f.client.submitAgentPrompt({ agentSessionId: session.agentSessionId, expectedRun: session.run, operationId: key.submissionId,
      prompt: 'Exact original terminal input', afterSubmissionId: null })
    const before = f.rawInput.mock.calls.length
    vi.spyOn(f.client, 'connect').mockRejectedValue(new Error('This read does not reconnect or start a Runtime.'))
    controller.commit(await controller.prepare({ version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private original Host' }], executors: {},
      workspaces: [{ id: 'private', hostId: 'local', name: 'Private', path: f.root, kind: 'folder' }], appearance: { terminalTheme: 'graphite' },
      browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }))
    const control = { kind: 'agent' as const, hostId: 'local', agentSessionId: session.agentSessionId, run: session.run }
    expect(await controller.inspectInput(control, key)).toBeNull()
    const record = unwrapSessionInputOperationResult(await sessionInputOperationResult(() => controller.inspectSubmission(control, key)))
    expect(record?.agentSessionId).toBe(session.agentSessionId)
    expect(record?.run).toEqual(session.run)
    expect(agentPromptSubmissionOutcome(record)).toBe('terminal-confirmed')
    expect(f.rawInput.mock.calls.length).toBe(before)
    await expect(controller.inspectSubmission({ ...control, agentSessionId: 'another-original' }, key)).rejects.toThrow()
    expect(f.rawInput.mock.calls.length).toBe(before)
  } finally { await controller.dispose(); await f.close() }
})
