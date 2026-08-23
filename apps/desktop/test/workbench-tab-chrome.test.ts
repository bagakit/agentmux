import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const renderer = new URL('../src/renderer/src/', import.meta.url).pathname
const workbench = readFileSync(`${renderer}components/WorkspaceWorkbench.tsx`, 'utf8')
const styles = readFileSync(`${renderer}styles/workbench.css`, 'utf8')

it('lets Session tabs own the first row when panes are parallel', () => {
  const splitNodeStart = workbench.indexOf('function SplitNode(')
  const splitBranchStart = workbench.indexOf('function SplitBranch(')
  expect(splitNodeStart).toBeGreaterThan(-1)
  expect(splitBranchStart).toBeGreaterThan(splitNodeStart)
  const splitTree = workbench.slice(splitNodeStart, splitBranchStart)
  expect(splitTree).toContain('showWindowChrome?: boolean')
  expect(splitTree).toContain('showWindowChrome={showWindowChrome}')
  expect(workbench).toContain('showWindowChrome={false}')
  expect(workbench).toContain('showWindowChrome={!rootIsLeaf}')
  expect(workbench).toContain('pane-tabbar--chrome-owner')
  expect(workbench).not.toContain('workbench-chromeline')
  expect(styles).toContain('.pane-tabbar--chrome-owner')
  expect(styles).not.toContain('.workbench-chromeline')
})
