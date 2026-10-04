import { execFileSync } from 'node:child_process'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

it('the actual packaging dependency materializer copies a standalone usable neutral Git package', async () => {
  const root = resolve(import.meta.dirname, '../../..')
  const text = await readFile(join(root, 'apps/desktop/scripts/package-macos.mjs'), 'utf8')
  const source = ts.createSourceFile('package-macos.mjs', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const calls: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'materializeDependency' &&
      node.arguments[1] && ts.isStringLiteral(node.arguments[1]) && node.arguments[1].text === '@agentmux/git') calls.push(node.getText(source))
    ts.forEachChild(node, visit)
  }
  visit(source)
  expect(calls).toHaveLength(1)
  const functions = ['pathExists', 'materializeDependencies', 'materializeDependency', 'resolvePackageRoot'].map(name => {
    const declaration = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name)
    expect(declaration, `Actual packaging function ${name}`).toBeDefined()
    return declaration!.getText(source)
  })
  // Execute unchanged private packaging functions, without launching/signing/installing an App.
  const materialize = new Function('readFile', 'mkdir', 'cp', 'readdir', 'join', 'dirname', 'lstat', 'realpath', 'repositoryRoot',
    functions.join('\n') + '\nreturn materializeDependency;')(readFile, mkdir, cp, readdir, join, dirname, lstat, realpath, root) as
    (source: string, name: string, destination: string) => Promise<void>
  const temporary = await mkdtemp(join(tmpdir(), 'agentmux-git-runtime-'))
  try {
    await materialize(join(root, 'apps/desktop'), '@agentmux/git', join(temporary, 'node_modules/@agentmux/git'))
    const manifest = JSON.parse(await readFile(join(temporary, 'node_modules/@agentmux/git/package.json'), 'utf8'))
    expect(manifest.name).toBe('@agentmux/git')
    expect(manifest.dependencies ?? {}).toEqual({})
    const output = execFileSync(process.execPath, ['--input-type=module', '-e',
      "const m=await import('@agentmux/git'); console.log(JSON.stringify({repository:typeof m.GitRepository,reader:typeof m.readLocalWorktreeFile,history:typeof m.parseGitHistory,credential:m.scrubGitCredentials('https://secret@host/repo')}))"],
    { cwd: temporary, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } })
    expect(JSON.parse(output)).toEqual({ repository: 'function', reader: 'function', history: 'function', credential: 'https://***@host/repo' })
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
