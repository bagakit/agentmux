// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileGoalEvidence } from '../src/goals/MobileGoalEvidence'
import { goalEvidenceSource } from '../../desktop/test/helpers/goal-evidence-source'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
it('reads the original Host file through public file.read and keeps its full reference copyable', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const source = await goalEvidenceSource(); cleanup.push(source.dispose)
  const element = document.createElement('div'); document.body.append(element); const root: Root = createRoot(element)
  cleanup.push(async () => { await act(async () => root.unmount()); element.remove() })
  const forwardRpc = vi.fn(async (method, params) => { expect(method).toBe('file.read'); return source.owner.read(params) })
  const client = { forwardRpc, runtimeOwnerIdentity: () => ({ runtimeId: 'original-runtime', ownerInstanceId: 'owner', availability: 'connected' }) } as unknown as AgentMuxHostedClient
  const copy = vi.fn(async (_text: string) => true)
  await act(async () => root.render(<MobileGoalEvidence evidence={[source.evidence, 'result.log:2']} client={client} copyText={copy} />))
  await act(async () => element.querySelector('button')!.click())
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }); expect(element.querySelector('pre')?.textContent).toBe('ORIGINAL worktree evidence') })
  expect(forwardRpc).toHaveBeenCalledExactlyOnceWith('file.read', source.target)
  expect(element.textContent).toContain('未记录本地文件来源')
  await act(async () => [...element.querySelectorAll('button')].find(button => button.textContent === '复制完整引用')!.click())
  expect(copy.mock.calls[0]![0]).toBe(JSON.stringify(source.evidence))
})
