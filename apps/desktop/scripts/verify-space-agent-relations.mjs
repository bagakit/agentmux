import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { browserSourceBuild } from '../../../packages/browser/scripts/source-build.mjs'
import { runProbeProcess } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const evidence = process.env.AGENTMUX_RELATIONS_EVIDENCE ?? join(root, '.tmp/space-agent-relations', crypto.randomUUID())
await mkdir(evidence, { recursive: true })
const privateRoot = await mkdtemp(join(tmpdir(), 'amux-space-relations-')), fixture = join(desktop, 'scripts/fixtures/space-agent-list-management')
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), inputs = new Map()
const require = createRequire(join(desktop, 'package.json')), { build } = browserSourceBuild(createRequire(require.resolve('vite/package.json'))('esbuild'))
const receipt = { passed: false, captureOnly: true, independentAestheticReview: 'pending', userRunsControlled: false, phases: [], frames: [], transformations: [] }
try {
  const out = join(privateRoot, 'out'); await mkdir(out)
  await build({ entryPoints: [join(fixture, 'entry.tsx')], outfile: join(out, 'app.js'), bundle: true, platform: 'browser', conditions: ['browser', 'production'], format: 'esm', target: 'es2022', jsx: 'automatic', logLevel: 'silent',
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, loader: { '.png':'file','.avif':'file','.webp':'file','.gif':'file','.svg':'file','.woff2':'file','.woff':'file','.ttf':'file' },
    plugins: [{ name: 'actual-source-and-unrelated-paint-boundary', setup(builder) {
      builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
        if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return
        const source = await readFile(path, 'utf8'); inputs.set(relative(root, path), hash(source))
        const component = path.slice(path.lastIndexOf('/') + 1)
        if (['TerminalView.tsx','EditorPane.tsx','GitBranchDiffPane.tsx','FileSurfaceView.tsx','FileSourceEditor.tsx','PdfReader.tsx','ExcalidrawFilePreview.tsx','GitDiffCanvas.tsx','ToolkitScriptEditor.tsx'].includes(component)) {
          receipt.transformations.push({ component, boundary: 'Unrelated native terminal/editor paint only; original Dock, shared cards, Store, spatial and persistence consumers remain loaded.' })
          return { contents: `export function ${component.slice(0,-4)}(){return null}`, loader: 'js' }
        }
        return { contents: source, loader: path.endsWith('tsx') ? 'tsx' : path.endsWith('ts') ? 'ts' : 'js' }
      })
      builder.onLoad({ filter: /\.css$/ }, async ({ path }) => { const source = await readFile(path,'utf8'); inputs.set(relative(root,path),hash(source)); return { contents: source, loader:'css' } })
    } }] })
  for (const file of ['SurfaceToolDock.tsx','WorkspaceAgentRow.tsx','FocusContextRow.tsx','workspace-agent-arrangement.ts','workspace-agent-order.ts','workspace-agent-relations.ts','store.ts'])
    assert.ok([...inputs.keys()].some(path => path.endsWith('/'+file)), 'Actual production consumer: ' + file)
  const html = join(out,'index.html')
  await writeFile(html,'<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="./app.css"><style>html,body,#root{width:100%;height:100%;margin:0;overflow:hidden}</style><div id="root"></div><div data-overlay-host></div><script type="module" src="./app.js"></script></html>')
  const env = { ...process.env, AGENTMUX_DESKTOP_USER_DATA:join(privateRoot,'profile'), AGENTMUX_RUNTIME_DIRECTORY:join(privateRoot,'runtime'), AGENTMUX_STATE_DIRECTORY:join(privateRoot,'state') }; delete env.ELECTRON_RUN_AS_NODE
  for (const phase of ['seed','restore']) {
    const process = await runProbeProcess(require('electron'),[join(fixture,'relations-main.cjs'),html,privateRoot,evidence,phase],{ env, cwd:root, timeoutMs:90000, label:'space-agent-relations-'+phase })
    const result = JSON.parse(await readFile(join(evidence,`relations-${phase}.json`),'utf8'))
    receipt.phases.push({ ...process, result }); receipt.frames.push(...result.frames)
    assert.equal(result.passed,true,JSON.stringify(result.failure))
  }
  assert.notEqual(receipt.phases[0].result.pid,receipt.phases[1].result.pid)
  receipt.inputs = Object.fromEntries(inputs)
  for (const [path, sha] of inputs) assert.equal(hash(await readFile(join(root,path))),sha,'Candidate unchanged: '+path)
  receipt.compiled = { renderer:hash(await readFile(join(out,'app.js'))),css:hash(await readFile(join(out,'app.css'))) }; receipt.passed=true
} catch(error) { receipt.failure={message:error.message,stack:error.stack}; process.exitCode=1 }
finally { await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)); await rm(privateRoot,{recursive:true,force:true}); console.log(JSON.stringify({passed:receipt.passed,evidence,failure:receipt.failure?.message})) }
