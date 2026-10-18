import { describe, expect, it } from 'vitest'
import { createWorkspaceLayout, setSplitRatio, type TabGroupLayoutNode, type WorkspaceLayout } from '@agentmux/layout'
import { workbenchDisplayGroupMatches, workbenchProjectionSplitPath } from '../src/renderer/src/lib/workbench-resource-display'

type Split = Extract<TabGroupLayoutNode, { type: 'split' }>
const leaf = (groupId: string): TabGroupLayoutNode => ({ type: 'leaf', groupId })
const split = (first: TabGroupLayoutNode, second: TabGroupLayoutNode, direction: Split['direction'] = 'horizontal', ratio = 0.5): Split =>
  ({ type: 'split', first, second, direction, ratio })
const layout = (root: TabGroupLayoutNode): WorkspaceLayout => ({ ...createWorkspaceLayout('first'), root })

describe('projected workbench divider addresses', () => {
  it('keeps a temporary wrapper divider out of the durable split tree', () => {
    const original = split(leaf('first'), leaf('second'), 'vertical', 0.4)
    const projected = split(original, leaf('unplaced'))
    const before = JSON.stringify(original)

    expect(workbenchProjectionSplitPath(original, projected)).toBeNull()
    expect(JSON.stringify(original)).toBe(before)
  })

  it('resolves a real divider inside a temporary wrapper to the original root', () => {
    const original = split(leaf('first'), leaf('second'), 'vertical', 0.4)
    const wrapped = split(leaf('unplaced'), original)
    const path = workbenchProjectionSplitPath(original, wrapped.second as Split)

    expect(path).toBe('')
    expect(setSplitRatio(layout(original), path!, 0.7).root).toEqual({ ...original, ratio: 0.7 })
    expect(original.ratio).toBe(0.4)
  })

  it('finds the original nested address after pruning promotes its divider', () => {
    const retained = split(leaf('first'), leaf('second'), 'vertical', 0.4)
    const original = split(leaf('other-object'), split(retained, leaf('third'), 'horizontal', 0.6))
    const projected = structuredClone(retained)
    const path = workbenchProjectionSplitPath(original, projected)

    expect(path).toBe('second.first')
    const next = setSplitRatio(layout(original), path!, 0.7).root as Split
    expect(next.ratio).toBe(original.ratio)
    expect((next.second as Split).ratio).toBe(0.6)
    expect(((next.second as Split).first as Split).ratio).toBe(0.7)
    expect(original.second).toEqual(split(retained, leaf('third'), 'horizontal', 0.6))
  })

  it('matches the same original sides when unrelated descendants are pruned', () => {
    const original = split(
      split(leaf('left-removed'), leaf('left-kept'), 'vertical'),
      split(leaf('right-kept'), leaf('right-removed'), 'vertical'),
      'horizontal', 0.3)

    expect(workbenchProjectionSplitPath(original, split(leaf('left-kept'), leaf('right-kept')))).toBe('')
  })

  it.each([
    ['reversed sides', split(leaf('second'), leaf('first'))],
    ['another axis', split(leaf('first'), leaf('second'), 'vertical')],
    ['unknown group', split(leaf('first'), leaf('unplaced'))],
    ['repeated projected group', split(split(leaf('first'), leaf('first')), leaf('second'))]
  ] as const)('does not authorize a durable address for %s', (_name, projected) => {
    const original = split(leaf('first'), leaf('second'))
    expect(workbenchProjectionSplitPath(original, projected)).toBeNull()
  })

  it('does not choose an address when a relevant original Group identity repeats', () => {
    const original = split(split(leaf('first'), leaf('second')), leaf('first'))
    expect(workbenchProjectionSplitPath(original, split(leaf('first'), leaf('second')))).toBeNull()
  })
})

describe('durable display Group confirmation', () => {
  it('confirms an empty original Group without treating a projected Group as durable', () => {
    const original = createWorkspaceLayout('first')
    expect(workbenchDisplayGroupMatches(original, 'first')).toBe(true)
    expect(workbenchDisplayGroupMatches(original, 'unplaced')).toBe(false)
    expect(workbenchDisplayGroupMatches(undefined, 'first')).toBe(false)
  })

  it('requires the same Group in both the original tree and Group records', () => {
    const original = createWorkspaceLayout('first')
    const orphan = createWorkspaceLayout('off-tree').groups[0]!
    expect(workbenchDisplayGroupMatches({ ...original, groups: [...original.groups, orphan] }, 'off-tree')).toBe(false)
    expect(workbenchDisplayGroupMatches({ ...original, root: leaf('missing-record') }, 'missing-record')).toBe(false)
  })
})
