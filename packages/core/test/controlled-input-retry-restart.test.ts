import { readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'

const close: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of close.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs() })

it('retains the original Session and rejected successor across an owner process restart and delivers once to the original real PTY', async () => {
  vi.stubEnv('AGENTMUX_TEST_OWNER_ENTRY', resolve(import.meta.dirname, 'fixtures/controlled-input-retry-worker.mjs'))
  const h = await headlessFixture(); close.push(h.cleanup)
  let client = await h.client()
  const output = join(h.root, 'input.jsonl'), text = 'Original logical input survives owner restart 原输入'
  const session = await client.createAgent({ agentSessionId: 'original-retry-session', createOperationId: 'original-retry-create',
    providerId: 'pi', executorId: 'pi', workspacePath: h.root, injectAgentMuxGuide: false,
    commandOverride: process.execPath, args: [resolve(import.meta.dirname, 'fixtures/prompt-carrier-terminal.mjs')],
    env: { AGENTMUX_TEST_INPUT_WITNESS: output } })
  const before = await until(async () => {
    try { const ready = JSON.parse(await readFile(output + '.ready', 'utf8')); const status = await client.statusAgent(session.agentSessionId)
      return status.run.pid === ready.pid ? status : null } catch { return null }
  }, Boolean, 'original real PTY ready')
  const key = { kind: 'prompt' as const, agentSessionId: session.agentSessionId, expectedRun: session.run, submissionId: 'original-logical-input' }
  const read = () => client.inspectAgentInput({ key })
  const terminalInputs = async () => (await readFile(output, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error }))
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line).text as string)
  await h.failInput({ disposition: 'not_applied', confirmedInputBytes: 0 })
  await client.submitAgentPrompt({ agentSessionId: session.agentSessionId, expectedRun: session.run, operationId: key.submissionId,
    prompt: text, execution: 'immediate', admissionIntent: { kind: 'manual-actor' }, authorHuman: true })
  const first = await until(read, value => value?.status === 'not-applied', 'original whole input rejected').catch(async error => {
    throw new Error(String(error) + '\nOriginal receipt: ' + JSON.stringify(await read()))
  })
  const originalClaim = await client.inspectAgentPromptSubmission(key)
  await client.rejoinAgentInputWaiting({ ref: first!.ref })
  const second = await until(read, value => value?.status === 'not-applied' && value.ref.waitGeneration === first!.ref.waitGeneration + 1, 'successor whole input rejected')
  const secondKey = second!.control.deliveryKey!, secondClaim = await client.inspectAgentPromptSubmission(secondKey)
  expect(await terminalInputs()).toEqual([])
  const owner = h.owner, ownerPid = h.ownerProcess.pid
  await client.dispose(); await h.stopOwner()
  await rm(join(h.env.AGENTMUX_STATE_DIRECTORY!, 'input-failure'))
  await h.restart(); client = await h.client()
  expect(h.ownerProcess.pid).not.toBe(ownerPid)
  expect(h.owner).toMatchObject({ runtimeId: owner.runtimeId, ctxmux: owner.ctxmux })
  expect(h.owner.ownerInstanceId).not.toBe(owner.ownerInstanceId)
  expect((await client.statusAgent(session.agentSessionId)).run).toMatchObject({ runId: before!.run.runId, pid: before!.run.pid, state: 'running' })
  expect(await read()).toEqual(second)
  expect(await client.inspectAgentPromptSubmission(key)).toEqual(originalClaim)
  expect(await client.inspectAgentPromptSubmission(secondKey)).toEqual(secondClaim)
  const [a, b] = await Promise.all([client.rejoinAgentInputWaiting({ ref: second!.ref }), client.rejoinAgentInputWaiting({ ref: second!.ref })])
  expect(a.ref).toEqual(b.ref)
  const complete = await until(read, value => value?.status === 'terminal-confirmed', 'original logical input confirmed')
  expect(complete).toMatchObject({ key, ref: { key, waitGeneration: first!.ref.waitGeneration + 2 },
    control: { deliveryKey: { ...key, attemptId: expect.any(String) }, retry: { previousKey: secondKey } } })
  await until(terminalInputs, values => values.length === 1, 'complete original PTY input once')
  expect(await terminalInputs()).toEqual([text])
  expect((await client.rejoinAgentInputWaiting({ ref: first!.ref })).ref).toEqual(complete!.ref)
  expect(await client.inspectAgentPromptSubmission(key)).toEqual(originalClaim)
  expect(await client.inspectAgentPromptSubmission(secondKey)).toEqual(secondClaim)
  expect((await client.readAgentInputMailbox({ agentSessionId: session.agentSessionId })).items).toHaveLength(1)
  expect(await terminalInputs()).toEqual([text])
  if (process.env.AGENTMUX_INPUT_RETRY_RESTART_EVIDENCE) await writeFile(process.env.AGENTMUX_INPUT_RETRY_RESTART_EVIDENCE,
    JSON.stringify({ ownerBefore: owner, ownerAfter: h.owner, ownerPidBefore: ownerPid, ownerPidAfter: h.ownerProcess.pid,
      sessionBefore: before, sessionAfter: await client.statusAgent(session.agentSessionId), originalKey: key,
      originalClaim, secondClaim, receipt: complete, terminalInputs: await terminalInputs() }, null, 2))
  await client.stopAgent(session.agentSessionId, session.run)
}, 60_000)
