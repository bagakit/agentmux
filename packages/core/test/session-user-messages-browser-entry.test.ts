import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import ts from 'typescript'
import { expect, it } from 'vitest'
import type { AgentSessionHistoryPage, AgentTimelineSnapshot } from '@agentmux/core'

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const coreRoot = join(repositoryRoot, 'packages/core')
const publicEntry = '@agentmux/core/session-user-messages'
const execFileAsync = promisify(execFile)

async function capture<T>(operation: () => Promise<T>) {
  try {
    return { value: await operation(), error: null }
  } catch (error) {
    return { value: null, error }
  }
}

function parse(path: string, source: string) {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
}

function runtimeBinding(source: ts.SourceFile, exportedName: string) {
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const clause = statement.importClause
    if (!clause || clause.isTypeOnly || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue
    for (const binding of clause.namedBindings.elements) {
      if (!binding.isTypeOnly && (binding.propertyName ?? binding.name).text === exportedName) {
        return { module: statement.moduleSpecifier.text, localName: binding.name.text }
      }
    }
  }
  return undefined
}

function calls(source: ts.SourceFile, name: string, jsx = false) {
  const found: ts.Node[] = []
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) found.push(node)
    if (jsx && (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        ts.isIdentifier(node.tagName) && node.tagName.text === name) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

it('bundles the public package entry for a browser and executes nonempty, partitioned message facts', async () => {
  const entrySource = `import { projectSessionUserMessages } from '${publicEntry}';\nexport { projectSessionUserMessages };`
  const entryName = 'session-user-messages-browser-consumer.js'
  const entryKey = relative(repositoryRoot, join(coreRoot, entryName))
  const bundled = await capture(() => build({
    absWorkingDir: repositoryRoot,
    stdin: { contents: entrySource, resolveDir: coreRoot, sourcefile: entryName, loader: 'js' },
    bundle: true, platform: 'browser', format: 'iife', globalName: 'MessageProjection',
    write: false, metafile: true, logLevel: 'silent'
  }))
  // Keep package resolution failures inside the owning assertion, rather than losing the suite at load time.
  expect(bundled.error).toBeNull()
  expect(bundled.value).not.toBeNull()
  const result = bundled.value!
  const inputs = Object.keys(result.metafile!.inputs)
  expect(inputs.length).toBeGreaterThan(0)
  expect(inputs).toContain(entryKey)
  expect(inputs).toContain('packages/core/dist/session-user-messages.js')
  const nodeModules = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]))
  for (const input of inputs) {
    const metadata = result.metafile!.inputs[input]!
    expect(metadata.bytes).toBeGreaterThan(0)
    for (const imported of metadata.imports) {
      expect(imported.external).not.toBe(true)
      expect(nodeModules.has(imported.path)).toBe(false)
    }
    const text = input === entryKey ? entrySource : await readFile(resolve(repositoryRoot, input), 'utf8')
    const source = parse(input, text)
    function visit(node: ts.Node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        expect(nodeModules.has(node.moduleSpecifier.text)).toBe(false)
      }
      if (ts.isCallExpression(node)) {
        expect(node.expression.kind).not.toBe(ts.SyntaxKind.ImportKeyword)
        if (ts.isIdentifier(node.expression)) expect(['require', 'eval']).not.toContain(node.expression.text)
      }
      if (ts.isIdentifier(node)) expect(['process', 'Buffer', '__dirname', '__filename', 'global']).not.toContain(node.text)
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  expect(result.outputFiles).toHaveLength(1)
  const context: { MessageProjection?: { projectSessionUserMessages: (input: unknown) => unknown } } = {}
  runInNewContext(result.outputFiles![0]!.text, context)
  expect(Object.keys(context.MessageProjection!)).toEqual(['projectSessionUserMessages'])
  const historyPage: AgentSessionHistoryPage = {
    agentSessionId: 'recipient', source: { providerId: 'claude', nativeSessionId: 'native-session' }, nextCursor: null,
    items: [
      { id: 'native-1', turnId: 'turn-1', kind: 'user-message', startedAt: 1000,
        contentParts: [{ kind: 'text', text: 'same body' }, { kind: 'resource', resourceType: 'image', reference: 'image.png' }] },
      { id: 'native-2', kind: 'user-message', contentParts: [{ kind: 'text', text: 'same body' }] }
    ]
  }
  const timeline: AgentTimelineSnapshot = {
    agentSessionId: 'recipient', revision: 1,
    items: [{ id: 'submission-1', agentSessionId: 'recipient', kind: 'user_message', status: 'streaming', source: 'user',
      createdAt: 2000, updatedAt: 2000, title: 'Input', content: 'same body', authorAgentSessionId: 'sender' }]
  }
  // This is a controlled public DTO witness, not a Vendor writer, model, or healthy Runtime operation.
  const observed = JSON.parse(JSON.stringify(context.MessageProjection!.projectSessionUserMessages({
    agentSessionId: 'recipient', historyPage, timeline
  })))
  expect(observed).toEqual([
    { id: 'native:claude:native-session:native-1', rawId: 'native-1', agentSessionId: 'recipient', turnId: 'turn-1',
      source: { kind: 'native', providerId: 'claude', nativeSessionId: 'native-session', recordId: 'native-1' },
      author: { kind: 'unknown' }, content: 'same body', contentParts: historyPage.items[0]!.contentParts, recordedAt: 1000 },
    { id: 'native:claude:native-session:native-2', rawId: 'native-2', agentSessionId: 'recipient',
      source: { kind: 'native', providerId: 'claude', nativeSessionId: 'native-session', recordId: 'native-2' },
      author: { kind: 'unknown' }, content: 'same body', contentParts: historyPage.items[1]!.contentParts },
    { id: 'captured:submission-1', rawId: 'submission-1', agentSessionId: 'recipient',
      source: { kind: 'captured', submissionId: 'submission-1' }, author: { kind: 'agent', agentSessionId: 'sender' },
      content: 'same body', contentParts: [{ kind: 'text', text: 'same body' }], recordedAt: 2000, deliveryStatus: 'unverified' }
  ])
})

it('keeps the root and browser subpath exports on the same compiled function', async () => {
  const loaded = await capture(() => execFileAsync(process.execPath, ['--input-type=module', '-e', `
    const root = await import('@agentmux/core');
    const browser = await import('${publicEntry}');
    console.log(JSON.stringify({ exports: Object.keys(browser), type: typeof browser.projectSessionUserMessages,
      same: root.projectSessionUserMessages === browser.projectSessionUserMessages }));
  `], { cwd: coreRoot }))
  expect(loaded.error).toBeNull()
  expect(JSON.parse(loaded.value!.stdout)).toEqual({ exports: ['projectSessionUserMessages'], type: 'function', same: true })
})

it('finds real renderer imports and the Mailbox/Composer call chain outside projector definitions', async () => {
  const rendererRoot = join(repositoryRoot, 'apps/desktop/src/renderer/src')
  const entries = await readdir(rendererRoot, { recursive: true, withFileTypes: true })
  const consumers = new Map<string, { source: ts.SourceFile, localName: string }>()
  for (const entry of entries) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue
    const path = join(entry.parentPath, entry.name)
    const source = parse(path, await readFile(path, 'utf8'))
    const binding = runtimeBinding(source, 'projectSessionUserMessages')
    if (!binding) continue
    expect(binding.module).toBe(publicEntry)
    expect(calls(source, binding.localName).length).toBeGreaterThan(0)
    consumers.set(relative(rendererRoot, path), { source, localName: binding.localName })
  }
  expect(consumers.size).toBeGreaterThan(0)
  expect(consumers.has('lib/session-user-messages.ts')).toBe(true)
  const mailboxPath = join(rendererRoot, 'components/SessionMailbox.tsx')
  const mailbox = parse(mailboxPath, await readFile(mailboxPath, 'utf8'))
  const hook = runtimeBinding(mailbox, 'useSessionUserMessages')
  expect(hook).toBeDefined()
  expect(resolve(mailboxPath, '..', `${hook!.module}.ts`)).toBe(join(rendererRoot, 'lib/session-user-messages.ts'))
  expect(calls(mailbox, hook!.localName).length).toBeGreaterThan(0)
  const composerPath = join(rendererRoot, 'components/AgentSessionComposer.tsx')
  const composer = parse(composerPath, await readFile(composerPath, 'utf8'))
  const component = runtimeBinding(composer, 'SessionMailbox')
  expect(component).toBeDefined()
  expect(resolve(composerPath, '..', `${component!.module}.tsx`)).toBe(mailboxPath)
  expect(calls(composer, component!.localName, true).length).toBeGreaterThan(0)
})
