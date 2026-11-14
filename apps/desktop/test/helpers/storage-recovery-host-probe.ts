import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
// Capture the evidence destination before the fixture strips every Runtime env.
const sourceProof = process.env.AGENTMUX_SOURCE_EXPORT_LOADED

/** A real second Host-side process consumes the current adapter/SDK, never shipping dist. */
export async function runDesktopStorageHostProbe(directory: string, socket: string, restoreMembers?: import('@agentmux/core').RecoveryRestoreMember[]) {
  const { build, transform } = createRequire(resolve('packages/core/package.json'))('esbuild') as typeof import('esbuild')
  const shim = join(directory, 'source-core.mjs'), worker = join(directory, 'host-source.mjs'), output = join(directory, 'host-cut')
  await mkdir(output)
  await writeFile(shim, `export {snapshotRecoveryFile,hashRecoveryFile} from ${JSON.stringify(resolve('packages/core/src/storage-recovery.ts'))};export {AgentMuxError} from ${JSON.stringify(resolve('packages/core/src/errors.ts'))};export {mintObjectId} from ${JSON.stringify(resolve('packages/core/src/object-id.ts'))};`)
  const input = restoreMembers ? join(directory, 'restore-members.json') : undefined
  if (input) await writeFile(input, JSON.stringify(restoreMembers), { mode: 0o600 })
  await build({ stdin: { resolveDir: process.cwd(), contents: `
    import {readFile} from 'node:fs/promises';
    import {createDesktopStorageRecoverySource} from './apps/host/src/desktop-storage-recovery.ts';
    import {connectAgentMuxRpc} from './packages/core/src/public-rpc-client.ts';
    const source=createDesktopStorageRecoverySource(()=>connectAgentMuxRpc({endpoint:{transport:'unix',path:process.argv[2]}}));
    const result=process.argv[4]?await source.prepareRestore(JSON.parse(await readFile(process.argv[4],'utf8')),process.argv[3]):await source.capture(process.argv[3]);
    const outcomes=result.state==='prepared'?await Promise.all(result.members.map(m=>source.restoreMissing(m))):[];
    process.stdout.write(JSON.stringify({pid:process.pid,result,outcomes,bodies:await Promise.all((result.members??[]).map(m=>readFile(m.file,'utf8')))}));
  ` }, outfile: worker, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    alias: { '@agentmux/core': shim },
    plugins: [{ name: 'original-host-source-locations', setup(builder) { builder.onLoad({ filter: /\.tsx?$/ }, async args => {
      const original = await readFile(args.path, 'utf8')
      if (sourceProof && args.path.startsWith(process.cwd() + '/'))
        await appendFile(sourceProof, JSON.stringify({ path: args.path.slice(process.cwd().length + 1), absolutePath: args.path,
          sha256: createHash('sha256').update(original).digest('hex'), secondProcessSource: true }) + '\n', { mode: 0o600 })
      const compiled = await transform(original, { loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts', format: 'esm', target: 'node24', define: {
        'import.meta.url': JSON.stringify(pathToFileURL(args.path).href), 'import.meta.dirname': JSON.stringify(dirname(args.path)) } })
      return { contents: compiled.code, loader: 'js' }
    }) } }],
    banner: { js: `import {createRequire as hostProbeRequire} from 'node:module';const require=hostProbeRequire(${JSON.stringify(resolve('packages/core/package.json'))});` } })
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(AGENTMUX_|CTXMUX_)/u.test(name)))
  Object.assign(env, { AGENTMUX_STATE_DIRECTORY: join(directory, 'state'), AGENTMUX_RUNTIME_DIRECTORY: directory,
    AGENTMUX_MESSAGE_QUEUE_PATH: join(directory, 'messages.ndjson') })
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [worker, socket, output, ...(input ? [input] : [])], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 25_000)
    child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}
