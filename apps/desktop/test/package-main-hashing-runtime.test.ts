import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { build } from 'vite'
import { expect, it } from 'vitest'

it('the production Desktop copying block supplies Main hashing, static avatars and the compiled Host inside a standalone app', async () => {
  const repositoryRoot = resolve(import.meta.dirname, '../../..')
  const scriptPath = process.env.AGENTMUX_PACKAGE_HASHING_SOURCE ?? join(repositoryRoot, 'apps/desktop/scripts/package-macos.mjs')
  const packageSource = await readFile(scriptPath, 'utf8')
  const source = ts.createSourceFile(scriptPath, packageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const copier = source.statements.filter((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'copyRuntimeApplication')
  expect(copier, 'Execute the one production App copying owner').toHaveLength(1)
  const copyingStatements = copier[0]!.body!.statements.filter(statement => {
    if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression)) return false
    const call = statement.expression.expression
    return ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === 'materializeDependency'
  })
  expect(copyingStatements.length, 'An empty production copying block cannot establish runtime closure').toBeGreaterThan(0)
  const functions = ['pathExists', 'materializeDependencies', 'materializeDependency', 'resolvePackageRoot'].map(name => {
    const declarations = source.statements.filter((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name)
    expect(declarations, `Execute the actual packaging function ${name}`).toHaveLength(1)
    return declarations[0]!.getText(source)
  })
  // Execute every direct dependency copying statement unchanged, rather than manually
  // requesting hashes from the materializer. Removing the production call removes its output.
  const copying = new Function('readFile', 'mkdir', 'cp', 'readdir', 'join', 'dirname', 'lstat', 'realpath',
    'repositoryRoot', 'desktopRoot', 'coreRoot', 'connectorsRoot', functions.join('\n') +
    '\nreturn { materializeDependency, copyDependencies: async function(appResources) {\n' + copyingStatements.map(statement => statement.getText(source)).join('\n') + '\n} }')(
    readFile, mkdir, cp, readdir, join, dirname, lstat, realpath,
    repositoryRoot, join(repositoryRoot, 'apps/desktop'), join(repositoryRoot, 'packages/core'), join(repositoryRoot, 'packages/connectors')) as {
      copyDependencies(appResources: string): Promise<void>
      materializeDependency(sourcePackage: string, name: string, destination: string): Promise<void>
    }
  const temporary = await mkdtemp(join(tmpdir(), 'agentmux-main-hashing-'))
  const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
  const evidence: Record<string, unknown> = { passed: false, temporary, scriptPath,
    packageSourceSha256: digest(packageSource), copyingStatementsSha256: digest(copyingStatements.map(statement => statement.getText(source)).join('\n')),
    recursiveHelpersSha256: digest(functions.join('\n')) }
  try {
    const appResources = join(temporary, 'AgentMux.app/Contents/Resources/app')
    await copying.copyDependencies(appResources)
    const mainDirectory = join(appResources, 'out/main')
    await mkdir(mainDirectory, { recursive: true })
    await writeFile(join(appResources, 'package.json'), JSON.stringify({ type: 'module' }))
    await writeFile(join(mainDirectory, 'hash-consumer.js'), `
      import { sha256 } from '@noble/hashes/sha2.js'
      import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
      console.log(JSON.stringify({ digest: bytesToHex(sha256(utf8ToBytes('abc'))),
        resolutions: ['@noble/hashes/sha2.js', '@noble/hashes/utils.js'].map(name => import.meta.resolve(name)) }))
    `)
    const output = execFileSync(process.execPath, [join(mainDirectory, 'hash-consumer.js')], {
      cwd: temporary, encoding: 'utf8', env: { PATH: process.env.PATH, NODE_PATH: '' }
    })
    const actual = JSON.parse(output) as { digest: string; resolutions: string[] }
    expect(actual.digest).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(actual.resolutions).toHaveLength(2)
    const canonicalAppResources = await realpath(appResources)
    expect(actual.resolutions).toEqual(['sha2.js', 'utils.js'].map(file =>
      pathToFileURL(join(canonicalAppResources, 'node_modules/@noble/hashes', file)).href))

    // Main's real avatar reader uses this shared serializer and the original face
    // drawing. Keep React external exactly as in Main, then execute Node SSR in
    // the standalone App so workspace modules cannot supply a missing runtime.
    const avatarEntry = join(temporary, 'avatar-consumer.ts')
    await writeFile(avatarEntry, `
      import { moteAvatarSvg } from ${JSON.stringify(join(repositoryRoot, 'packages/client-ui/src/lib/mote-avatar-svg.ts'))}
      import { DEFAULT_MOTE_FACE } from ${JSON.stringify(join(repositoryRoot, 'packages/client-ui/src/lib/mote-face.ts'))}
      console.log(JSON.stringify({
        face: moteAvatarSvg({ ...DEFAULT_MOTE_FACE, shape: 'diamond', palette: 'cocoa', eyes: 'wink' }),
        icon: moteAvatarSvg('flask'),
        browserGlobals: [typeof globalThis.window, typeof globalThis.document],
        resolutions: ['react', 'react/jsx-runtime', 'react-dom/server'].map(name => import.meta.resolve(name))
      }))
    `)
    await build({
      configFile: false,
      logLevel: 'silent',
      esbuild: { jsx: 'automatic' },
      build: {
        target: 'node22', outDir: mainDirectory, emptyOutDir: false, minify: false,
        lib: { entry: avatarEntry, formats: ['es'], fileName: () => 'avatar-consumer.js' },
        rollupOptions: { external: id => /^(?:react|react-dom)(?:\/|$)/.test(id) }
      }
    })
    const avatar = JSON.parse(execFileSync(process.execPath, [join(mainDirectory, 'avatar-consumer.js')], {
      cwd: temporary, encoding: 'utf8', env: { PATH: process.env.PATH, NODE_PATH: '' }
    })) as { face: string; icon: string; browserGlobals: string[]; resolutions: string[] }
    expect(avatar.browserGlobals).toEqual(['undefined', 'undefined'])
    for (const markup of [avatar.face, avatar.icon]) {
      expect(markup).toMatch(/^<svg\b/)
      expect(markup).toContain('viewBox=')
      expect(markup).toMatch(/<(?:path|rect|ellipse|circle)\b/)
      expect(markup).not.toMatch(/<(?:foreignObject|script|div)\b/)
    }
    expect(avatar.face).not.toBe(avatar.icon)
    expect(avatar.resolutions).toEqual(['react/index.js', 'react/jsx-runtime.js', 'react-dom/server.node.js'].map(file =>
      pathToFileURL(join(canonicalAppResources, 'node_modules', file)).href))

    // Core is an existing package owner. Its real recursive materializer supplies
    // compiled exports, the artifact contract and nested dependencies; no test
    // request supplies identity at the App root on behalf of the direct copier.
    const desktopRoot = join(repositoryRoot, 'apps/desktop'), coreRuntime = join(appResources, 'node_modules/@agentmux/core')
    await copying.materializeDependency(desktopRoot, '@agentmux/core', coreRuntime)
    const nestedIdentity = join(coreRuntime, 'node_modules/@agentmux/identity/dist/index.js')
    expect((await readFile(nestedIdentity)).length).toBeGreaterThan(0)

    const desktopRequire = createRequire(join(desktopRoot, 'package.json'))
    const configFile = join(desktopRoot, 'electron.vite.config.ts')
    const hostEntry = join(repositoryRoot, 'apps/host/src/index.ts')
    // electron-vite reads the package at process.cwd() when it creates its real
    // dependency/ESM plugins. Build in Desktop's ordinary cwd, not Vitest's root.
    const childEnvironment = { PATH: process.env.PATH, NODE_PATH: '' }
    evidence.hostBuild = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { resolveConfig } from ${JSON.stringify(pathToFileURL(desktopRequire.resolve('electron-vite')).href)}
      import { build } from ${JSON.stringify(pathToFileURL(desktopRequire.resolve('vite')).href)}
      const { config } = await resolveConfig({ root: ${JSON.stringify(desktopRoot)}, configFile: ${JSON.stringify(configFile)} }, 'build', 'production')
      if (!config?.main) throw new Error('The production Main configuration is absent')
      const main = config.main
      await build({ ...main, root: ${JSON.stringify(desktopRoot)}, configFile: false,
        build: { ...main.build, outDir: ${JSON.stringify(mainDirectory)}, emptyOutDir: false,
          rollupOptions: { ...main.build?.rollupOptions, input: { 'agentmux-host': ${JSON.stringify(hostEntry)} } } } })
    `], { cwd: desktopRoot, env: childEnvironment, encoding: 'utf8', timeout: 20_000 })
    const compiledHost = join(mainDirectory, 'agentmux-host.js'), compiled = await readFile(compiledHost, 'utf8')
    const compiledTree = ts.createSourceFile(compiledHost, compiled, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const compiledImports = compiledTree.statements.filter(ts.isImportDeclaration).map(statement =>
      ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null)
    expect(compiledImports).toContain('@agentmux/identity')
    expect(compiled).not.toContain(repositoryRoot)
    if (process.env.AGENTMUX_PACKAGE_HASHING_EVIDENCE) {
      const artifact = process.env.AGENTMUX_PACKAGE_HASHING_EVIDENCE + '.compiled-host.js'
      await writeFile(artifact, compiled)
      evidence.compiledHostArtifact = { path: artifact, sha256: digest(compiled), imports: compiledImports }
    }

    // A minimal environment cannot inherit the active Agent's Store, Hook or
    // endpoint. The unchanged entry rejects before shell hydration/Host startup.
    for (let directory = temporary; ; directory = dirname(directory)) {
      const inheritedModules = await lstat(join(directory, 'node_modules')).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return null
      })
      expect(inheritedModules, 'The standalone fixture has no ancestor node_modules').toBeNull()
      if (directory === dirname(directory)) break
    }
    const host = spawnSync(process.execPath, [compiledHost], { cwd: temporary, encoding: 'utf8', env: childEnvironment, timeout: 5000 })
    const files = [scriptPath, configFile, join(desktopRoot, 'package.json'), hostEntry, compiledHost, join(coreRuntime, 'package.json'),
      join(coreRuntime, 'dist/index.js'), join(coreRuntime, 'dist/object-id.js'), join(coreRuntime, 'src/ctxmux-artifact-contract.json'), nestedIdentity]
    evidence.host = { status: host.status, signal: host.signal, error: host.error?.message, stdout: host.stdout, stderr: host.stderr,
      environmentKeys: Object.keys(childEnvironment), sourcePins: Object.fromEntries(await Promise.all(files.map(async file => [file, digest(await readFile(file))]))) }
    expect(host.error).toBeUndefined(); expect(host.signal).toBeNull(); expect(host.status).toBe(1)
    expect(host.stderr, 'The production-config compiled Host must reach its original Store guard').toContain('The Host requires the original absolute Agent Session Store path.')
    expect(host.stderr).not.toContain('ERR_MODULE_NOT_FOUND'); expect(host.stdout).toBe('')

    const identityResolution = execFileSync(process.execPath, ['--input-type=module', '-e',
      "console.log(import.meta.resolve('@agentmux/identity'))"], { cwd: mainDirectory, encoding: 'utf8', env: childEnvironment }).trim()
    expect(identityResolution).toBe(pathToFileURL(join(canonicalAppResources, 'node_modules/@agentmux/identity/dist/index.js')).href)
    evidence.identity = { resolution: identityResolution, rootSha256: digest(await readFile(join(appResources, 'node_modules/@agentmux/identity/dist/index.js'))),
      nestedSha256: digest(await readFile(nestedIdentity)) }
    evidence.passed = true
  } finally {
    await rm(temporary, { recursive: true, force: true })
    evidence.cleanup = { removed: !(await lstat(temporary).catch(() => null)) }
    if (process.env.AGENTMUX_PACKAGE_HASHING_EVIDENCE) await writeFile(process.env.AGENTMUX_PACKAGE_HASHING_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n')
  }
}, 90_000)
