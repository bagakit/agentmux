import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import ts from 'typescript'

const suite = process.env.VITEST ? await import('vitest') : await import('node:test')
const test = process.platform === 'darwin' && process.arch === 'arm64' ? suite.test : suite.test.skip
const exec = promisify(execFile)
const repo = resolve(import.meta.dirname, '../../..')
const desktop = join(repo, 'apps/desktop')
const entry = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).scripts
const installed = { shell: 'original', ctxmux: 'native' }
const changedShell = { shell: 'new', ctxmux: 'native' }
const changedNative = { shell: 'original', ctxmux: 'new' }

// Execute the command, route, source fence, build and installation dispatch together.
// Only external build, signing, bundle assembly and live installation use private stand-ins.
async function runUpdate({ command = 'update:local', argv = [], before = installed, after = changedShell, staged = false, drift = false }) {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-update-command-'))
  try {
    const checkout = join(root, 'checkout'), app = join(checkout, 'apps/desktop'), scripts = join(app, 'scripts')
    const home = join(root, 'home'), bundle = join(home, 'Applications/AgentMux.app/Contents')
    const bundleRelease = join(bundle, 'Resources/app/out/renderer/release.json')
    const profile = join(home, 'Library/Application Support/test.agentmux/renderer-updates')
    const env = { ...process.env, HOME: home, PATH: join(root, 'bin') + ':' + process.env.PATH }
    for (const path of [scripts, join(app, 'src/shared'), join(app, 'out/renderer'), dirname(bundleRelease), profile, join(root, 'bin')]) await mkdir(path, { recursive: true })
    for (const file of ['update-local.mjs', 'update-renderer.mjs', 'local-update-route.mjs', 'package-identity.mjs']) {
      await cp(join(desktop, 'scripts', file), join(scripts, file))
    }
    await cp(join(desktop, 'src/shared/update-policy.ts'), join(app, 'src/shared/update-policy.ts'))
    await symlink(join(desktop, 'node_modules'), join(app, 'node_modules'))
    const source = await readFile(join(desktop, 'scripts/package-macos.mjs'), 'utf8')
    const ast = ts.createSourceFile('package-macos.mjs', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
    const names = ['main', 'sourceIdentity', 'reportInstallTransaction', 'assert', 'writeProgress', 'reportPackageStage']
    const product = ast.statements.filter(s => ts.isFunctionDeclaration(s) && names.includes(s.name?.text))
    assert.equal(product.length, names.length)
    const flags = ast.statements.filter(s => ts.isVariableStatement(s) && ['installRequested','appOnly','installIntent'].includes(s.declarationList.declarations[0].name.getText(ast)))
    assert.equal(flags.length, 3)
    await writeFile(join(scripts, 'package-macos.mjs'), `
      import { execFileSync } from 'node:child_process'
      import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises'
      import { dirname, join, resolve } from 'node:path'
      const desktopRoot=resolve(import.meta.dirname,'..'), repositoryRoot=resolve(desktopRoot,'../..')
      const tmpdir=()=>${JSON.stringify(root)}, releaseRoot=join(desktopRoot,'release/mac')
      const PRODUCT_NAME='AgentMux', manifest={version:'fixture'}, outputApp=join(releaseRoot,'AgentMux.app')
      const noop=async()=>{}, brandApplication=app=>mkdir(app,{recursive:true}), sha256=async()=>'fixture'
      const inspectElectronApplication=async()=>({application:'private-electron'})
      const preflightMacosSigning=async({argv})=>{ console.log('sign_argv='+JSON.stringify(argv)); return {kind:'certificate'} }
      const signAndVerifyMacosApplication=async()=>({kind:'certificate'})
      const copyRuntimeApplication=noop, verifyIdentity=noop, verifyThirdPartyNotices=noop, auditBundle=noop
      const verifyWorkspaceMoveHelper=noop, verifyNativeDesktopCopy=noop, verifyNativeDesktopSigning=noop
      const verifyPackagedRuntime=noop, verifyLaunchServices=noop, preservePackageSmokeFailure=async()=>({directory:tmpdir()})
      const installApplication=async path=>{ if(path!==outputApp)throw Error('wrong App'); return {intent:installIntent,ui:{status:'fixture'},native:{status:'fixture'}} }
      async function run(command,args,options) {
        if(command==='git')return {stdout:execFileSync(command,args,{cwd:options.cwd,encoding:'utf8'})}
        if(command==='pnpm'){console.log('desktop_build='+JSON.stringify(args)); ${drift ? "await import('node:fs/promises').then(fs=>fs.writeFile(join(repositoryRoot,'changed'),'drift'))" : ''}; return}
        if(!['cp','xattr','du'].includes(command))throw Error('unexpected command '+command)
        return {stdout:'1'}
      }
      ${[...flags,...product].map(s=>s.getText(ast).replace(/^export /,'')).join('\n')}
      export { main as packageMacos, reportInstallTransaction }
    `)
    await writeFile(join(root, 'bin/pnpm'), '#!/bin/sh\necho outer_build="$*"\n', { mode: 0o755 })
    await writeFile(join(bundle, 'Info.plist'), '<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.agentmux</string></dict></plist>')
    if (before !== 'absent') await writeFile(bundleRelease, typeof before === 'string' ? before : JSON.stringify({ identity: before }))
    await writeFile(join(profile, 'active.json'), JSON.stringify({ current: 'fixture', previous: null }))
    await writeFile(join(app, 'out/renderer/release.json'), JSON.stringify({ id: 'fixture', identity: after }))
    await writeFile(join(checkout, '.gitignore'), 'node_modules\nout\nrelease\n')
    const git = args => exec('git', ['-C', checkout, ...args], { env })
    await git(['init','-q'])
    await git(['add','.'])
    await git(['-c','user.name=Fixture','-c','user.email=fixture@invalid','-c','commit.gpgSign=false','-c','core.hooksPath=/dev/null','commit','-qm','fixture'])
    if (staged) { await writeFile(join(checkout, 'staged'), 'uncommitted'); await git(['add','staged']) }
    try {
      const result = await exec('/bin/sh', ['-c', entry[command] + ' "$@"', 'update', ...argv], { cwd: checkout, env, timeout: 15000 })
      return { ...result, code: 0 }
    } catch (error) {
      return { stdout: error.stdout, stderr: error.stderr, code: error.code }
    }
  } finally { await rm(root, { recursive: true, force: true }) }
}

for (const [label, options, expectedIntent] of [
  ['shell changed', {}, 'full'],
  ['first loader adoption', { before: 'absent' }, 'full'],
  ['Native explicitly deferred', { after: changedNative, argv: ['--ui-only'] }, 'ui-only'],
  ['explicit App installation even with matching identities', { after: installed, argv: ['--ui-only'] }, 'ui-only']
]) {
  test(`local App update builds once and omits DMG work: ${label}`, async () => {
    const result = await runUpdate(options)
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stdout.match(/desktop_build=/g)?.length, 1)
    assert.match(result.stdout, /desktop_build=\["--config.enable-pre-post-scripts=true","build"\]/)
    assert.doesNotMatch(result.stdout, /outer_build=/)
    assert.match(result.stdout, /update_route=application/)
    assert.match(result.stdout, /sign_argv=.*"--install"/)
    assert.match(result.stdout, /dmg=not-requested/)
    const transaction = result.stdout.split('\n').find(line => line.startsWith('install_transaction='))
    assert.equal(JSON.parse(transaction.slice('install_transaction='.length)).intent, expectedIntent)
  })
}

for (const [label, options, reason] of [
  ['changed Runtime', { after: changedNative }, /--runtime-reviewed=/],
  ['unknown Runtime', { after: null }, /--runtime-reviewed=/],
  ['malformed release', { before: '{' }, /JSON/],
  ['uncommitted staged files', { staged: true }, /clean source tree/],
  ['source changed during build', { drift: true }, /Source tree changed/],
  ['only hot update authorized, shell changed', { command: 'update:renderer' }, /installation authorized.*--app-only/],
  ['only hot update authorized, Runtime changed', { command: 'update:renderer', after: changedNative }, /--runtime-reviewed=/]
]) {
  test(`update rejects before activation or installation: ${label}`, async () => {
    const result = await runUpdate(options)
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, reason)
    assert.doesNotMatch(result.stdout, /install_transaction=|frontend_update_requested=/)
    if (options.command === 'update:renderer') {
      assert.equal(result.stdout.match(/outer_build=/g)?.length, 1)
      assert.doesNotMatch(result.stdout, /desktop_build=|sign_argv=/)
    }
  })
}

test('a matching local update reaches the frontend loader without signing or requiring a clean checkout', async () => {
  const result = await runUpdate({ after: installed, staged: true })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /update_route=renderer/)
  assert.match(result.stdout, /frontend_already_active=true/)
  assert.doesNotMatch(result.stdout, /sign_argv=|install_transaction=/)
})
