// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it } from 'vitest'
import type { AgentMuxContinuityLaunchInput } from '@agentmux/core/agent-session-recovery'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

const dom = composerDOM()
it.each(['launch-carried', 'not-applied', 'unknown'] as const)('shows the original %s carrier through the real mailbox consumer', async state => {
  const session = composerSession(), submissionId = 'original-resume-input'
  const input = { submissionId, prompt: 'Original native launch input', authorHuman: true, sourceChannel: 'message-tool' as const }
  const receipt: AgentMuxContinuityLaunchInput = { input, prompt: input.prompt, digest: 'fixture-source-digest',
    message: { userContent: input.prompt, authorHuman: true, sourceChannel: input.sourceChannel }, delivery: 'launch',
    lifecycleOperationId: 'original-launch', state, ...(state === 'launch-carried' ? {
      key: { kind: 'prompt', agentSessionId: session.id, expectedRun: session.control.run, submissionId },
      receipt: { kind: 'runtime-launch', operationId: 'original-launch', run: session.control.run, observedAt: _historyFixtureEpoch(0, 0, 1) }
    } : {}) }
  useAppStore.setState({ sessions: [session], loading: false, agentSteerQueues: { [session.id]: [{ operationId: submissionId,
    text: input.prompt, status: 'deferred', promptCondition: null, inputIntakeStarted: true,
    resumeInputIntent: { control: { ...session.control, run: { runId: 'original-ended-run' } }, input }, resumeInputReceipt: receipt,
    ...(state === 'launch-carried' ? { archived: true as const } : {}),
    ...(state === 'not-applied' ? { errorCode: 'AGENT_PROMPT_CONDITION_CHANGED' } : {}) }] } })
  await dom.render(<AgentSessionComposer sessionId={session.id} />)
  const mailbox = dom.container.querySelector<HTMLElement>('.composer-mailbox')!
  const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'open' })
  await act(async () => mailbox.dispatchEvent(event))
  await dom.click('[role="tab"][id$="-outbox-tab"]')
  const row = mailbox.querySelector<HTMLElement>('[data-operation-id="original-resume-input"]')!
  expect(row).not.toBeNull()
  const expected = state === 'launch-carried' ? '随恢复启动提交' : state === 'not-applied' ? '原恢复输入未应用' : '发送结果待核实'
  expect(row.textContent).toContain(expected)
  await act(async () => row.querySelector<HTMLButtonElement>('button')!.click())
  if (state === 'launch-carried') {
    expect(row.textContent).toContain('Runtime 已确认')
    expect(row.textContent).toContain('CLI 是否采用')
    expect(row.querySelector<HTMLButtonElement>('[aria-label="恢复为待发"]')?.disabled).toBe(true)
    expect(row.textContent).not.toContain('发送结果待核实')
  } else if (state === 'not-applied') {
    expect(row.querySelector('[aria-label="移至草稿"]')).not.toBeNull()
    expect(row.querySelector('[aria-label="Send queued message"]')).toBeNull()
    expect(row.textContent).not.toContain('发送结果待核实')
  }
  expect(dom.draft()).toBe('Keep my draft')
})
