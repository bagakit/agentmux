import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { runInNewContext } from 'node:vm'

const exec = promisify(execFile)
const core = fileURLToPath(new URL('../', import.meta.url))
const repository = resolve(core, '../..')
const require = createRequire(join(core, 'package.json'))
const esbuild = require('esbuild')
const evidence = join(repository, 'docs/reviews/system-markdown-guides')
const receiptPath = join(evidence, 'verification.json')
const sha = value => createHash('sha256').update(value).digest('hex')
const ambientFree = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_') && key !== 'NODE_OPTIONS'))

async function files(root) {
  const result = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) result.push(...await files(path))
    else if (entry.isFile()) result.push(path)
  }
  return result.sort()
}

async function hashes(includeBuilt = true) {
  let built = []
  try { if (includeBuilt) built = await files(join(core, 'dist')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const inputs = [
    ...await files(join(core, 'src')),
    ...await files(join(core, 'guides')),
    ...['generate-guides.mjs', 'check-guides.mjs', 'build.mjs', 'clean-build.mjs', 'verify-system-guides.mjs']
      .map(path => join(core, 'scripts', path)),
    ...(includeBuilt ? await files(join(core, 'bin')) : []),
    ...built,
    join(core, 'package.json'), join(core, 'tsconfig.json'), join(core, 'tsconfig.build.json'),
    join(repository, 'tsconfig.base.json'),
    ...(includeBuilt ? [join(core, 'README.md')] : []),
    join(core, 'test/agentmux-guides-package.test.ts')
  ]
  return Object.fromEntries(await Promise.all(inputs.map(async path =>
    [relative(repository, path), sha(await readFile(path))])))
}

/** An isolated, nonbundled translation keeps the real source import graph and public consumers. */
async function transpileCore(destination, sourceCore = core) {
  await mkdir(join(destination, 'src'), { recursive: true })
  await cp(join(sourceCore, 'package.json'), join(destination, 'package.json'))
  await symlink(join(sourceCore, 'node_modules'), join(destination, 'node_modules'), 'dir')
  await symlink(join(sourceCore, 'vendor'), join(destination, 'vendor'), 'dir')
  for (const path of await files(join(sourceCore, 'src'))) {
    const output = join(destination, 'src', relative(join(sourceCore, 'src'), path))
    await mkdir(dirname(output), { recursive: true })
    if (path.endsWith('.ts') && !path.endsWith('.d.ts')) {
      const transformed = await esbuild.transform(await readFile(path, 'utf8'), {
        loader: 'ts', format: 'esm', target: 'node24', sourcefile: relative(repository, path)
      })
      await writeFile(output.replace(/\.ts$/u, '.js'), transformed.code)
    } else if (/\.(json|mjs)$/u.test(path)) await cp(path, output)
  }
  return join(destination, 'src')
}

async function capture(directory) {
  const load = file => import(pathToFileURL(join(directory, file + '.js')).href)
  const [modules, help, commands, outbound, messaging, goal, patrol, pmo, shared, browser, resource, note] =
    await Promise.all(['agentmux-cli-module-skills', 'agentmux-cli-help', 'agentmux-cli-commands',
      'agent-outbound-message', 'agent-messaging-guidance', 'goal-role-guidance', 'goal-patrol',
      'agentmux-pmo-playbook', 'agentmux-cli-shared-guides', 'agentmux-cli-browser-guide',
      'agentmux-cli-resource-guide', 'agentmux-cli-note-guide'].map(load))
  const strings = module => Object.fromEntries(Object.entries(module).filter(([, value]) => typeof value === 'string'))
  const catalog = modules.agentMuxCliModuleCatalog()
  assert(catalog.length > 1, 'Module coverage cannot be empty')
  assert.equal(catalog.length, new Set(commands.AGENTMUX_CLI_COMMANDS.map(x => x.method.split('.')[0])).size)
  const generated = await load('generated/agentmux-guides-index')
  const documents = await load('generated/agentmux-guides')
  assert.deepEqual(Object.keys(generated.MODULE_GUIDES).sort(), catalog.map(x => x.root).sort(),
    'Unregistered or missing module guide differs from actual command registration')
  for (const entry of catalog) for (const name of ['root', 'summary', 'roles', 'when', 'readCommand'])
    assert(typeof entry[name] === 'string' && entry[name].trim(), `Missing ${entry.root} ${name}`)
  assert(commands.AGENTMUX_CLI_COMMANDS.length > catalog.length, 'Leaf coverage cannot be empty')
  const identity = { goalId: 'baseline-goal', agentSessionId: 'baseline-session', runId: 'baseline-run',
    source: { kind: 'delegation', operationId: 'baseline-operation', messageId: 'baseline-message',
      sourceMessageId: 'baseline-source-message', threadId: 'baseline-thread' } }
  return {
    catalog, base: modules.agentMuxBaseSkill(), cliHelp: help.AGENTMUX_CLI_HELP,
    modules: Object.fromEntries(catalog.map(x => [x.root, modules.agentMuxModuleSkill(x.root)])),
    commandMetadata: commands.AGENTMUX_CLI_COMMANDS.map(({ method, rpcMethod, usage, summary, details,
      flags, positionalData, stream, local, documentOutput }) => ({ method, rpcMethod, usage, summary,
      details, flags, positionalData, stream, local, documentOutput })),
    commandHelp: Object.fromEntries(commands.AGENTMUX_CLI_COMMANDS.map(x => [x.method, help.agentMuxCommandHelp(x.method)])),
    launch: {
      withRequest: outbound.composeAgentLaunchPrompt('  baseline user request\n原文  ', true, 'baseline extra context'),
      awaitRequest: outbound.composeAgentLaunchPrompt(undefined, true),
      withoutGuide: outbound.composeAgentLaunchPrompt('baseline request', false, 'baseline note'),
      empty: outbound.composeAgentLaunchPrompt(undefined, false)
    },
    resume: outbound.composeAgentResumePrompt('baseline resume', 'baseline note'),
    messaging: { ...strings(messaging), rules: messaging.AGENTMUX_AGENT_MESSAGING_RULES },
    goal: { entry: goal.AGENTMUX_GOAL_SKILL_ENTRY, contract: goal.goalRoleGuidanceContract(),
      executorGuide: documents.guideSharedGoalExecutor.text,
      manager: goal.goalRoleGuidance({ role: 'manager', ...identity }),
      executor: goal.goalRoleGuidance({ role: 'executor', ...identity }),
      managerEmpty: goal.goalRoleGuidance({ role: 'manager' }), executorEmpty: goal.goalRoleGuidance({ role: 'executor' }) },
    patrol: { guidance: patrol.GLOBAL_GOAL_PATROL_GUIDANCE, observed: patrol.globalGoalPatrolPrompt(17),
      unavailable: patrol.globalGoalPatrolPrompt(17, 'baseline inventory unavailable') },
    pmo: pmo.agentMuxPmoPlaybook(), shared: strings(shared), browser: strings(browser),
    resource: strings(resource), note: strings(note)
  }
}

function equalOutputs(actual, expected, label) {
  // JSON projection removes undefined optional command properties equally on both sides.
  // The old private messaging RULES object was only an assembly detail. Its complete public
  // guidance, bootstrap entry and reminder remain byte-for-byte comparison subjects.
  const project = value => {
    const result = JSON.parse(JSON.stringify(value))
    delete result.messaging.rules
    return result
  }
  const changes = []
  function compare(left, right, path = '') {
    if (JSON.stringify(left) === JSON.stringify(right)) return
    if (left && right && typeof left === 'object' && typeof right === 'object') {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) compare(left[key], right[key], path ? path + '.' + key : key)
    } else if (changes.length < 12) {
      let offset = 0
      if (typeof left === 'string' && typeof right === 'string') while (offset < left.length && left[offset] === right[offset]) offset++
      changes.push({ path, offset, actual: String(left).slice(Math.max(0, offset - 32), offset + 120),
        expected: String(right).slice(Math.max(0, offset - 32), offset + 120) })
    }
  }
  compare(project(actual), project(expected))
  assert.equal(changes.length, 0, label + ': ' + JSON.stringify(changes))
}

async function workspacePackages() {
  const seen = new Set(), result = []
  async function visit(source) {
    source = await realpath(source)
    if (seen.has(source)) return
    seen.add(source)
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (version.startsWith('workspace:')) await visit(await resolveDependency(source, name))
    }
    result.push({ source, directory: basename(source), manifest })
  }
  await visit(core)
  assert(result.length > 1, 'Runtime workspace closure must include actual dependencies')
  return result
}

async function resolveDependency(owner, name) {
  const resolver = createRequire(join(owner, 'package.json'))
  for (const directory of resolver.resolve.paths(name) ?? []) {
    try { return await realpath(join(directory, name)) }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error }
  }
  throw new Error(`Installed production dependency ${name} is missing`)
}

function markdownLinks(source) {
  const visible = []
  let fence
  for (const line of source.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line)
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined
    } else if (marker) fence = marker[1]
    else visible.push(line)
  }
  const text = visible.join('\n').replace(/(`+)[\s\S]*?\1/gu, '')
  // Images describe resources and can be literal syntax examples; this proof follows navigation links.
  const links = [...text.matchAll(/(?<!!)\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)\n]+))(?:\s+"[^"]*"|\s+'[^']*'|\s+\([^)]*\))?\s*\)/gu)]
    .map(match => ({ target: match[1] ?? match[2], raw: match[0] }))
  for (const match of text.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|([^\s\n]+))/gmu))
    links.push({ target: match[1] ?? match[2], raw: match[0] })
  return links
}

async function packagedGuideLinks(installed, guideSources) {
  let relativeLinks = 0, codeOwnerLinks = 0
  for (const path of guideSources) {
    const installedPath = join(installed, relative(core, path))
    for (const link of markdownLinks(await readFile(installedPath, 'utf8'))) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/iu.test(link.target)) continue
      const target = resolve(dirname(installedPath), decodeURIComponent(link.target.split(/[?#]/u)[0]))
      assert(target.startsWith(installed + '/'), `Packaged guide link escapes Core: ${relative(core, path)} -> ${link.target}`)
      const metadata = await stat(target)
      assert(metadata.isFile() || metadata.isDirectory(), `Packaged guide link target is unreadable: ${relative(installed, target)}`)
      assert((await realpath(target)).startsWith(installed + '/'), 'Packaged guide link resolves outside its package')
      relativeLinks++
      if (target.includes('/dist/') && link.raw.includes('amux:generated ')) codeOwnerLinks++
    }
  }
  assert(relativeLinks > 0, 'Packaged Markdown link verification cannot be empty')
  assert(codeOwnerLinks > 0, 'Packaged guides must retain readable code-owner links')
  return { relativeLinks, codeOwnerLinks }
}

async function packageProof(root, expected) {
  const packWorkspace = join(root, 'publish-workspace'), archives = join(root, 'archives')
  const consumer = join(root, 'consumer'), isolation = join(root, 'isolation')
  await Promise.all([packWorkspace, archives, consumer, isolation].map(path => mkdir(path, { recursive: true })))
  await writeFile(join(packWorkspace, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
  const packages = await workspacePackages()
  const workspaceArchives = []
  let packedCore
  for (const { source, directory, manifest } of packages) {
    const destination = join(packWorkspace, 'packages', directory)
    await mkdir(destination, { recursive: true })
    assert(manifest.files?.length, `Empty package surface for ${manifest.name}`)
    const automaticFiles = (await readdir(source)).filter(name => /^(?:readme|licen[cs]e|copying|notice)(?:[._-]|$)/iu.test(name))
    for (const entry of new Set([...manifest.files, ...automaticFiles])) {
      try { await cp(join(source, entry), join(destination, entry), { recursive: true }) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    // The built bytes are the subject. Never let pack rebuild shared dist or run lifecycle scripts.
    await writeFile(join(destination, 'package.json'), JSON.stringify({ ...manifest, scripts: {} }))
    const packed = JSON.parse((await exec('pnpm', ['pack', '--pack-destination', archives, '--json'], {
      cwd: destination, env: ambientFree, maxBuffer: 8 * 1024 * 1024
    })).stdout)
    const archive = resolve(archives, packed.filename)
    if (manifest.name === '@agentmux/core') packedCore = { ...packed, archive }
    else workspaceArchives.push(archive)
  }
  assert(packedCore, 'Actual Core package is absent')
  const packedPaths = packedCore.files.map(x => x.path)
  const guideSources = (await files(join(core, 'guides'))).filter(path => path.endsWith('.md'))
  assert(guideSources.length > expected.catalog.length, 'Markdown package surface cannot be empty')
  for (const path of guideSources) assert(packedPaths.includes(relative(core, path)), `Missing packaged guide ${relative(core, path)}`)
  assert(packedPaths.includes('dist/generated/agentmux-guides.js'), 'Generated offline code is absent from npm package')
  const dependencyArchives = [], packedDependencies = new Set()
  async function packDependencies(owner, dependencies) {
    for (const [name, version] of Object.entries(dependencies)) {
      if (version.startsWith('workspace:')) continue
      const source = await resolveDependency(owner, name)
      const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
      const identity = manifest.name + '@' + manifest.version
      if (packedDependencies.has(identity)) continue
      packedDependencies.add(identity)
      await packDependencies(source, manifest.dependencies ?? {})
      const packed = JSON.parse((await exec('npm', ['pack', source, '--ignore-scripts', '--pack-destination', archives, '--json'], {
        cwd: packWorkspace, env: ambientFree, maxBuffer: 8 * 1024 * 1024
      })).stdout)
      assert.equal(packed.length, 1)
      dependencyArchives.push(resolve(archives, packed[0].filename))
    }
  }
  for (const item of packages) await packDependencies(item.source, item.manifest.dependencies ?? {})
  assert(dependencyArchives.length, 'Production dependency package closure cannot be empty')
  await writeFile(join(consumer, 'package.json'), '{"name":"guide-offline-consumer","private":true,"type":"module"}\n')
  await exec('npm', ['install', '--offline', '--ignore-scripts', '--no-package-lock', '--no-save',
    ...dependencyArchives, ...workspaceArchives, packedCore.archive], { cwd: consumer, env: ambientFree, maxBuffer: 8 * 1024 * 1024 })
  const installed = join(consumer, 'node_modules/@agentmux/core')
  assert((await realpath(installed)).startsWith(consumer + '/'), 'Core consumer resolved outside its isolated install')
  for (const path of guideSources) assert.equal(await readFile(join(installed, relative(core, path)), 'utf8'), await readFile(path, 'utf8'))
  const links = await packagedGuideLinks(installed, guideSources)
  const installedOutputs = await capture(join(installed, 'dist'))
  equalOutputs(installedOutputs, expected, 'Actual npm package changed system guidance or command facts')
  const sentinel = join(isolation, 'user-draft.txt')
  await writeFile(sentinel, 'Preserve the original draft.\n')
  let connections = 0
  const server = createServer(stream => { connections++; stream.destroy() })
  const socketPath = join(root, 'read.sock')
  await new Promise((resolveReady, reject) => { server.once('error', reject); server.listen(socketPath, resolveReady) })
  const originalFiles = (await readdir(isolation, { recursive: true })).sort()
  const env = { ...ambientFree, AGENTMUX_RUNTIME_DIRECTORY: isolation, AGENTMUX_STATE_DIRECTORY: join(isolation, 'state'),
    AGENTMUX_AGENT_SESSION_STORE: join(isolation, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(isolation, 'messages.ndjson'),
    AGENTMUX_AGENT_SESSION_ID: 'uncredentialed-guide-reader' }
  const cli = join(installed, 'bin/amux')
  let reads = 0
  async function read(args, expectedText) {
    const result = await exec(process.execPath, ['--disable-warning=ExperimentalWarning', cli, '--endpoint', `unix:${socketPath}`, ...args], {
      cwd: consumer, env, maxBuffer: 8 * 1024 * 1024
    })
    assert.equal(result.stderr, '')
    assert.equal(result.stdout.trim(), expectedText.trim(), 'Packaged CLI differed for ' + args.join(' '))
    reads++
  }
  try {
    await read(['--skill'], expected.base)
    await read(['--help'], expected.cliHelp)
    for (const module of expected.catalog) await read([module.root, '--skill'], expected.modules[module.root])
    const leaves = ['agent.open', 'agent.native', 'browser.run', 'browser.task', 'browser.targets',
      'goal.create', 'system.endpoint', 'notebook', 'settings', 'toolkit', 'git', 'device']
    for (const path of leaves) {
      const text = expected.commandHelp[path]
      // Group-only help has no exact registry item, so read it from the compiled owner.
      const help = text ?? (await import(pathToFileURL(join(installed, 'dist/agentmux-cli-help.js')).href)).agentMuxCommandHelp(path)
      assert(help, `Missing command help for ${path}`)
      await read(['--help', ...path.split('.')], help)
    }
    const manual = await exec(process.execPath, ['--disable-warning=ExperimentalWarning', cli, '--endpoint', `unix:${socketPath}`, 'mote', 'playbook', 'pmo'], {
      cwd: consumer, env, maxBuffer: 8 * 1024 * 1024
    })
    assert.equal(manual.stderr, '')
    assert.deepEqual(JSON.parse(manual.stdout), { ok: true, operation: 'mote.playbook.pmo', result: expected.pmo })
    reads++
    assert.equal(connections, 0, 'Local system guidance connected to a Runtime endpoint')
    assert.deepEqual((await readdir(isolation, { recursive: true })).sort(), originalFiles, 'Local guide reads changed isolated user files')
    assert.equal(await readFile(sentinel, 'utf8'), 'Preserve the original draft.\n')
  } finally { await new Promise((resolveClosed, reject) => server.close(error => error ? reject(error) : resolveClosed())) }
  return { markdownFiles: guideSources.length, modules: expected.catalog.length, commands: expected.commandMetadata.length,
    cliReads: reads, endpointConnections: connections, archiveSha256: sha(await readFile(packedCore.archive)),
    packageOutputSha256: sha(JSON.stringify(installedOutputs)), ...links }
}

async function browserProof(sourceDirectory) {
  const options = { stdin: { contents:
    "export * from './src/agent-message-render.ts'; export * from './src/goal-role-guidance.ts';",
    resolveDir: core, sourcefile: 'guide-browser-consumer.ts', loader: 'ts' }, bundle: true, platform: 'browser',
    format: 'iife', globalName: 'GuideProof', target: 'es2022', write: false, metafile: true, logLevel: 'silent' }
  const result = await esbuild.build(options)
  assert(result.outputFiles.length === 1 && result.outputFiles[0].text.length > 0)
  const inputs = Object.keys(result.metafile.inputs)
  assert(inputs.some(path => path.endsWith('src/generated/agentmux-guides.ts')), 'Browser proof did not consume generated guide code')
  for (const output of Object.values(result.metafile.outputs)) for (const entry of output.imports)
    assert(!entry.path.startsWith('node:'), 'Browser consumer imported a Node capability')
  assert(!inputs.some(path => path.endsWith('src/generated/agentmux-guides-index.ts')),
    'Browser consumer retained the CLI guide index')
  const { GUIDE_DOCUMENTS } = await import(pathToFileURL(join(sourceDirectory, 'generated/agentmux-guides-index.js')).href)
  const unrelated = GUIDE_DOCUMENTS['actions/mote-pmo']
  assert(unrelated?.length > 0, 'The isolation control must be a real, nonempty unrelated guide')
  const marker = 'UNRELATED_PMO_GUIDE_ISOLATION_WITNESS'
  const altered = await esbuild.build({ ...options, plugins: [{ name: 'unrelated-guide-growth', setup(build) {
    build.onLoad({ filter: /[\/]generated[\/]agentmux-guides\.ts$/ }, async ({ path }) => {
      const source = await readFile(path, 'utf8')
      return { contents: replaceOnce(source, JSON.stringify(unrelated), JSON.stringify(unrelated + marker.repeat(8192))), loader: 'ts' }
    })
  } }] })
  assert.equal(altered.outputFiles[0].text, result.outputFiles[0].text,
    'Growing an unrelated guide changed the real Browser consumer bundle')
  assert(!result.outputFiles[0].text.includes(marker))
  const context = Object.assign(Object.create(null), { TextEncoder, TextDecoder })
  runInNewContext(result.outputFiles[0].text, context)
  assert.equal(typeof context.process, 'undefined')
  const rendered = context.GuideProof.renderAgentMuxMessageEnvelope({ messageId: 'original-message',
    sender: { kind: 'agent-session' }, senderSessionId: 'original-session', body: 'Original body\n<opaque />' })
  assert(rendered.includes('Original body\n<opaque />'))
  assert(rendered.includes('message --skill'))
  assert(context.GuideProof.goalRoleGuidance({ role: 'executor' }).includes('Executor') ||
    context.GuideProof.goalRoleGuidance({ role: 'executor' }).includes('Bind work to the exact finite Start'))
  return { inputCount: inputs.length, generatedConsumed: true, envelopeRendered: true, nodeGlobalsRequired: false,
    unrelatedGuideIsolated: true, bundleBytes: result.outputFiles[0].contents.length }
}

function replaceOnce(text, before, after) {
  assert.equal(text.split(before).length, 2, `Mutation witness must occur exactly once: ${before}`)
  return text.replace(before, after)
}

async function mutationProof(root, original) {
  const cases = []
  let previousFixture
  async function sourceDigest(destination) {
    const paths = [...await files(join(destination, 'src')), ...await files(join(destination, 'guides'))]
    return sha(JSON.stringify(await Promise.all(paths.map(async path =>
      [relative(destination, path), sha(await readFile(path))]))))
  }
  async function fixture(label) {
    const destination = join(root, 'mutations', label)
    if (previousFixture) await rm(previousFixture, { recursive: true, force: true })
    previousFixture = destination
    await mkdir(destination, { recursive: true })
    for (const entry of ['guides', 'src', 'scripts', 'package.json'])
      await cp(join(core, entry), join(destination, entry), { recursive: true })
    for (const entry of (await readdir(core)).filter(name => /^tsconfig.*\.json$/u.test(name)))
      await cp(join(core, entry), join(destination, entry))
    await cp(join(repository, 'tsconfig.base.json'), join(root, 'tsconfig.base.json'))
    await symlink(join(core, 'node_modules'), join(destination, 'node_modules'), 'dir')
    await symlink(join(core, 'vendor'), join(destination, 'vendor'), 'dir')
    return destination
  }
  async function generate(destination, check = false) {
    try {
      const result = await exec(process.execPath, [join(destination, 'scripts/generate-guides.mjs'), ...(check ? ['--check'] : [])], {
        cwd: destination, env: ambientFree, maxBuffer: 4 * 1024 * 1024
      })
      return { code: 0, diagnostics: result.stdout + result.stderr }
    } catch (error) {
      if (typeof error.code !== 'number') throw error
      return { code: error.code, diagnostics: (error.stdout ?? '') + (error.stderr ?? '') }
    }
  }
  async function rejectOfficialCheck(destination, label, diagnostic) {
    let failure
    try {
      await exec('npm', ['run', '--ignore-scripts', 'check:guides'], { cwd: destination, env: ambientFree, maxBuffer: 8 * 1024 * 1024 })
    } catch (error) { failure = error }
    assert(failure && typeof failure.code === 'number', `${label} escaped the official guide check`)
    const diagnostics = (failure.stdout ?? '') + (failure.stderr ?? '')
    assert.match(diagnostics, diagnostic, `${label} must fail at the actual code consumer: ${diagnostics}`)
    assert.doesNotMatch(diagnostics, /error TS1\d+|ERR_MODULE_NOT_FOUND|Cannot find package/u,
      'A syntax or setup failure cannot kill a guide-check mutation')
  }
  const guardCases = [
    { label: 'missing-canonical-source', change: destination => rm(join(destination, 'guides/shared/messaging/contract.md')),
      diagnostic: /missing|ENOENT|not found|does not exist|unknown guide include/iu },
    { label: 'generated-code-drift', change: async destination => {
      const path = join(destination, 'src/generated/agentmux-guides.ts')
      await writeFile(path, (await readFile(path, 'utf8')) + '\n// deliberate generated drift\n')
    }, diagnostic: /stale|drift|out.of.date|differs|generated/iu },
    { label: 'unknown-generated-fact', change: async destination => {
      const path = join(destination, 'guides/index.md')
      await writeFile(path, replaceOnce(await readFile(path, 'utf8'), 'amux:generated module-directory', 'amux:generated unknown-fact'))
    }, diagnostic: /unknown|unsupported|generated/iu },
    { label: 'include-cycle', change: async destination => {
      const path = join(destination, 'guides/shared/messaging/contract.md')
      await writeFile(path, (await readFile(path, 'utf8')) + '\n[cycle](contract.md "amux:include")\n')
    }, diagnostic: /cycl|circular/iu }
  ]
  for (const item of guardCases) {
    const destination = await fixture(item.label)
    await item.change(destination)
    const result = await generate(destination, true)
    assert.notEqual(result.code, 0, `${item.label} escaped the build-time source guard`)
    assert.match(result.diagnostics, item.diagnostic, `${item.label} failed outside its intended guard`)
    assert.doesNotMatch(result.diagnostics, /SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find package/u, 'A setup failure cannot kill a mutation')
    cases.push({ label: item.label, killed: true, kind: 'source-guard', sourceSha256: await sourceDigest(destination) })
  }
  const unregistered = await fixture('unregistered-module')
  await cp(join(unregistered, 'guides/modules/message.md'), join(unregistered, 'guides/modules/unregistered.md'))
  const regenerated = await generate(unregistered)
  assert.equal(regenerated.code, 0, 'The unregistered-module mutation must be valid generated source')
  await rejectOfficialCheck(unregistered, 'unregistered-module', /Module guides differ from the executable command registry/u)
  await assert.rejects(capture(await transpileCore(join(unregistered, 'consumer'), unregistered)),
    /Unregistered or missing module guide differs from actual command registration/u)
  cases.push({ label: 'unregistered-module', killed: true, kind: 'actual-command-registration-oracle',
    officialCheck: true, sourceSha256: await sourceDigest(unregistered) })
  const checkedCases = [
    { label: 'code-only-document-missing', change: destination => rm(join(destination, 'guides/shared/messaging/reminder.md')) },
    { label: 'required-code-fact-missing', change: async destination => {
      const path = join(destination, 'guides/shared/messaging/reminder.md')
      await writeFile(path, (await readFile(path, 'utf8')) + '\n[Module directory](../../README.md "amux:generated module-directory")\n')
    } },
    { label: 'unregistered-playbook-command', registryDiagnostic: /Unknown playbook command:? (?:command:)?does\.not\.exist/u,
      change: async destination => {
        const path = join(destination, 'guides/actions/mote-pmo.md')
        await writeFile(path, replaceOnce(await readFile(path, 'utf8'),
          'amux:generated command:goal.create', 'amux:generated command:does.not.exist'))
      } }
  ]
  for (const item of checkedCases) {
    const destination = await fixture(item.label)
    await item.change(destination)
    const generated = await generate(destination)
    assert.equal(generated.code, 0, `${item.label} must first generate valid source: ${generated.diagnostics}`)
    await rejectOfficialCheck(destination, item.label,
      item.registryDiagnostic ?? /agent-messaging-guidance\.ts[^\n]*error TS2\d+/u)
    cases.push({ label: item.label, killed: true, kind: item.registryDiagnostic
      ? 'official-check-guides-command-oracle' : 'official-check-guides-type-oracle', sourceSha256: await sourceDigest(destination) })
  }
  const consumerCases = [
    { label: 'message-contract-disconnected', file: 'guides/modules/message.md',
      directive: '../shared/messaging/contract.md "amux:include"',
      read: output => output.modules.message, cli: ['message', '--skill'],
      expected: original.messaging.AGENTMUX_AGENT_MESSAGING_GUIDANCE },
    { label: 'goal-executor-contract-disconnected', file: 'guides/shared/goal/contract.md',
      directive: '../goal/executor.md "amux:include"',
      read: output => output.goal.contract, cli: ['goal', '--skill'],
      expected: original.goal.executorGuide },
    { label: 'browser-registry-directory-disconnected', file: 'guides/actions/browser-run.md',
      directiveTitle: 'amux:generated browser-capability-directory',
      read: output => output.commandHelp['browser.run'], cli: ['--help', 'browser', 'run'] },
    { label: 'runtime-entry-disconnected', file: 'guides/shared/runtime.md',
      directive: '../shared/messaging/entry.md "amux:include"',
      read: output => output.launch.withRequest.systemContext, expected: original.messaging.AGENTMUX_AGENT_MESSAGING_ENTRY }
  ]
  for (const item of consumerCases) {
    const destination = await fixture(item.label), path = join(destination, item.file)
    const source = await readFile(path, 'utf8')
    const directives = [...source.matchAll(/\[[^\]\n]+\]\(([^)\n]+)\)/gu)].filter(match => item.directiveTitle
      ? match[1].endsWith('"' + item.directiveTitle + '"') : match[1] === item.directive)
    assert.equal(directives.length, 1, 'Mutation must target exactly one original include or generated slot')
    await writeFile(path, replaceOnce(source, directives[0][0], ''))
    const generated = await generate(destination)
    assert.equal(generated.code, 0, `${item.label} must compile before its semantic oracle is evaluated: ${generated.diagnostics}`)
    assert.equal((await generate(destination, true)).code, 0, 'Mutated generated output must be internally current')
    const compiled = await transpileCore(join(destination, 'consumer'), destination)
    const altered = await capture(compiled)
    const actual = item.read(altered), before = item.read(original)
    assert.equal(typeof actual, 'string')
    assert.notEqual(actual, before, `${item.label} did not reach its actual product consumer`)
    if (item.expected) {
      assert(before.includes(item.expected), 'Semantic mutation witness is not carried by the original consumer')
      assert(!actual.includes(item.expected), `${item.label} retained its supposedly removed contract`)
    }
    if (item.cli) {
      // Node 24's experimental SQLite notice is unrelated to guide output; all other stderr stays asserted empty.
      const result = await exec(process.execPath, ['--disable-warning=ExperimentalWarning', join(compiled, 'agentmux.js'), '--endpoint',
        `unix:${join(destination, 'never-started.sock')}`, ...item.cli], { cwd: destination, env: ambientFree, maxBuffer: 8 * 1024 * 1024 })
      assert.equal(result.stderr, '')
      assert(result.stdout.includes(actual.trim()), 'Compiled CLI did not consume the mutated guide')
      if (item.expected) assert(!result.stdout.includes(item.expected), 'Compiled CLI retained the disconnected original contract')
    }
    cases.push({ label: item.label, killed: true, kind: 'successful-generation-consumer-output',
      cliExecuted: !!item.cli, sourceSha256: await sourceDigest(destination), originalSha256: sha(before), mutatedSha256: sha(actual) })
  }
  const startupCases = [
    { label: 'startup-phase-after-rules', file: 'src/agent-outbound-message.ts',
      before: 'parts.unshift(userRequest ? USER_REQUEST_FOLLOWS : AWAIT_USER_REQUEST)',
      after: 'parts.push(userRequest ? USER_REQUEST_FOLLOWS : AWAIT_USER_REQUEST)',
      read: output => output.launch.withRequest.systemContext,
      verify: text => assert(text.startsWith('The user request follows.\n\nAgentMux runtime guide:'),
        'The current request phase must precede the runtime rules') },
    { label: 'startup-wait-before-initialization', file: 'src/agent-outbound-message.ts',
      before: 'No request yet. Complete any read-only initialization below, then wait for the user.',
      after: 'No request yet. Wait for the user.',
      read: output => output.launch.awaitRequest.systemContext,
      verify: text => assert(text.startsWith('No request yet. Complete any read-only initialization below, then wait for the user.'),
        'Business waiting must not postpone read-only initialization') },
    { label: 'startup-spatial-route-removed', file: 'guides/shared/runtime.md',
      before: 'When attached, read space --skill', after: 'When attached, read file --skill',
      read: output => output.launch.withRequest.systemContext,
      verify: text => assert(text.includes('When attached, read space --skill to establish your actual Zone/Tab/Region'),
        'Startup must route attached spatial discovery to its original module') },
    { label: 'startup-zone-confused-with-cwd', file: 'guides/shared/runtime.md',
      before: 'A Zone is a work partition containing Tabs;', after: 'A Zone is the execution cwd;',
      read: output => output.launch.withRequest.systemContext,
      verify: text => assert(text.includes('A Zone is a work partition containing Tabs;') &&
        text.includes('a Tab is a complete workface split into Regions') && text.includes('not a Session identity'),
        'Startup must distinguish the spatial work partition, Tab, Region and execution identity') },
    { label: 'whoami-invents-zone', file: 'guides/modules/whoami.md',
      before: 'whoami does not supply a Zone or all display bindings.',
      after: 'whoami supplies the Zone and all display bindings.',
      read: output => output.modules.whoami, cli: ['whoami', '--skill'],
      verify: text => assert(text.includes('whoami does not supply a Zone or all display bindings.'),
        'whoami must preserve its actual scope and route Zone discovery to space') },
    { label: 'startup-unconditional-collaboration', file: 'guides/shared/messaging/entry.md',
      before: 'If the task needs collaboration, choose', after: 'Choose',
      read: output => output.launch.withRequest.systemContext,
      verify: text => assert(text.includes('If the task needs collaboration, choose'),
        'A startup capability entry must not prescribe collaboration for every task') }
  ]
  const browserCases = [
    { label: 'capsule-open-help-disconnected', file: 'src/agentmux-cli-help.ts',
      before: ": path === 'capsule.open' ? CAPSULE_OPEN_GUIDE",
      after: ": path === 'capsule.open' ? ''",
      read: output => output.commandHelp['capsule.open'], cli: ['capsule', 'open', '--help'],
      verify: text => assert(text.includes('"placement":{"kind":"split"') &&
        text.includes('it does not say created or reused'),
        'Capsule leaf help must consume the explicit placement and original result guide') },
    { label: 'browser-same-tab-policy-reversed', file: 'guides/shared/spatial.md',
      before: 'then prefer a directional Region in that same Tab', after: 'then prefer a separate new Tab',
      read: output => output.modules.space, cli: ['space', '--skill'],
      verify: text => assert(text.includes('then prefer a directional Region in that same Tab'),
        'A related new page should normally stay readable in the same Tab') },
    { label: 'browser-focus-visibility-invented', file: 'guides/shared/spatial.md',
      before: 'a new Tab may be outside the current reading', after: 'a new Tab is always inside the current reading',
      read: output => output.modules.space, cli: ['space', '--skill'],
      verify: text => assert(text.replace(/\s+/gu, ' ').includes('a new Tab may be outside the current reading view and be harder to find'),
        'A new Tab does not guarantee visibility in the current Focus reading view') },
    { label: 'browser-vague-target-guessed', file: 'guides/actions/browser-targets.md',
      before: "this task's same-Tab neighbor Regions", after: 'the globally most recent page',
      read: output => output.commandHelp['browser.targets'], cli: ['browser', 'targets', '--help'],
      verify: text => assert(text.includes("this task's same-Tab neighbor Regions") &&
        text.includes('verify the exact typed Browser binding'),
        'An unspecified Browser request must be resolved from task context and structured identity') }
  ]
  for (const item of [...startupCases, ...browserCases]) {
    item.verify(item.read(original))
    const destination = await fixture(item.label), path = join(destination, item.file)
    await writeFile(path, replaceOnce(await readFile(path, 'utf8'), item.before, item.after))
    const generated = await generate(destination)
    assert.equal(generated.code, 0, `${item.label} must generate successfully: ${generated.diagnostics}`)
    assert.equal((await generate(destination, true)).code, 0, 'Mutated output must be internally current')
    const compiled = await transpileCore(join(destination, 'consumer'), destination)
    const actual = item.read(await capture(compiled))
    assert.equal(typeof actual, 'string')
    if (item.cli) {
      const result = await exec(process.execPath, ['--disable-warning=ExperimentalWarning', join(compiled, 'agentmux.js'), '--endpoint',
        `unix:${join(destination, 'never-started.sock')}`, ...item.cli], { cwd: destination, env: ambientFree, maxBuffer: 8 * 1024 * 1024 })
      assert.equal(result.stderr, '')
      assert(result.stdout.includes(actual.trim()), 'Compiled CLI did not consume the altered module')
    }
    assert.throws(() => item.verify(actual), { code: 'ERR_ASSERTION' },
      `${item.label} must fail its semantic oracle after successful source consumption`)
    cases.push({ label: item.label, killed: true, kind: 'source-semantic-output',
      cliExecuted: !!item.cli, sourceSha256: await sourceDigest(destination) })
  }
  assert.equal(cases.length, guardCases.length + consumerCases.length + checkedCases.length + startupCases.length + browserCases.length + 1)
  return { passed: true, count: cases.length, cases }
}

async function main() {
  const mode = process.argv[2]
  if (mode && !['--prepare', '--package-proof', '--source-proof', '--parity'].includes(mode))
    throw new Error('Use --prepare, --package-proof, --source-proof, --parity, or no arguments')
  const includeBuilt = !['--source-proof', '--parity'].includes(mode)
  const inputs = await hashes(includeBuilt)
  await exec('npm', ['run', '--ignore-scripts', 'check:guides'], { cwd: core, env: ambientFree, maxBuffer: 8 * 1024 * 1024 })
  if (!mode) {
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
    assert.equal(receipt.schema, 'agentmux.system-guides-verification.v1')
    assert.equal(receipt.passed, true)
    assert.deepEqual(receipt.inputs, inputs, 'System-guide proof is stale; run this command with --prepare')
    assert(receipt.package.cliReads > receipt.package.modules && receipt.package.commands > 0)
    assert.equal(receipt.package.endpointConnections, 0)
    assert.equal(receipt.browser.generatedConsumed, true)
    assert.equal(receipt.browser.unrelatedGuideIsolated, true)
    assert(receipt.mutations.passed && receipt.mutations.count > 0)
    process.stdout.write(JSON.stringify({ passed: true, reused: true, receipt: relative(repository, receiptPath) }) + '\n')
    return
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amux-guide-proof-')))
  try {
    const sourceDirectory = await transpileCore(join(root, 'source'))
    const sourceOutputs = await capture(sourceDirectory)
    let baseline = { state: 'not-present; package/source parity remains required' }
    if (mode === '--prepare' || mode === '--parity') {
      try {
        const original = JSON.parse(await readFile(join(evidence, 'baseline.json'), 'utf8'))
        equalOutputs(sourceOutputs, original.output, 'Markdown migration changed a pre-migration output byte')
        baseline = { state: 'compared', head: original.head, outputSha256: sha(JSON.stringify(original.output)) }
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    if (mode === '--parity') {
      assert.equal(baseline.state, 'compared', 'The migration baseline is required for a parity-only run')
      process.stdout.write(JSON.stringify({ passed: true, baseline, modules: sourceOutputs.catalog.length,
        commands: sourceOutputs.commandMetadata.length }) + '\n')
      return
    }
    if (mode !== '--source-proof') equalOutputs(await capture(join(core, 'dist')), sourceOutputs, 'Built Core guidance is stale')
    const packed = mode === '--source-proof' ? undefined : await packageProof(root, sourceOutputs)
    const browser = await browserProof(sourceDirectory)
    const mutations = mode === '--package-proof' ? undefined : await mutationProof(root, sourceOutputs)
    assert.deepEqual(await hashes(includeBuilt), inputs, 'Proof inputs changed during verification')
    const receipt = { schema: 'agentmux.system-guides-verification.v1', passed: true, inputs,
      sourceOutputSha256: sha(JSON.stringify(sourceOutputs)), baseline, package: packed, browser, mutations }
    if (mode === '--prepare') {
      await mkdir(evidence, { recursive: true })
      await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
    }
    process.stdout.write(JSON.stringify({ passed: true, baseline, package: packed, browser, mutations }) + '\n')
  } finally { await rm(root, { recursive: true, force: true }) }
}

await main()
