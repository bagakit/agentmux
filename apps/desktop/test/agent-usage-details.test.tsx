// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentTurnUsage } from '@agentmux/core'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { AgentUsageDetails } from '../src/renderer/src/components/AgentUsageDetails'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let host: HTMLDivElement, root: Root
const sample: AgentTurnUsage = { scope: 'response', inputTokens: 29, outputTokens: 7, totalTokens: 43,
  observedAt: fixtureEpoch(1), context: { usedTokens: 43, capacityTokens: 256 },
  cumulative: { scope: 'native-session', inputTokens: 400, outputTokens: 90, totalTokens: 523 } }
const counts = (scope: string) => [...host.querySelectorAll(`[data-agent-usage-scope="${scope}"] dd`)].map(node => node.textContent)
async function render(usage?: AgentTurnUsage) { await act(async () => root.render(<AgentUsageDetails usage={usage} />)) }
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

describe('shared Agent usage detail over held native observations', () => {
  it('separates native Session cumulative, last response and context with one observation time', async () => {
    await render(sample)
    expect(counts('native-session')).toEqual(['400', '90', '523']); expect(counts('response')).toEqual(['29', '7', '43'])
    expect(host.textContent).toContain('17% used'); expect(host.textContent).toContain('83% remaining'); expect(host.textContent).toContain('43 of 256 tokens · 213 remaining')
    expect(host.querySelectorAll('.agent-usage-details__observed')).toHaveLength(1)
    expect(host.textContent).toContain(new Date(sample.observedAt).toLocaleString())
    expect(host.querySelectorAll('button,[popover],input')).toHaveLength(0)
  })
  it('keeps missing data unknown without zero or falsely assigning a legacy response scope', async () => {
    await render()
    expect(host.textContent).toContain('Cumulative tokens not reported'); expect(host.textContent).toContain('No native response sample')
    expect(host.textContent).toContain('Observation unavailable'); expect(host.querySelectorAll('dd')).toHaveLength(0); expect(host.textContent).not.toContain('% remaining')
    const { scope: _scope, cumulative: _cumulative, context: _context, ...legacy } = sample
    await render(legacy)
    expect(host.textContent).toContain('Latest report · scope unrecorded'); expect(counts('unknown')).toEqual(['29', '7', '43'])
    expect(host.textContent).toContain('Cumulative tokens not reported'); expect(host.textContent).not.toContain('% remaining')
  })
  it('shows reported zero as zero and preserves the original valid-capacity context rule', async () => {
    await render({ ...sample, inputTokens: 0, outputTokens: 0, totalTokens: 0, context: { usedTokens: 0, capacityTokens: 256 },
      cumulative: { scope: 'native-session', inputTokens: 0, outputTokens: 0, totalTokens: 0 } })
    expect(counts('native-session')).toEqual(['0', '0', '0']); expect(counts('response')).toEqual(['0', '0', '0'])
    expect(host.textContent).toContain('0% used'); expect(host.textContent).toContain('100% remaining'); expect(host.textContent).toContain('256 remaining')
    await render({ ...sample, context: { usedTokens: 0, capacityTokens: 0 } })
    expect(host.textContent).toContain('Used tokens and capacity not reported'); expect(host.textContent).not.toContain('% remaining')
  })
  it('allows context to decrease without locally summing or reinterpreting the cumulative total', async () => {
    await render(sample)
    const body = host.firstElementChild
    await render({ ...sample, context: { usedTokens: 20, capacityTokens: 256 }, observedAt: fixtureEpoch(2) })
    expect(host.firstElementChild).toBe(body); expect(host.textContent).toContain('8% used'); expect(host.textContent).toContain('92% remaining')
    expect(host.textContent).toContain('236 remaining'); expect(counts('native-session')).toEqual(['400', '90', '523'])
  })
})
