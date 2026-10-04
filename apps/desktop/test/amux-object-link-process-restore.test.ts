// @vitest-environment node
import { afterEach, beforeAll, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

type ProcessProof = {
  pid: number; raw: string; target: { kind: string; agentSessionId: string }; work: unknown
  tabs: Record<string, unknown>; layouts: Record<string, unknown>; drafts: Record<string, string>; sessions: unknown[]
  graph: unknown; requests: string[]; issues: string[]; lifecycleCalls: string[]
}
const directories: string[] = []
let worker: string
beforeAll(async () => {
  const directory = resolve('.tmp/amux-object-link-process')
  await mkdir(directory, { recursive: true })
  worker = join(directory, 'worker.mjs')
  const coreRequire = createRequire(resolve('packages/core/package.json'))
  const desktopRequire = createRequire(resolve('apps/desktop/package.json'))
  const { build } = coreRequire('esbuild') as typeof import('../../../packages/core/node_modules/esbuild/lib/main')
  await build({ entryPoints: [resolve('apps/desktop/test/fixtures/amux-object-link-process-worker.ts')],
    outfile: worker, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
    banner: { js: `import { createRequire as nodeCreateRequire } from 'node:module'; const require = nodeCreateRequire(${JSON.stringify(resolve('packages/core/package.json'))});` },
    plugins: [{ name: 'native-and-browser-runtime-boundaries', setup(build) {
      // File painting is a speculative dynamic import, never invoked by this
      // navigation-only startup. Keep it outside the Node worker bundle.
      build.onResolve({ filter: /\/components\/(FileSourceEditor|FileSurfaceView)$/ }, args => ({
        path: resolve(dirname(args.importer), args.path + '.tsx'), external: true
      }))
      // Keep Core's native-lock module at its published package location so its
      // own createRequire resolves the real native dependency.
      build.onResolve({ filter: /^@agentmux\/core\/spatial-state$/ }, () => ({ path: resolve('packages/core/dist/spatial-state.js'), external: true }))
      build.onResolve({ filter: /^(happy-dom|react(?:\/.*)?|react-dom(?:\/.*)?|fs-native-extensions)$/ }, args => ({
        path: (args.path === 'fs-native-extensions' ? coreRequire : desktopRequire).resolve(args.path), external: true
      }))
    } }]
  })
}, 30_000)
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

function launch(phase: 'save' | 'restore', spatial: string, storage: string): Promise<ProcessProof> {
  return new Promise((yes, no) => {
    const child = spawn(process.execPath, [worker, phase, spatial, storage], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = ''
    const timeout = setTimeout(() => { child.kill(); no(new Error('Navigation restore child timed out: ' + errors)) }, 20_000)
    child.stdout.on('data', chunk => output += chunk)
    child.stderr.on('data', chunk => errors += chunk)
    child.once('error', no)
    child.once('close', code => {
      clearTimeout(timeout)
      try { if (code !== 0) throw new Error(errors || output); yes(JSON.parse(output)) } catch (error) { no(error) }
    })
  })
}

it('keeps the exact linked Agent and original workface across two real processes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amux-object-link-process-')); directories.push(directory)
  const spatialPath = join(directory, 'spatial.json'), storagePath = join(directory, 'browser-storage.json')
  const saved = await launch('save', spatialPath, storagePath)
  const restored = await launch('restore', spatialPath, storagePath)
  expect(saved.pid).not.toBe(restored.pid)
  expect(saved.pid).not.toBe(process.pid)
  expect(restored.pid).not.toBe(process.pid)
  expect(saved.raw).toBe('amux://agent/' + encodeURIComponent(saved.target.agentSessionId))
  expect(saved.target.kind).toBe('agent')
  expect(saved.drafts).toEqual({ [saved.target.agentSessionId]: 'Unsent original draft' })
  expect(saved.tabs['work-tab']).toMatchObject({ regions: {
    'work-agent': { kind: 'agent', sessionId: saved.target.agentSessionId },
    'work-file': { kind: 'file', path: 'original.md' }
  } })
  expect(Object.keys(saved.layouts)).toEqual(expect.arrayContaining(['project', '__scratch__']))
  expect(saved.graph).toMatchObject({ tabs: expect.arrayContaining([expect.objectContaining({ tabId: 'work-tab' })]), regions: expect.arrayContaining([expect.objectContaining({ regionId: 'work-agent', agentSessionId: saved.target.agentSessionId })]) })
  expect(restored.requests).toEqual([])
  expect(saved.requests).toEqual(['space.ls', 'focus'])
  expect(saved.work).toMatchObject({ workspaceId: 'project', groupId: 'work-group', tabId: 'work-tab', regionId: 'work-agent' })
  expect(saved.issues.join(' ')).toContain('presentation: unknown') // DOM is intentionally unmounted.
  expect(restored.work).toEqual(saved.work)
  expect(restored.target).toEqual(saved.target)
  expect(restored.tabs).toEqual(saved.tabs)
  expect(restored.layouts).toEqual(saved.layouts)
  expect(restored.sessions).toEqual(saved.sessions)
  expect(restored.drafts).toEqual(saved.drafts)
  expect(restored.graph).toEqual(saved.graph)
  expect(saved.lifecycleCalls).toEqual([])
  expect(restored.lifecycleCalls).toEqual([])
}, 30_000)
