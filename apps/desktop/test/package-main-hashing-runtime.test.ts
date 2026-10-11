import { execFileSync } from 'node:child_process'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { expect, it } from 'vitest'

it('the production Desktop copying block supplies Main hashing imports inside a standalone app', async () => {
  const repositoryRoot = resolve(import.meta.dirname, '../../..')
  const scriptPath = process.env.AGENTMUX_PACKAGE_HASHING_SOURCE ?? join(repositoryRoot, 'apps/desktop/scripts/package-macos.mjs')
  const source = ts.createSourceFile(scriptPath, await readFile(scriptPath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
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
  const copyDependencies = new Function('readFile', 'mkdir', 'cp', 'readdir', 'join', 'dirname', 'lstat', 'realpath',
    'repositoryRoot', 'desktopRoot', 'coreRoot', 'connectorsRoot', functions.join('\n') +
    '\nreturn async function(appResources) {\n' + copyingStatements.map(statement => statement.getText(source)).join('\n') + '\n}')(
    readFile, mkdir, cp, readdir, join, dirname, lstat, realpath,
    repositoryRoot, join(repositoryRoot, 'apps/desktop'), join(repositoryRoot, 'packages/core'), join(repositoryRoot, 'packages/connectors')) as (appResources: string) => Promise<void>
  const temporary = await mkdtemp(join(tmpdir(), 'agentmux-main-hashing-'))
  try {
    const appResources = join(temporary, 'AgentMux.app/Contents/Resources/app')
    await copyDependencies(appResources)
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
  } finally { await rm(temporary, { recursive: true, force: true }) }
}, 30_000)
