import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'

const root = resolve(import.meta.dirname, '../../../../..')
const owner = `${root}/apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx`
export default defineConfig({
  ...original,
  root,
  plugins: [...(original.plugins ?? []), {
    name: 'actual-app-workspace-source-observation',
    enforce: 'pre',
    transform(source, id) {
      const file = id.split('?')[0]!
      if (!file.startsWith(`${root}/apps/desktop/src/renderer/src/`) || !/\.[cm]?[jt]sx?$/u.test(file)) return
      let code = source
      if (file === owner) {
        // The Profiler lives inside the actual returned tree. An App-created wrapper outside
        // a memo boundary would itself update and could falsely label a bailed-out child.
        const anchor = '  return workbench\n}'
        assert.equal(source.split(anchor).length - 1, 1, 'One actual Workspace returned-tree anchor')
        const renderAnchor = '  const workbenchRef = useRef<HTMLDivElement>(null)'
        assert.equal(source.split(renderAnchor).length - 1, 1, 'One actual Workspace render anchor')
        code = `import { Profiler as SourceWorkspaceProfiler } from 'react'\n` + source.replace(renderAnchor,
          `  globalThis.__agentmuxSourceWorkspaceRender?.(workspaceId)\n${renderAnchor}`).replace(anchor,
          `  return <SourceWorkspaceProfiler id={workspaceId} onRender={(id, phase) =>
    globalThis.__agentmuxSourceWorkspaceCommit?.(id, phase, { visible, interactiveResize, viewTargets, projection })}>{workbench}</SourceWorkspaceProfiler>\n}`)
      }
      if (file === `${root}/apps/desktop/src/renderer/src/lib/surface-memory-budget-coordinator.tsx`) {
        const anchor = '  return (\n    <SurfaceMemoryBudgetContext.Provider value={previousState.current}>'
        assert.equal(source.split(anchor).length - 1, 1, 'One actual Surface budget Provider anchor')
        code = source.replace(anchor, '  globalThis.__agentmuxSourceSurfaceBudget?.(previousState.current)\n' + anchor)
      }
      if (process.env.AGENTMUX_APP_LOADED_SOURCE) appendFileSync(process.env.AGENTMUX_APP_LOADED_SOURCE,
        JSON.stringify({ path: relative(root, file), originalSHA256: createHash('sha256').update(source).digest('hex'),
          observedSHA256: createHash('sha256').update(code).digest('hex'), bytes: Buffer.byteLength(code),
          observationOnly: code !== source }) + '\n')
      if (code !== source) return { code, map: null }
    }
  }],
  test: { ...original.test,
    include: ['apps/desktop/scripts/fixtures/browser-app-workspace-cost/app-workspace-cost.fixture.tsx'],
    exclude: [...(original.test?.exclude ?? []), '**/.local/**'],
    fileParallelism: false, passWithNoTests: false }
})
