import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, resolve, relative } from 'node:path'
import { expect, it } from 'vitest'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '../src/renderer/src')
const retired = ['components/WorkspaceBoard.tsx', 'components/BoardDiscussionCanvas.tsx', 'components/FanOutStrip.tsx', 'hooks/useBoardRows.ts', 'lib/board-run-card.ts', 'lib/fanout-group.ts', 'styles/board.css']

it('the production Renderer reaches the current Goals and Session workfaces with no retired Board imports', () => {
  const visited = new Set<string>(), pending = [resolve(root, 'main.tsx')]
  while (pending.length) {
    const file = pending.pop()!
    if (visited.has(file)) continue
    visited.add(file)
    if (!/\.[jt]sx?$/u.test(file)) continue
    for (const imported of ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles) {
      const specifier = imported.fileName.split('?')[0]!
      if (!specifier.startsWith('.')) continue
      const target = resolve(dirname(file), specifier)
      if (!target.startsWith(root + '/')) continue
      const stem = target.replace(/\.[cm]?jsx?$/u, '')
      const actual = [target, stem + '.ts', stem + '.tsx', target + '.ts', target + '.tsx', resolve(target, 'index.ts'), resolve(target, 'index.tsx')]
        .find(candidate => existsSync(candidate) && Boolean(extname(candidate)))
      expect(actual, `Unresolved Renderer import ${relative(root, file)} → ${specifier}`).toBeDefined()
      pending.push(actual!)
    }
  }
  const files = [...visited].map(file => relative(root, file))
  expect(files).toEqual(expect.arrayContaining(['App.tsx', 'components/GlobalBoardSurface.tsx', 'components/WorkspaceWorkbench.tsx', 'components/SessionRegionHost.tsx']))
  expect(retired.filter(file => existsSync(resolve(root, file)))).toEqual([])
  expect(readFileSync(resolve(root, 'store.ts'), 'utf8')).not.toContain('launchBoardAgent')
})

it('the live Session host keeps its original layout rules in the stylesheet entry', () => {
  const css = readFileSync(resolve(root, 'styles/session-region-host.css'), 'utf8')
  expect(readFileSync(resolve(root, 'styles/index.css'), 'utf8')).toContain("@import './session-region-host.css';")
  expect(css).toContain('.session-region-host { min-width: 0; min-height: 0; width: 100%; height: 100%; }')
  expect(css).toContain('.session-region-host--columns { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); }')
  expect(css).toContain('.session-region-host--grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }')
  expect(css).toContain('.session-region-host--balanced { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }')
  expect(css).toContain('.workbench-session-region-host > .agent-surface { width: 100%; height: 100%; }')
})
