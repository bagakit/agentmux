import { browserSourceBuild } from '../../../packages/browser/scripts/source-build.mjs'
// @vitest-environment node
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { transformMoteLinkSource } from './mote-object-links-mutations.mjs'
import { dirname, join, resolve, relative } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

type ProcessProof = {
  launcherDrafts?:Record<string,{prompt:string}>;hydratedLauncherDrafts?:Record<string,{prompt:string}>;
  publicLink?: { runtimeId: string; target: unknown; resolved: unknown; alias: unknown; cli: unknown[]; focusRequests:any[]; addressReadOnly: boolean };
  pid: number; raw: string; target: { kind: string; agentSessionId?: string; spaceId?: string; eventId?: string }; work: unknown
  mote?: { spaceId: string; topicId: string; visible: boolean; page: string; eventId?: string; mainBody: boolean; threadBody: boolean }
  beforeReopen?: { work: unknown; visible: boolean; page: string }
  tabs: Record<string, unknown>; layouts: Record<string, unknown>; drafts: Record<string, string>; sessions: unknown[]
  graph: unknown; requests: string[]; issues: string[]; lifecycleCalls: string[]; continuityRequests?: { control: unknown }[]
}
const directories: string[] = []
let worker: string, buildDirectory: string
beforeAll(async () => {
  await mkdir(resolve('.tmp'), {recursive:true})
  const directory = buildDirectory = await mkdtemp(resolve('.tmp/mote-object-links-process-'))
  worker = join(directory, 'worker.mjs')
  const coreRequire = createRequire(resolve('packages/core/package.json'))
  const desktopRequire = createRequire(resolve('apps/desktop/package.json'))
  const candidates = ['apps/host', ...(await readdir(resolve('packages'))).map(name => 'packages/' + name)]
  const publicPackages = new Map<string, { directory: string; exports: Record<string, string | { import?: string; browser?: string }> }>()
  for (const path of candidates) {
    try { const manifest = JSON.parse(await readFile(resolve(path, 'package.json'), 'utf8')); if (manifest.name?.startsWith('@agentmux/')) publicPackages.set(manifest.name, { directory: resolve(path), exports: manifest.exports ?? {} }) }
    catch { /* This directory is not a package. */ }
  }
  const { build } = browserSourceBuild(coreRequire('esbuild')) as typeof import('../../../packages/core/node_modules/esbuild/lib/main')
  const consumed:Array<{file:string;sourceSHA256:string;loadedSHA256:string}>=[]
  const result=await build({ metafile:true,entryPoints: [resolve('apps/desktop/test/fixtures/amux-object-link-process-worker.ts')],
    outfile: worker, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', logLevel: 'silent',
    define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl', '.avif': 'dataurl', '.webp': 'dataurl', '.jpg': 'dataurl' },
    banner: { js: `import { createRequire as nodeCreateRequire } from 'node:module'; const require = nodeCreateRequire(${JSON.stringify(resolve('packages/core/package.json'))});` },
    plugins: [{name:'original-link-app-source',setup(build){build.onLoad({filter:/\.[cm]?[jt]sx?$/,namespace:'file'},async args=>{if(!args.path.startsWith(process.cwd()+'/')||args.path.includes('/node_modules/'))return null;const source=await readFile(args.path,'utf8'),file=relative(process.cwd(),args.path),loaded=transformMoteLinkSource(source,file,'process-browser-build');const sha=(value:string)=>createHash('sha256').update(value).digest('hex');consumed.push({file,sourceSHA256:sha(source),loadedSHA256:sha(loaded)});return{contents:loaded,loader:args.path.endsWith('.tsx')?'tsx':args.path.endsWith('.ts')?'ts':'js',resolveDir:dirname(args.path)}})}},{ name: 'native-and-browser-runtime-boundaries', setup(build) {
      build.onResolve({ filter: /(?:^|\/)monaco$/ }, () => ({ path: 'monaco-paint', namespace: 'isolated-editor-worker' }))
      build.onLoad({ filter: /.*/, namespace: 'isolated-editor-worker' }, () => ({ contents: 'export {}', loader: 'js' }))
      build.onResolve({ filter: /(?:^|\/)(TerminalView|ActivityView|FileSourceEditor|FileSurfaceView)$/ }, args => ({ path: args.path.split('/').at(-1)!, namespace: 'isolated-native-paint' }))
      build.onLoad({ filter: /.*/, namespace: 'isolated-native-paint' }, args => ({ contents: `import {createElement} from 'react';
        export const ${args.path}=props=>createElement('div', {'data-native-paint-boundary':${JSON.stringify(args.path)}, ...(props.sessionId ? {'data-activity-session':props.sessionId} : props.session ? {'data-terminal-session':props.session.id} : {})});
        export const Ruler=()=>null;`, loader: 'js', resolveDir: resolve('apps/desktop') }))
      // File painting is a speculative dynamic import, never invoked by this
      // navigation-only startup. Keep it outside the Node worker bundle.
      build.onResolve({ filter: /\/components\/(FileSourceEditor|FileSurfaceView)$/ }, args => ({
        path: resolve(dirname(args.importer), args.path + '.tsx'), external: true
      }))
      // Keep Core's native-lock module at its published package location so its
      // own createRequire resolves the real native dependency.
      // Core includes standalone helper entrypoints and native createRequire owners.
      // Keep its current compiled modules at their original package URLs instead of
      // collapsing import.meta.url onto this browser worker's entrypoint.
      build.onResolve({ filter: /^@agentmux\/core(?:\/.*)?$/ }, args => {
        const entry = args.path === '@agentmux/core' ? '.' : '.' + args.path.slice('@agentmux/core'.length)
        const value = publicPackages.get('@agentmux/core')!.exports[entry]
        const target = typeof value === 'string' ? value : value?.import
        if (!target) throw new Error('Missing current Core import export: ' + entry)
        return { path: resolve('packages/core', target.replace('./dist/', './src/').replace(/\.js$/, '.ts')), external: true }
      })
      build.onResolve({ filter: /^@agentmux\// }, async args => {
        const match = /^(@agentmux\/[^/]+)(?:\/(.*))?$/.exec(args.path)
        const found = match && publicPackages.get(match[1]!)
        if (!found) return null
        const entry = match![2] ? './' + match![2] : '.'
        const exact = found.exports[entry]
        const wildcard = exact === undefined ? Object.entries(found.exports).sort(([a], [b]) => b.length - a.length).find(([key]) => key.includes('*') && entry.startsWith(key.slice(0, key.indexOf('*'))) && entry.endsWith(key.slice(key.indexOf('*') + 1))) : undefined
        const value = exact ?? wildcard?.[1]
        let target = typeof value === 'string' ? value : value?.browser ?? value?.import
        if (!target) return null
        if (wildcard) { const [before, after] = wildcard[0].split('*'); target = target.replace('*', entry.slice(before!.length, after ? -after.length : undefined)) }
        if (args.path === '@agentmux/identity/runtime-source') return { path: resolve(found.directory, target) }
        if (args.path === '@agentmux/identity/runtime') return { path: resolve(found.directory, 'src/runtime-entry.ts') }
        const source = target.replace('./dist/src/', './src/').replace('./dist/', './src/').replace(/\.js$/, '.ts')
        for (const candidate of [source, source.replace(/\.ts$/, '.tsx')]) {
          try { await readFile(resolve(found.directory, candidate)); return { path: resolve(found.directory, candidate) } } catch { /* Try this exact export's TSX source. */ }
        }
        throw new Error('Current source missing for public export: ' + args.path)
      })
      build.onResolve({ filter: /^jsonc-parser$/ }, args => ({ path: createRequire(args.importer).resolve(args.path), external: true }))
      build.onResolve({ filter: /^(happy-dom|react(?:\/.*)?|react-dom(?:\/.*)?|fs-native-extensions)$/ }, args => ({
        path: (args.path === 'fs-native-extensions' ? coreRequire : desktopRequire).resolve(args.path), external: true
      }))
    } }]
  })
  if(process.env.MOTE_LINK_EVIDENCE){await mkdir(process.env.MOTE_LINK_EVIDENCE,{recursive:true});await writeFile(join(process.env.MOTE_LINK_EVIDENCE,'process-source.json'),JSON.stringify({consumed,metafile:result.metafile,workerSHA256:createHash('sha256').update(await readFile(worker)).digest('hex')},null,2))}
}, 30_000)
afterEach(async () => {
  const removed = []
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
    removed.push({ directory, removed: await access(directory).then(() => false, error => {
      if (error.code === 'ENOENT') return true
      throw error
    }) })
  }
  if (!process.env.MOTE_LINK_EVIDENCE) return
  const file = join(process.env.MOTE_LINK_EVIDENCE, 'two-process.json')
  try {
    const proof = JSON.parse(await readFile(file, 'utf8'))
    if (removed.length && proof.saved && proof.restored) {
      proof.cleanup = { directories: removed, processes: [proof.saved.pid, proof.restored.pid].map(pid => {
        try { process.kill(pid, 0); return { pid, alive: true } }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return { pid, alive: false }
          throw error
        }
      }) }
    }
    await writeFile(file, JSON.stringify(proof, null, 2))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
})
afterAll(async()=>{if(buildDirectory)await rm(buildDirectory,{recursive:true,force:true})})

function launch(phase: 'save' | 'restore', spatial: string, storage: string, mode = 'agent'): Promise<ProcessProof> {
  return new Promise((yes, no) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
    const privateRoot = dirname(spatial)
    const child = spawn(process.execPath, ['--experimental-transform-types', '--import', resolve('apps/desktop/test/mote-object-links-node-loader.mjs'), worker, phase, spatial, storage, mode], { env: { ...clean, AGENTMUX_STATE_DIRECTORY: privateRoot, AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot, 'runtime'), AGENTMUX_AGENT_SESSION_STORE: join(privateRoot, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(privateRoot, 'messages.ndjson') }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = '', timeoutError: Error | undefined
    const timeout = setTimeout(() => { timeoutError = new Error('Navigation restore child timed out: ' + errors); child.kill('SIGKILL') }, 40_000)
    child.stdout.on('data', chunk => output += chunk)
    child.stderr.on('data', chunk => errors += chunk)
    child.once('error', no)
    child.once('close', code => {
      clearTimeout(timeout)
      try { if (timeoutError) throw timeoutError; if (code !== 0) throw new Error('Child exit ' + code + ': ' + (errors || output)); yes(JSON.parse(output)) } catch (error) { no(error) }
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
  for (const proof of [saved, restored]) for (const observed of proof.continuityRequests ?? [])
    expect(proof.sessions.some(session => JSON.stringify((session as { control: unknown }).control) === JSON.stringify(observed.control))).toBe(true)
  expect(saved.lifecycleCalls).toEqual([])
  expect(restored.lifecycleCalls).toEqual([])
}, 30_000)


it.each(['mote-main', 'mote-thread'])('retains the original %s identity and workface across two independent processes with actual App presentation', async mode => {
  const directory = await mkdtemp(join(tmpdir(), 'amux-mote-link-process-')); directories.push(directory)
  const spatialPath = join(directory, 'spatial.json'), storagePath = join(directory, 'browser-storage.json')
  const saved = await launch('save', spatialPath, storagePath, mode)
  const restored = await launch('restore', spatialPath, storagePath, mode)
  await mkdir(resolve('.local/state/mote-link-chat-review'), { recursive: true })
  await writeFile(resolve('.local/state/mote-link-chat-review/process-' + mode + '.json'), JSON.stringify({ saved, restored }, null, 2))
  expect(new Set([process.pid, saved.pid, restored.pid]).size).toBe(3)
  expect(saved.target).toMatchObject({ kind: 'mote', spaceId: expect.any(String) })
  expect(saved.raw).toBe('amux://mote/' + encodeURIComponent(saved.target.spaceId!) + (mode === 'mote-thread' ? '/thread/' + encodeURIComponent(saved.target.eventId!) : ''))
  expect(saved.mote).toMatchObject({ spaceId: saved.target.spaceId, topicId: 'launcher:leader', visible: true,
    page: mode === 'mote-main' ? 'discussion' : 'threads' })
  expect(restored.target).toEqual(saved.target)
  expect(restored.work).toEqual(saved.work)
  expect(restored.tabs).toEqual(saved.tabs)
  expect(restored.layouts).toEqual(saved.layouts)
  expect(restored.sessions).toEqual(saved.sessions)
  expect(restored.drafts).toEqual(saved.drafts)
  expect(restored.graph).toEqual(saved.graph)
  expect(restored.mote).toMatchObject({ spaceId: saved.target.spaceId, topicId: saved.mote!.topicId, visible: true,
    page: mode === 'mote-main' ? 'discussion' : 'threads' })
  expect(restored.drafts).toMatchObject({ 'default-agent': 'Unsent Mote main draft', 'neighbor-agent': 'Unsent Mote member draft' })
  expect(saved.requests).toEqual(['focus'])
  if (mode === 'mote-main') {
    expect(restored.requests).toEqual([])
    expect(restored.mote!.mainBody).toBe(true)
  } else {
    // Mote pages are transient and return to Discussion by contract. An explicit
    // new URI navigation after restart opens the same original event, with no input replay.
    expect(restored.beforeReopen).toMatchObject({ work: saved.work, visible: true, page: 'discussion' })
    expect(restored.requests).toEqual(['focus'])
    expect(saved.mote!.eventId).toBe(saved.target.eventId)
    expect(restored.mote!.eventId).toBe(saved.target.eventId)
    expect(saved.mote!.threadBody).toBe(true)
    expect(restored.mote!.threadBody).toBe(true)
  }
  for (const proof of [saved, restored]) {
    expect(proof.continuityRequests?.length).toBeGreaterThan(0)
    for (const observed of proof.continuityRequests ?? []) expect(proof.sessions.some(session => JSON.stringify((session as { control: unknown }).control) === JSON.stringify(observed.control))).toBe(true)
  }
  expect(saved.lifecycleCalls).toEqual([])
  expect(restored.lifecycleCalls).toEqual([])
}, 45_000)

it('reopens the same opaque address through actual public CLI in two owner processes without reseeding the workface or drafts',async()=>{
 const directory=await mkdtemp(join(process.platform==='darwin'?'/tmp':tmpdir(),'mote-public-links-'));directories.push(directory)
 const spatial=join(directory,'spatial.json'),storage=join(directory,'browser-storage.json')
 const saved=await launch('save',spatial,storage,'mote-public'),restored=await launch('restore',spatial,storage,'mote-public')
 expect(new Set([process.pid,saved.pid,restored.pid]).size).toBe(3)
 expect(saved.raw).toMatch(/^amux:\/\/mote\/[1-9A-HJ-NP-Za-km-z]{12}\?runtime=OriginalPrivateRuntime$/u)
 expect(saved.raw).not.toContain('%2F');expect(saved.raw).not.toContain('retained-original-work-event')
 expect(restored.raw).toBe(saved.raw);expect(restored.publicLink?.resolved).toMatchObject({address:(saved.publicLink?.resolved as any).address,target:(saved.publicLink?.resolved as any).target})
 expect(restored.publicLink?.addressReadOnly).toBe(true)
 expect(saved.publicLink?.cli).toHaveLength(3);expect(restored.publicLink?.cli).toHaveLength(2)
 expect(saved.requests).toEqual([]);expect(restored.requests).toEqual([])
 for(const proof of [saved,restored]){expect(proof.publicLink?.focusRequests).toHaveLength(2);for(const request of proof.publicLink!.focusRequests)expect(request).toMatchObject({operation:'focus',target:{kind:'mote',spaceId:(proof.publicLink!.target as any).spaceId}})}
 expect(restored.beforeReopen).toMatchObject({work:saved.work,visible:true,page:'discussion'})
 expect(restored.work).toEqual(saved.work);expect(restored.tabs).toEqual(saved.tabs);expect(restored.layouts).toEqual(saved.layouts)
 expect(restored.drafts).toEqual(saved.drafts);expect(restored.drafts).toMatchObject({'default-agent':'Unsent Mote main draft','neighbor-agent':'Unsent Mote member draft'})
 expect(restored.launcherDrafts).toEqual(saved.launcherDrafts);expect(restored.hydratedLauncherDrafts).toEqual(saved.launcherDrafts);expect(Object.values(saved.launcherDrafts??{}).some(x=>x.prompt.startsWith('Original Mote unsent '))).toBe(true)
 expect(restored.sessions).toEqual(saved.sessions);expect(restored.graph).toEqual(saved.graph)
 for(const p of [saved,restored]){expect(p.lifecycleCalls).toEqual([]);expect(p.mote).toMatchObject({visible:true,page:'discussion',mainBody:true,composer:{present:true,visible:true,text:expect.stringContaining('Original Mote unsent ')}});expect(p.issues).toEqual([])}
 if(process.env.MOTE_LINK_EVIDENCE){await mkdir(process.env.MOTE_LINK_EVIDENCE,{recursive:true});await writeFile(join(process.env.MOTE_LINK_EVIDENCE,'two-process.json'),JSON.stringify({saved,restored},null,2))}
},90000)
