import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, statfs, symlink, writeFile } from 'node:fs/promises'
import { join, resolve, relative, dirname } from 'node:path'

const hash = value => createHash('sha256').update(value).digest('hex')
export const publicHarnessPaths = ['owner.ts', 'entry.mjs', 'main.cjs', 'probe.mjs', 'index.html'].map(name => 'apps/desktop/scripts/fixtures/mote-directory-short-public/' + name)
publicHarnessPaths.push('apps/desktop/scripts/verify-mote-directory-short-public.mjs')
export async function probePublishedPublic({ repository, evidence, mainRef } = {}) {
  const repositoryRoot = resolve(repository ?? new URL('../../../../..', import.meta.url).pathname)
  const dependencyRoot = dirname(resolve(repositoryRoot, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repositoryRoot, encoding: 'utf8' }).trim()))
  mainRef ??= execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: repositoryRoot, encoding: 'utf8' }).trim()
  evidence = resolve(evidence ?? join(repositoryRoot, '.tmp/mote-directory-short-public', 'attempt-' + globalThis.crypto.randomUUID()))
  await mkdir(evidence, { recursive: true })
  const disk = await statfs(evidence); assert.ok(disk.bavail * disk.bsize > 120 * 1024 * 1024, 'Private exact Source proof needs 120 MiB free; no daemon has started')
  const privateRoot = await realpath(await mkdtemp(_hygiene_fixturePath("tmp/amp-"))), source = join(privateRoot, 'source'), fixture = join(source, 'apps/desktop/scripts/fixtures/mote-directory-short-public')
  const receipt = { schema: 'agentmux.directory.published-public-join.v1', passed: false, sourcePinnedMain: mainRef, source: {}, harnessSource: {},
    phases: [], compiledImports: {}, actualIpcStatements: null, userRunTouched: false, limitations: [
      'Two private Electron Hosts use the original App/preload/API/Store, original public ControlServer/bridge, RuntimeController and Core/ctxmux owners.',
      'A repository native Codex protocol fixture is used; no actual model or user Agent configuration is qualified.',
      'The native fixture has no Codex app-server history reader; the original Core reader reports unavailable. Transcript history and terminal continuous-reading quality are not qualified.',
      'Unrelated Browser, schedule, provider discovery and optional shell prewarming are excluded private ports. Their readiness is not claimed.',
      'Source compilation is private and bounded; no package, installation, user App/Run, or Root Working/index write.' ] }
  const exits = new WeakMap(); let daemon, daemonStderr = '', stopped = false, built = false
  const stopChild = async child => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const exited = exits.get(child) ?? once(child, 'exit'); child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000); try { await exited } finally { clearTimeout(timer) }
  }
  let env, coreBundle, artifact, processProbe
  let compilation = 'manifest'
  try {
    await mkdir(source)
    const platform = `${process.platform}-${process.arch}`
    execFileSync('tar', ['-x', '-C', source], { input: execFileSync('git', ['archive', mainRef,
      'tsconfig.base.json', 'packages/core/src', 'packages/core/package.json', 'packages/core/bin', `packages/core/vendor/ctxmux/${platform}`,
      'packages/core/test/fixtures/fake-codex-cli.mjs', 'apps/desktop/src', 'apps/desktop/package.json',
      'apps/desktop/test/helpers/client-ui-render.tsx', 'apps/desktop/scripts/probe-process.mjs', 'apps/desktop/resources',
      'apps/desktop/native/workspace-move.c', 'apps/desktop/scripts/migrate-topic-directories.mjs',
      'packages/demand', 'packages/layout', 'packages/client-ui', 'packages/relay'], { cwd: repositoryRoot, maxBuffer: 70 * 1024 * 1024 }) })
    for (const file of publicHarnessPaths) {
      const bytes = await readFile(join(repositoryRoot, file)); receipt.harnessSource[file] = hash(bytes)
      await mkdir(dirname(join(source, file)), { recursive: true }); await cp(join(repositoryRoot, file), join(source, file))
    }
    for (const name of ['node_modules', 'apps/desktop/node_modules', 'packages/core/node_modules', 'packages/relay/node_modules', 'packages/demand/node_modules', 'packages/layout/node_modules', 'packages/client-ui/node_modules']) {
      const available = await realpath(join(repositoryRoot, name)).catch(error => { if (error.code !== 'ENOENT') throw error; return realpath(join(dependencyRoot, name)) })
      await mkdir(dirname(join(source, name)), { recursive: true }); await symlink(available, join(source, name))
    }
    await writeFile(join(source, 'package.json'), '{"type":"module"}\n')
    const require = createRequire(join(repositoryRoot, 'apps/desktop/package.json')), esbuild = createRequire(require.resolve('vite'))('esbuild'), ts = require('typescript')
    const aliases = []
    for (const name of ['core', 'demand', 'layout', 'relay', 'client-ui']) {
      const root = join(source, 'packages', name), manifestFile = join(root, 'package.json'), manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
      receipt.source[relative(source, manifestFile)] = hash(await readFile(manifestFile))
      for (const [key, value] of Object.entries(manifest.exports).sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length)) {
        const target = typeof value === 'string' ? value : name === 'client-ui' ? value.browser : value.import
        if (!target || target.endsWith('.json')) continue
        const file = name === 'client-ui' ? target : target.replace('./dist/', name === 'core' || name === 'relay' ? './src/' : './').replace(/\.js$/, '.ts')
        const spec = '@agentmux/' + name + (key === '.' ? '' : key.slice(1)), expression = spec.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.+)')
        aliases.push({ find: new RegExp('^' + expression + '$'), replacement: resolve(root, file).replace('*', '$1') })
      }
    }
    const bind = async file => {
      if (file.startsWith(source + '/') && !file.includes('/node_modules/') && !file.includes('/vendor/')) {
        const logical = relative(source, file), sha256 = hash(await readFile(file)); receipt.source[logical] = sha256
        ;(receipt.compiledImports[compilation] ??= {})[logical] = sha256
      }
    }
    const helper = join(privateRoot, 'workspace-move'); execFileSync('cc', ['-O2', join(source, 'apps/desktop/native/workspace-move.c'), '-o', helper])
    receipt.helper = { source: 'apps/desktop/native/workspace-move.c', sourceSha256: hash(await readFile(join(source, 'apps/desktop/native/workspace-move.c'))), binarySha256: hash(await readFile(helper)) }
    receipt.source[receipt.helper.source] = receipt.helper.sourceSha256
    const plugin = { name: 'pinned-public-owner-source', setup(builder) {
      builder.onResolve({ filter: /^@agentmux\// }, args => { const alias = aliases.find(one => one.find.test(args.path)); return alias ? { path: args.path.replace(alias.find, alias.replacement) } : null })
      builder.onLoad({ filter: /\.(ts|tsx|mjs|js|json)$/ }, async args => {
        await bind(args.path)
        if (args.path.endsWith('/scratch-directory-identity.mjs') || args.path.endsWith('/scratch-directory-maintenance.mjs')) {
          const text = await readFile(args.path, 'utf8'), anchor = "const defaultHelper = resolve(import.meta.dirname, '../../resources/bin/agentmux-workspace-move')"
          assert.equal(text.split(anchor).length, 2)
          return { contents: text.replace(anchor, 'const defaultHelper = process.env.DIRECTORY_PUBLIC_HELPER'), loader: 'js' }
        }
        return null
      })
    } }
    const options = { bundle: true, format: 'esm', platform: 'node', external: ['electron', '@ctxmux/sdk', 'fs-native-extensions'], plugins: [plugin], logLevel: 'error',
      banner: { js: "import { createRequire as privateRequire } from 'node:module'; const require=privateRequire(import.meta.url);" } }
    const owner = join(source, 'packages/core/dist/public-owner.mjs'), cli = join(source, 'packages/core/dist/agentmux.js'), preload = join(privateRoot, 'preload.cjs')
    coreBundle = join(source, 'packages/core/dist/public-core.mjs'); await mkdir(dirname(owner), { recursive: true })
    compilation = 'mainOwner'; await esbuild.build({ ...options, entryPoints: [join(fixture, 'owner.ts')], outfile: owner })
    compilation = 'coreCleanup'; await esbuild.build({ ...options, entryPoints: [join(source, 'packages/core/src/index.ts')], outfile: coreBundle })
    compilation = 'sourceCLI'; await esbuild.build({ ...options, entryPoints: [join(source, 'packages/core/src/agentmux.ts')], outfile: cli })
    compilation = 'preload'; await esbuild.build({ bundle: true, format: 'cjs', platform: 'node', external: ['electron'], plugins: [plugin], logLevel: 'error', entryPoints: [join(source, 'apps/desktop/src/preload/index.ts')], outfile: preload })
    compilation = 'actualIpcStatements'; const ipcFile = join(source, 'apps/desktop/src/main/ipc.ts'), ipcSource = await readFile(ipcFile, 'utf8'); await bind(ipcFile)
    const parsed = ts.createSourceFile(ipcFile, ipcSource, ts.ScriptTarget.Latest, true), statements = [], found = []
    const channels = ['scratch:listTopics', 'scratch:readTopic', 'scratch:ensureMote', 'spatial:read', 'spatial:commit', 'spatial:retainLabels',
      'files:readPublic', 'files:readDirectory', 'files:read', 'files:readPreview', 'sessions:snapshot', 'sessions:launchAgent',
      'sessions:creation', 'sessions:historySources', 'sessions:historyPage', 'notebook:read', 'sessions:attach', 'sessions:replay', 'sessions:refreshAttachment', 'sessions:detach',
      'sessions:write', 'sessions:resize', 'sessions:recover', 'ui:requestStorageFlush', 'executors:detect']
    function visit(node) {
      if (ts.isVariableStatement(node) && node.declarationList.declarations.some(one => one.name.getText(parsed) === 'publicFiles')) statements.push(node.getText(parsed))
      if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && ['handle', 'handleWithEvent'].includes(node.expression.expression.getText(parsed)) &&
        node.expression.arguments[0] && ts.isStringLiteral(node.expression.arguments[0]) && channels.includes(node.expression.arguments[0].text)) {
        statements.push(node.getText(parsed)); found.push(node.expression.arguments[0].text)
      }
      ts.forEachChild(node, visit)
    }
    visit(parsed); assert.deepEqual([...found].sort(), [...channels].sort()); assert.equal(statements.length, channels.length + 1)
    const handlers = join(privateRoot, 'actual-ipc-handlers.cjs'), content = ts.transpileModule(statements.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    await writeFile(handlers, 'module.exports=ports=>{const {handle,handleWithEvent,args,config,configOwner,workspace,spatialState,files,FileReadOwner,spatialCatalog,requireTrustedSender,app,sessionSnapshotPayload,configWithRuntimeBindings,sessionInputWriteResult,assertManualPromptSenderTrusted,observeWorkbenchStorageAuthority,requireWorkbenchStorageAuthority,pauseUserProgress,notebookStore,refreshSettingsExecutor}=ports;\n' + content + '\nreturn{publicFiles}}')
    receipt.actualIpcStatements = { source: relative(source, ipcFile), sha256: hash(ipcSource), channels, compiledStatementsSha256: hash(content) }
    const { build: viteBuild } = await import(require.resolve('vite'))
    const out = join(privateRoot, 'renderer')
    compilation = 'renderer'; await viteBuild({ configFile: false, root: fixture, base: './', logLevel: 'error', resolve: { alias: aliases }, esbuild: { jsx: 'automatic' },
      define: { __AGENTMUX_WEB_PREVIEW__: 'false', 'process.env.NODE_ENV': '"production"' },
      plugins: [{ name: 'actual-published-renderer-source', enforce: 'pre', async load(id) { await bind(id.split('?')[0]); return null } }],
      build: { target: 'esnext', outDir: out, emptyOutDir: true, minify: false } })
    const nativeCli = join(privateRoot, 'native-observer.mjs'), originalCli = join(source, 'packages/core/test/fixtures/fake-codex-cli.mjs')
    const nativeCode = `import {statSync,readFileSync,writeFileSync,openSync,mkdirSync} from 'node:fs';\nimport{join}from'node:path';import{pathToFileURL}from'node:url';\nconst records=join(process.env.DIRECTORY_PUBLIC_PRIVATE_ROOT,'native-records');mkdirSync(records,{recursive:true});const record=join(records,'rollout-original.jsonl');writeFileSync(record,JSON.stringify({type:'session_meta',payload:{id:'native-'+process.env.AGENTMUX_AGENT_SESSION_ID,source:'cli',cwd:process.cwd()}})+'\\n');const nativeWitness=openSync(record,'r');\nprocess.stdin.on('data',bytes=>{const object=statSync('.',{bigint:true});process.stdout.write('DIRECTORY_PUBLIC_CWD:'+JSON.stringify({pid:process.pid,input:bytes.toString('utf8'),cwd:process.cwd(),object:{dev:String(object.dev),ino:String(object.ino)},note:readFileSync('note.md','utf8'),oldAliasNote:readFileSync(process.env.DIRECTORY_PUBLIC_ORIGINAL_ALIAS+'/note.md','utf8')})+'\\n')});\nawait import(pathToFileURL(${JSON.stringify(originalCli)}).href);\n`
    await writeFile(nativeCli, nativeCode); receipt.generated = { nativeObserverSha256: hash(nativeCode), originalCliSha256: hash(await readFile(originalCli)) }
    receipt.source[relative(source, originalCli)] = receipt.generated.originalCliSha256
    for (const directory of ['runtime', 'state/ctxmux', 'home']) await mkdir(join(privateRoot, directory), { recursive: true, mode: 0o700 })
    env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_'))),
      HOME: join(privateRoot, 'home'), AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(privateRoot, 'state'),
      AGENTMUX_AGENT_SESSION_STORE: join(privateRoot, 'state/sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(privateRoot, 'state/messages.ndjson'),
      DIRECTORY_PUBLIC_PRIVATE_ROOT: privateRoot, DIRECTORY_PUBLIC_HELPER: helper }
    delete env.ELECTRON_RUN_AS_NODE
    artifact = join(source, 'packages/core/vendor/ctxmux', platform, 'bin/ctxmuxd'); receipt.artifact = { file: relative(source, artifact), sha256: hash(await readFile(artifact)) }
    daemon = spawn(artifact, ['--socket', join(privateRoot, 'runtime/ctxmux.sock'), '--state-dir', join(privateRoot, 'state/ctxmux'), '--readiness-fd', '3'], { env, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
    exits.set(daemon, once(daemon, 'exit')); daemon.stderr.on('data', bytes => daemonStderr += bytes)
    await new Promise((yes, no) => { const timer = setTimeout(() => no(Error('Original private daemon readiness timed out: ' + daemonStderr)), 20000)
      daemon.stdio[3].once('data', () => { clearTimeout(timer); yes() }); daemon.once('error', error => { clearTimeout(timer); no(error) }) })
    receipt.daemonPid = daemon.pid; built = true
    processProbe = await import(join(source, 'apps/desktop/scripts/probe-process.mjs')); const { runProbeProcess, listProbeProcesses } = processProbe
    compilation = 'driver'
    await bind(join(source, 'apps/desktop/scripts/probe-process.mjs'))
    for (const phase of ['seed', 'restore']) {
      const phaseRoot = join(privateRoot, 'hosts', phase); await mkdir(phaseRoot, { recursive: true }); await cp(join(fixture, 'main.cjs'), join(phaseRoot, 'main.cjs'))
      const lines = [], exit = await runProbeProcess(require('electron'), [join(phaseRoot, 'main.cjs'), join(out, 'index.html'), privateRoot, phase, evidence, owner, preload, process.execPath, cli, handlers],
        { temporaryRoot: phaseRoot, cwd: source, env, timeoutMs: 90000, onLine: line => lines.push(line) })
      await writeFile(join(evidence, phase + '.log'), lines.join('\n'))
      const app = JSON.parse(await readFile(join(evidence, phase + '.json'), 'utf8')); receipt.phases.push({ phase, exit, app })
      const errors = app.renderer?.setup?.errors ?? []
      for (const [index,error] of errors.entries()) { const hit = /file:\/\/(.+?):(\d+):(\d+)/.exec(error); if (hit?.[1]?.startsWith(out + '/')) { const lines = (await readFile(hit[1], 'utf8')).split('\n'); await writeFile(join(evidence,phase+'-renderer-error-'+index+'.txt'), lines.slice(Number(hit[2])-4, Number(hit[2])+3).join('\n')) } }
      assert.equal(exit.timedOut, false); assert.equal(exit.exitCode, 0, app.error?.message); assert.equal(app.passed, true)
      if (phase === 'restore') stopped = app.exactPrivateRunStopped === true
    }
    assert.equal(new Set(receipt.phases.map(phase => phase.app.pid)).size, 2)
    assert.ok(Object.keys(receipt.source).length > 100, 'Actual Main/Core/preload/Renderer/CLI Source cannot be empty')
    receipt.remainingProcessesBeforeDaemonStop = await listProbeProcesses(-1, privateRoot)
    receipt.harnessChanges = []
    for (const [file, sha] of Object.entries(receipt.harnessSource)) if (hash(await readFile(join(repositoryRoot, file))) !== sha) receipt.harnessChanges.push(file)
    assert.deepEqual(receipt.harnessChanges, [])
    receipt.passed = true
  } catch (error) { receipt.error = { message: error.message, stack: error.stack } }
  finally {
    const errors = []
    if (!stopped && built && daemon?.exitCode === null) {
      try {
        const cleanup = `import{AgentMuxFileAgentSessionStore,loadAgentSessions,startHeadlessAgentMux,defaultAgentMuxControlSocketPath}from${JSON.stringify(coreBundle)};const store=new AgentMuxFileAgentSessionStore(${JSON.stringify(join(privateRoot, 'state/sessions.json'))});const saved=await loadAgentSessions(store),host=await startHeadlessAgentMux({store,stateDirectory:${JSON.stringify(join(privateRoot, 'state'))},socketPath:defaultAgentMuxControlSocketPath()});try{for(const one of saved){if(!one.workspacePath.startsWith(${JSON.stringify(privateRoot + '/')}))throw Error('Foreign Session in private cleanup Store');const status=await host.client.statusAgent(one.agentSessionId);if(status.run.state==='running')await host.client.stopAgent(one.agentSessionId,one.run)}}finally{await host.stop()}console.log(JSON.stringify({stopped:saved.map(one=>one.agentSessionId)}));`
        const child = spawn(process.execPath, ['--input-type=module', '--eval', cleanup], { env, stdio: ['ignore', 'pipe', 'pipe'] }); exits.set(child, once(child, 'exit'))
        let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b)
        const timer = setTimeout(() => child.kill('SIGKILL'), 20000), [code, signal] = await exits.get(child); clearTimeout(timer)
        await writeFile(join(evidence, 'cleanup-core.log'), stdout + stderr); assert.equal(code, 0, stdout + stderr); assert.equal(signal, null); stopped = true
      } catch (error) { errors.push('Exact private Core cleanup: ' + error.message) }
    }
    try { await stopChild(daemon); if (processProbe) { receipt.remainingOwnedProcesses = await processProbe.listProbeProcesses(-1, privateRoot); assert.deepEqual(receipt.remainingOwnedProcesses, [], 'Only the private proof processes may remain in cleanup scope') } } catch (error) { errors.push('Private daemon stop: ' + error.message) }
    await writeFile(join(evidence, 'daemon.stderr.log'), daemonStderr)
    receipt.cleanup = { errors, exactPrivateRunsStopped: stopped, daemonExitCode: daemon?.exitCode ?? null, daemonSignal: daemon?.signalCode ?? null, privateRootRemoved: false }
    if (!errors.length) { await rm(privateRoot, { recursive: true, force: true }); receipt.cleanup.privateRootRemoved = true }
    if (errors.length) receipt.passed = false
    for (const [file, sha] of Object.entries(receipt.harnessSource)) receipt.source[file] = sha
    receipt.sourceOrigins = Object.fromEntries(Object.keys(receipt.source).map(file => [file, file in receipt.harnessSource ? 'candidate-harness' : mainRef]))
    await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify({ passed: receipt.passed, sourcePinnedMain: mainRef, evidence, error: receipt.error, cleanup: receipt.cleanup }))
  }
  assert.equal(receipt.passed, true, receipt.error?.message ?? receipt.cleanup.errors.join('\n'))
  return receipt
}
