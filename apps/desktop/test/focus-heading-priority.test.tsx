// @vitest-environment happy-dom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { FocusProjectLanes } from '../src/renderer/src/components/FocusProjectLanes'
import type { FocusProjectLane } from '../src/renderer/src/lib/focus-project-lanes'
import type { FocusLaneOrigin } from '../src/renderer/src/lib/focus-lane-origin'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { runProbeProcess, stopProbeProcesses } from '../scripts/probe-process.mjs'

it('keeps identity, location, activity and status readable before a long optional description', async () => {
  const desktop = resolve(import.meta.dirname, '..')
  const require = createRequire(join(desktop, 'package.json'))
  const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
  const directory = await mkdtemp(join(tmpdir(), 'focus-heading-'))
  const kinds = ['project', 'topic', 'mote', 'survey'] as const
  const lanes: FocusProjectLane[] = kinds.map(kind => ({
    id: kind, workspaceId: kind, projectId: kind, projectWorkspaceId: null,
    name: '磁盘清理', labels: ['磁盘清理'], path: fixturePath(kind), hostId: 'local',
    topicId: kind === 'topic' || kind === 'mote' ? kind : null,
    ...(kind === 'topic' || kind === 'mote' ? { objectKind: kind } : {}),
    activeAgentIds: [kind], contextIds: [kind], recovery: null,
    lastActivityAt: Date.now(), summary: '定位磁盘占用与增长，保留原任务上下文和工作信息。'.repeat(30)
  }))
  const origins = new Map<string, FocusLaneOrigin>(kinds.map(kind => [kind, {
    kind, label: kind === 'project' ? 'Project' : kind === 'topic' ? 'Topic' : kind === 'mote' ? 'Mote' : 'Survey',
    locations: ['Engineering'], addresses: ['Engineering']
  }]))
  const html = renderToStaticMarkup(createElement(FocusProjectLanes, {
    lanes, origins, visible: false, selectedProjectKey: 'all', onSelect() {},
    renderLane: (_lane, heading) => <div className="focus-project-lanes__title">{heading}<span className="focus-project-lanes__status-rail"><span className="focus-context-group__header" data-visible-state="true">Results 1</span></span></div>
  }))
  let probePid: number | null = null
  try {
    await build({ entryPoints: [join(desktop, 'src/renderer/src/styles/index.css')], outfile: join(directory, 'styles.css'), bundle: true, logLevel: 'silent',
      loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.png': 'file', '.svg': 'file', '.gif': 'file' } })
    // Load the consumed stylesheet, so the regression assertion exercises Chromium flex sizing.
    await writeFile(join(directory, 'index.html'), `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><div class="global-focus-surface"><div class="global-focus-main">${html}</div></div>`)
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const processResult = await runProbeProcess(require('electron'), [join(desktop, 'scripts/fixtures/focus-heading-priority/main.cjs'), directory], {
      cwd: desktop, env, timeoutMs: 30_000
    })
    probePid = processResult.originalPid
    expect(processResult.exitCode).toBe(0)
    const scenes = JSON.parse(await readFile(join(directory, 'geometry.json'), 'utf8')) as Array<{
      width: number; rows: Array<{ kind: string; right: number; fields: Array<{ text: string; width: number; scroll: number; left: number; right: number }> }>
    }>
    expect(scenes.map(scene => scene.width)).toEqual([1440, 800, 500, 320])
    for (const scene of scenes) {
      expect(scene.rows.map(row => row.kind)).toEqual(kinds)
      for (const row of scene.rows) {
        expect(row.fields.some(field => field.text === '磁盘清理')).toBe(true)
        expect(row.fields.some(field => field.text === 'Active now')).toBe(true)
        expect(row.fields.some(field => field.text === 'Results 1')).toBe(true)
        for (const field of row.fields) {
          expect(field.width, `${scene.width}: ${field.text}`).toBeGreaterThan(0)
          expect(field.scroll, `${scene.width}: ${field.text} is clipped`).toBeLessThanOrEqual(field.width + 1)
          expect(field.left).toBeGreaterThanOrEqual(0)
          expect(field.right).toBeLessThanOrEqual(row.right + 1)
        }
      }
    }
  } finally {
    await stopProbeProcesses(probePid ?? -1, directory)
    await rm(directory, { recursive: true, force: true })
  }
}, 40_000)
