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

it('the production Desktop copying block supplies Main hashing, avatars, Host and the native connection owner inside a standalone app', async () => {
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
  const functions = ['pathExists', 'materializeDependencies', 'materializeDependency'].map(name => {
    const declarations = source.statements.filter((statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name)
    expect(declarations, `Execute the actual packaging function ${name}`).toHaveLength(1)
    return declarations[0]!.getText(source)
  })
  const { resolvePackageRoot } = await import(pathToFileURL(join(repositoryRoot, 'scripts/package-dependencies.mjs')).href)
  // Execute every direct dependency copying statement unchanged, rather than manually
  // requesting hashes from the materializer. Removing the production call removes its output.
  const copying = new Function('readFile', 'mkdir', 'cp', 'readdir', 'join', 'dirname', 'lstat', 'realpath',
    'repositoryRoot', 'desktopRoot', 'coreRoot', 'connectorsRoot', 'resolvePackageRoot', functions.join('\n') +
    '\nreturn { materializeDependency, copyDependencies: async function(appResources) {\n' + copyingStatements.map(statement => statement.getText(source)).join('\n') + '\n} }')(
    readFile, mkdir, cp, readdir, join, dirname, lstat, realpath,
    repositoryRoot, join(repositoryRoot, 'apps/desktop'), join(repositoryRoot, 'packages/core'), join(repositoryRoot, 'packages/connectors'), resolvePackageRoot) as {
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
    const connectionSource = join(repositoryRoot, 'packages/connectors/src/connection-services.ts')
    const connectionImplementation = process.env.AGENTMUX_PACKAGE_CONNECTION_SOURCE ?? connectionSource
    const connectionEntry = join(temporary, 'connection-consumer.ts')
    // Exercise the maintained factory's real lease branch. Empty adapters and no
    // bindings keep external transport and conversation reads out of this fixture.
    await writeFile(connectionEntry, `
      import { createConnectionServices } from ${JSON.stringify(connectionSource)}
      import { createRequire, syncBuiltinESMExports } from 'node:module'
      import { spawnSync } from 'node:child_process'
      import { fileURLToPath } from 'node:url'
      import fs from 'node:fs'
      import { join } from 'node:path'
      const directory = process.argv[2], contender = process.argv[3] === 'contender'
      const loaderFailure = process.argv[3] === 'loader-failure', opened = []
      let sourceCalls = 0, owner
      const noSource = async () => { sourceCalls++; throw new Error('No external source exists in this private fixture') }
      const result = {}
      const originalOpen = fs.openSync
      if (loaderFailure) {
        fs.openSync = (path, ...args) => {
          const fd = originalOpen(path, ...args)
          if (path === join(directory, 'connections.owner.lock')) opened.push({ path, fd })
          return fd
        }
        syncBuiltinESMExports()
      }
      try {
        owner = await createConnectionServices({ directory, adapters: [], publication: {
          checkpoint: noSource, changes: noSource, inspect: noSource, observe: noSource, resource: noSource
        } })
        if (loaderFailure) {
          try { await owner.openDatabase() } catch (error) { result.storageError = { code: error.code, message: error.message } }
          result.failedDescriptors = opened.map(({ path, fd }) => {
            try { fs.fstatSync(fd); return { path, fd, state: 'open' } }
            catch (error) { return { path, fd, state: error.code } }
          })
          result.descriptorObservationPhase = 'after-failed-open-before-owner-close'
        } else {
          result.listed = await owner.connections.list()
          const database = await owner.openDatabase()
          result.databaseSame = database === owner.database
          result.databaseFile = database.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file
          if (!contender) {
            result.nativeResolution = createRequire(import.meta.url).resolve('fs-native-extensions')
            const compete = () => {
              const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), directory, 'contender'], {
                cwd: process.cwd(), encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH, NODE_PATH: '' }
              })
              return { status: child.status, signal: child.signal, error: child.error?.message,
                stdout: child.stdout, stderr: child.stderr }
            }
            result.whileHeld = compete()
            owner.close()
            result.afterRelease = compete()
          }
        }
      } catch (error) { result.error = { code: error.code, message: error.message } }
      finally {
        if (loaderFailure) { fs.openSync = originalOpen; syncBuiltinESMExports() }
        owner?.close()
      }
      result.sourceCalls = sourceCalls
      console.log(JSON.stringify(result))
    `)
    // electron-vite reads the package at process.cwd() when it creates its real
    // dependency/ESM plugins. Build in Desktop's ordinary cwd, not Vitest's root.
    const childEnvironment = { PATH: process.env.PATH, NODE_PATH: '' }
    evidence.hostBuild = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { resolveConfig } from ${JSON.stringify(pathToFileURL(desktopRequire.resolve('electron-vite')).href)}
      import { build } from ${JSON.stringify(pathToFileURL(desktopRequire.resolve('vite')).href)}
      import { readFile } from 'node:fs/promises'
      const { config } = await resolveConfig({ root: ${JSON.stringify(desktopRoot)}, configFile: ${JSON.stringify(configFile)} }, 'build', 'production')
      if (!config?.main) throw new Error('The production Main configuration is absent')
      const main = config.main
      const built = await build({ ...main, root: ${JSON.stringify(desktopRoot)}, configFile: false,
        plugins: [...main.plugins, ...(${JSON.stringify(connectionImplementation !== connectionSource)} ? [{ name: 'private-connection-source',
          enforce: 'pre', load: id => id === ${JSON.stringify(connectionSource)} ? readFile(${JSON.stringify(connectionImplementation)}, 'utf8') : null }] : [])],
        build: { ...main.build, outDir: ${JSON.stringify(mainDirectory)}, emptyOutDir: false,
          rollupOptions: { ...main.build?.rollupOptions, input: { 'agentmux-host': ${JSON.stringify(hostEntry)},
            'connection-consumer': ${JSON.stringify(connectionEntry)} } } } })
      const outputs = (Array.isArray(built) ? built : [built]).flatMap(result => result.output)
      const factory = outputs.filter(chunk => chunk.type === 'chunk' && Object.hasOwn(chunk.modules, ${JSON.stringify(connectionSource)}))
      console.log('connection_factory_outputs=' + JSON.stringify(factory.map(chunk => chunk.fileName)))
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
      const factoryOutputs = JSON.parse((evidence.hostBuild as string).split('\n')
        .find(line => line.startsWith('connection_factory_outputs='))!.slice('connection_factory_outputs='.length)) as string[]
      expect(factoryOutputs, 'Preserve the actual source factory identified by production Rollup module ownership').toHaveLength(1)
      const factoryFile = join(mainDirectory, factoryOutputs[0]!), factoryBytes = await readFile(factoryFile)
      const ownerArtifact = process.env.AGENTMUX_PACKAGE_HASHING_EVIDENCE + '.compiled-connection-owner.js'
      await writeFile(ownerArtifact, factoryBytes)
      evidence.compiledConnectionOwner = { original: factoryFile, sourceModule: connectionSource,
        artifact: ownerArtifact, sha256: digest(factoryBytes) }
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

    const connection = spawnSync(process.execPath, [join(mainDirectory, 'connection-consumer.js'), join(temporary, 'connection-owner')], {
      cwd: temporary, encoding: 'utf8', env: childEnvironment, timeout: 15_000
    })
    evidence.connection = { status: connection.status, signal: connection.signal, error: connection.error?.message,
      stdout: connection.stdout, stderr: connection.stderr, environmentKeys: Object.keys(childEnvironment),
      factorySource: { path: connectionImplementation, sha256: digest(await readFile(connectionImplementation)) } }
    expect(connection.error).toBeUndefined(); expect(connection.signal).toBeNull(); expect(connection.status).toBe(0)
    type ConnectionRead = { listed?: { connections: unknown[] }; databaseSame?: boolean; databaseFile?: string;
      error?: { code: string; message: string }; sourceCalls: number }
    type ChildRead = { status: number; signal: string | null; error?: string; stdout: string; stderr: string }
    const owner = JSON.parse(connection.stdout) as ConnectionRead & { nativeResolution: string; whileHeld: ChildRead; afterRelease: ChildRead }
    expect(owner.error, 'The production-config connection factory must open its real native lease and private SQLite storage').toBeUndefined()
    expect(owner.listed).toEqual({ connections: [] }); expect(owner.databaseSame).toBe(true)
    expect(owner.databaseFile).toBe(await realpath(join(temporary, 'connection-owner/connections.sqlite')))
    expect(owner.nativeResolution).toBe(join(canonicalAppResources, 'node_modules/fs-native-extensions/index.js'))
    expect(owner.sourceCalls).toBe(0)
    for (const child of [owner.whileHeld, owner.afterRelease]) {
      expect(child.error).toBeUndefined(); expect(child.signal).toBeNull(); expect(child.status).toBe(0)
    }
    const held = JSON.parse(owner.whileHeld.stdout) as ConnectionRead
    expect(held.error).toMatchObject({ code: 'CONNECTION_OWNER_BUSY' })
    expect(held.sourceCalls).toBe(0)
    const released = JSON.parse(owner.afterRelease.stdout) as ConnectionRead
    expect(released.error).toBeUndefined(); expect(released.listed).toEqual({ connections: [] })
    expect(released.databaseSame).toBe(true); expect(released.databaseFile).toBe(owner.databaseFile)
    expect(released.sourceCalls).toBe(0)

    // The missing module is real and local to this copied App. Observe the exact
    // fd returned to the original factory, before close() or child exit can help.
    await rm(join(appResources, 'node_modules/fs-native-extensions'), { recursive: true })
    const failureDirectory = join(temporary, 'connection-loader-failure')
    const loader = spawnSync(process.execPath, [join(mainDirectory, 'connection-consumer.js'), failureDirectory, 'loader-failure'], {
      cwd: temporary, encoding: 'utf8', env: childEnvironment, timeout: 5000
    })
    evidence.connectionLoaderFailure = { status: loader.status, signal: loader.signal, error: loader.error?.message,
      stdout: loader.stdout, stderr: loader.stderr, environmentKeys: Object.keys(childEnvironment) }
    expect(loader.error).toBeUndefined(); expect(loader.signal).toBeNull(); expect(loader.status).toBe(0)
    const failed = JSON.parse(loader.stdout) as { error?: unknown; storageError: { code: string };
      failedDescriptors: { path: string; fd: number; state: string }[]; descriptorObservationPhase: string; sourceCalls: number }
    expect(failed.error).toBeUndefined(); expect(failed.storageError).toMatchObject({ code: 'CONNECTION_STORAGE_UNAVAILABLE' })
    expect(failed.failedDescriptors.length).toBeGreaterThan(0)
    expect(failed.descriptorObservationPhase).toBe('after-failed-open-before-owner-close')
    for (const descriptor of failed.failedDescriptors) {
      expect(descriptor.path).toBe(join(failureDirectory, 'connections.owner.lock'))
      expect(descriptor.state, 'The exact native-load failure descriptor must already be closed before owner cleanup or process exit').toBe('EBADF')
    }
    expect(failed.sourceCalls).toBe(0)


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
