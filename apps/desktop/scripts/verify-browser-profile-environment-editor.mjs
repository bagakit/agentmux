import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, symlink } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build as buildRenderer } from 'vite'
import { browserSourceBuild } from '../../../packages/browser/scripts/source-build.mjs'
import { runProbeProcess, stopProbeProcesses, listProbeProcesses } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'),
  desktop = join(root, 'apps/desktop'),
  require = createRequire(join(desktop, 'package.json'))
const { build } = browserSourceBuild(createRequire(require.resolve('vite/package.json'))('esbuild'))
const electron = require('electron'),
  sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const fixture = join(desktop, 'scripts/fixtures/browser-profile-environment'),
  textDrafts = process.argv.includes('--text-drafts'),
  outRoot = join(root, textDrafts ? '.local/browser-profile-text-drafts/native' : '.local/browser-profile-editor/native')
await mkdir(outRoot, { recursive: true })
const out = await mkdtemp(join(outRoot, 'attempt-'))
const report = {
  schema: textDrafts ? 'agentmux.profile-text-drafts.native.v1' : 'agentmux.profile-environment-editor.native.v1',
  passed: false,
  out,
  sources: {},
  runs: [],
  boundary:
    'Private Electron, production Browser Profiles settings/Editor, shipping API and full original preload, original trusted IPC registration and Profile/Workbench document owners, native Browser and public compiled CLI. No installed app or user data.',
  dependency: {
    executable: await realpath(electron),
    sha256: sha(await readFile(electron)),
    version: require('electron/package.json').version
  }
}
const pageServer = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html')
  response.end('<!doctype html><title>Private editor native page</title><input value="Original page input">')
})
await new Promise((done) => pageServer.listen(0, '127.0.0.1', done))
const url = `http://127.0.0.1:${pageServer.address().port}/`
const inputs = new Map(),
  homes = []
const source = async (file) => {
  if (file.startsWith(root + '/') && !file.includes('/node_modules/')) {
    const bytes = await readFile(file)
    inputs.set(file, sha(bytes))
    report.sources[relative(root, file)] = sha(bytes)
  }
}
for (const file of [
  'packages/core/dist/agentmux.js',
  'packages/core/src/agentmux-cli-commands.ts',
  'apps/desktop/src/main/ipc.ts',
  'apps/desktop/scripts/verify-browser-profile-environment-editor.mjs',
  ...(textDrafts ? ['apps/desktop/scripts/verify-browser-profile-editor-drafts.mjs'] : [])
])
  await source(join(root, file))
try {
  for (const name of textDrafts ? ['candidate', 'mutation'] : process.argv.includes('--mutations') ? ['mutation', 'restored'] : ['candidate']) {
    const compiled = join(out, name)
    await mkdir(compiled)
    const home = await mkdtemp('/tmp/amux-profile-editor-')
    homes.push(home)
    await symlink(join(desktop, 'node_modules'), join(compiled, 'node_modules'))
    let mutation
    const reused = process.argv.indexOf('--reuse-renderer')
    if (reused !== -1 && name !== 'mutation') {
      const original = resolve(process.argv[reused + 1]),
        raw = await readFile(join(original, 'receipt.json')),
        previous = JSON.parse(raw)
      const run = previous.runs.find((run) => run.name !== 'mutation')
      assert.ok(run, 'Reuse requires an observed original candidate compilation')
      // Only the private Main driver and this runner may differ. Every product,
      // shared/preload and Renderer input of the previous bundle must still match.
      for (const [file, digest] of Object.entries(previous.sources)) {
        if (
          file === 'apps/desktop/scripts/fixtures/browser-profile-environment/editor-main.ts' ||
          file === 'apps/desktop/scripts/verify-browser-profile-environment-editor.mjs'
        )
          continue
        const absolute = join(root, file)
        assert.equal(sha(await readFile(absolute)), digest, 'Renderer reuse input changed: ' + file)
        await source(absolute)
      }
      await symlink(join(original, run.name, 'renderer'), join(compiled, 'renderer'))
      report.rendererReuse = {
        receipt: join(original, 'receipt.json'),
        sha256: sha(raw),
        originalName: run.name
      }
    } else {
      await buildRenderer({
        configFile: false,
        root: fixture,
        base: './',
        logLevel: 'error',
        define: { __AGENTMUX_WEB_PREVIEW__: 'false' },
        worker: { format: 'es' },
        build: {
          outDir: join(compiled, 'renderer'),
          emptyOutDir: true,
          minify: false,
          sourcemap: false,
          rollupOptions: { input: join(fixture, 'editor.html') }
        },
        plugins: [
          {
            name: 'original-editor-inputs',
            async transform(code, file) {
              if (file.includes('?')) return
              await source(file)
              if (textDrafts && name === 'mutation' && file === join(desktop, 'src/renderer/src/lib/browser-profile-text-drafts.ts')) {
                const anchor = 'const local = profiles, merged = { ...original }'
                assert.equal(code.split(anchor).length - 1, 1)
                const changed = code.replace(anchor, 'const local = profiles, merged = {}')
                mutation = { file: relative(root, file), before: sha(code), after: sha(changed), behavior: 'Do not restore the original Desktop Profile text drafts on load' }
                return changed
              }
              if (
                !textDrafts && name === 'mutation' &&
                file === join(desktop, 'src/renderer/src/lib/browser-profile-environment-form.ts')
              ) {
                const anchor = 'timeZone: fields.timeZone.trim()'
                assert.equal(code.split(anchor).length - 1, 1)
                const changed = code.replace(anchor, "timeZone: 'UTC'")
                mutation = {
                  file: relative(root, file),
                  before: sha(code),
                  after: sha(changed),
                  behavior: 'Replace the actual GUI time-zone submission with UTC'
                }
                return changed
              }
            }
          }
        ]
      })
    }
    for (const [entry, outfile, format, external] of [
      [
        join(fixture, 'editor-main.ts'),
        join(compiled, 'main.mjs'),
        'esm',
        ['electron', '@agentmux/core', '@agentmux/core/*']
      ],
      [join(desktop, 'src/preload/index.ts'), join(compiled, 'preload.cjs'), 'cjs', ['electron']]
    ]) {
      await build({
        entryPoints: [entry],
        outfile,
        bundle: true,
        platform: format === 'cjs' ? 'browser' : 'node',
        format,
        target: 'node24',
        external,
        banner:
          format === 'esm'
            ? {
                js: "import{createRequire as __proofRequire}from'node:module';const require=__proofRequire(import.meta.url);"
              }
            : undefined,
        plugins: [
          {
            name: 'original-main-inputs',
            setup(bundler) {
              bundler.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
                await source(args.path)
                return undefined
              })
            }
          }
        ]
      })
    }
    assert.ok(inputs.has(join(desktop, 'src/renderer/src/components/settings/ProfileEnvironmentEditor.tsx')))
    assert.ok(
      inputs.has(join(desktop, 'src/renderer/src/components/settings/BrowserProfilesSettingsPane.tsx'))
    )
    assert.ok(inputs.has(join(desktop, 'src/main/browser-profile-editor-ipc.ts')))
    if (textDrafts) assert.ok(inputs.has(join(desktop, 'src/renderer/src/lib/browser-profile-text-drafts.ts')))
    const phases = textDrafts ? ['text-seed', 'text-restart', ...(name === 'mutation' ? [] : ['text-after-discard'])] :
      process.argv.includes('--draft-read-proof') ? ['read-failure'] : name === 'mutation' ? ['seed'] : ['seed', 'restart']
    for (const phase of phases) {
      const resultFile = join(compiled, phase + '.json'),
        bootstrap = join(home, phase + '-bootstrap.cjs')
      await writeFile(
        bootstrap,
        `const{app}=require('electron'),fs=require('node:fs'),path=require('node:path');const directory=${JSON.stringify(home)};for(const key of ['appData','userData','sessionData']){const p=path.join(directory,key);fs.mkdirSync(p,{recursive:true});app.setPath(key,p)}app.whenReady().then(()=>import(${JSON.stringify(pathToFileURL(join(compiled, 'main.mjs')).href)})).catch(e=>{console.error(e);app.exit(1)});`
      )
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'
        )
      )
      Object.assign(env, {
        AGENTMUX_RUNTIME_DIRECTORY: home,
        AGENTMUX_STATE_DIRECTORY: join(home, 'state'),
        AGENTMUX_AGENT_SESSION_STORE: join(home, 'sessions.json'),
        AGENTMUX_MESSAGE_QUEUE_PATH: join(home, 'messages.ndjson'),
        AGENTMUX_EDITOR_HOME: home,
        AGENTMUX_EDITOR_ROOT: root,
        AGENTMUX_EDITOR_OUTPUT: resultFile,
        AGENTMUX_EDITOR_COMPILED: compiled,
        AGENTMUX_EDITOR_PHASE: phase,
        AGENTMUX_EDITOR_URL: url,
        AGENTMUX_EDITOR_NODE: process.execPath
      })
      let original
      const logs = [],
        processResult = await runProbeProcess(electron, [bootstrap], {
          cwd: home,
          env,
          timeoutMs: 180_000,
          onSpawn: (_identity, child) => { original = child },
          onLine: (line) => {
            logs.push(line)
            console.log(`[${name}/${phase}] ${line}`)
            if (phase === 'text-seed' && line === 'profile_text_crash_ready') assert.equal(original.kill('SIGKILL'), true)
          }
        })
      await writeFile(join(compiled, phase + '.log'), logs.join('\n'))
      await stopProbeProcesses(processResult.originalPid, home)
      const remaining = await listProbeProcesses(processResult.originalPid, home)
      const actual = JSON.parse(await readFile(resultFile, 'utf8'))
      report.runs.push({
        name,
        phase,
        home,
        process: processResult,
        remaining,
        actual,
        ...(mutation ? { mutation } : {}),
        bundles: Object.fromEntries(
          await Promise.all(
            ['main.mjs', 'preload.cjs'].map(async (file) => [file, sha(await readFile(join(compiled, file)))])
          )
        )
      })
      await writeFile(join(out, 'receipt.json'), JSON.stringify(report, null, 2))
      assert.deepEqual(remaining, [])
      if (phase === 'text-seed') {
        assert.ok(logs.includes('profile_text_crash_ready'), actual.failure?.message)
        assert.equal(processResult.exitSignal, 'SIGKILL')
        assert.equal(actual.passed, true, actual.failure?.message)
      } else if (name === 'mutation') {
        assert.equal(actual.passed, false)
        assert.match(actual.failure?.message ?? '', textDrafts ? /Original conflicting draft/ : /Europe\/Paris/)
        assert.ok(mutation)
      } else {
        assert.equal(processResult.exitCode, 0, actual.failure?.message)
        assert.equal(actual.passed, true, actual.failure?.message)
      }
    }
  }
  report.sourceUnchanged = true
  for (const [file, digest] of inputs)
    assert.equal(sha(await readFile(file)), digest, 'Candidate source changed during proof: ' + file)
  report.passed = true
} finally {
  await new Promise((done) => pageServer.close(done))
  // Exact ended private paths only. Images, source identities, receipts and logs stay.
  report.cleanedHomes = []
  for (const home of homes) {
    await rm(home, { recursive: true, force: true })
    report.cleanedHomes.push(home)
  }
  await writeFile(join(out, 'receipt.json'), JSON.stringify(report, null, 2))
  console.log('Editor proof receipt: ' + join(out, 'receipt.json'))
}
