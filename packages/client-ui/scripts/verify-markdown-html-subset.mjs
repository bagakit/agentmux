// Mutation proof for the README HTML subset: each mutant breaks one real guard in the
// implementation and must turn a behavior assertion red; the restored source must pass.
// Runs the committed owning config in an isolated copy of client-ui/src so the shared tree is never modified.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const parser = 'packages/client-ui/src/lib/markdown-html.ts'
const owner = 'packages/client-ui/src/lib/agent-markdown.ts'
const renderer = 'packages/client-ui/src/components/AgentMarkdown.tsx'
const config = 'packages/client-ui/test/markdown-html.config.mts'
const tests = ['packages/client-ui/test/markdown-html-subset.test.tsx', 'packages/client-ui/test/markdown-html-render.test.tsx', 'packages/client-ui/test/markdown-semantics.test.tsx']
const mutations = [
  { mode: 'unknown-element-becomes-element', path: parser, from: "if (!BLOCK.has(name) && !INLINE.has(name)) { emit({ kind: 'literal', source: raw }, start, end); return }", to: "if (false) { emit({ kind: 'literal', source: raw }, start, end); return }" },
  { mode: 'raw-text-script-body-parsed', path: parser, from: 'tokenizer.state = rawMode', to: 'rawText = null' },
  { mode: 'width-unvalidated', path: parser, from: "if (!match) return undefined\n  const amount", to: "if (!match) return value\n  const amount" },
  { mode: 'unclosed-element-repaired', path: parser, from: "if (item.close === null || PARENT[item.name]) { visibleTags(item).forEach(visit); return }", to: "if (PARENT[item.name]) { visibleTags(item).forEach(visit); return }" },
  { mode: 'picture-ignores-media', path: parser, from: "if (scheme && href && !variants[scheme]) variants[scheme] = href", to: "if (href && !variants.dark) variants.dark = href" },
  { mode: 'layout-table-misclassified', path: parser, from: 'const layout = rows.every(candidate => !candidate.head && candidate.cells.every(entry => !entry.header))', to: 'const layout = true' },
  { mode: 'comment-shown', path: parser, from: "if (token.kind === 'comment') continue // GitHub never shows HTML comments.", to: "if (token.kind === 'comment') { top().children.push({ t: 'literal', source: token.source }); continue }" },
  { mode: 'alert-allowed-nested', path: owner, from: 'if (!context.alertsAllowed || first?.type', to: 'if (first?.type' },
  { mode: 'alert-same-line-title', path: owner, from: "const ALERT_MARKER = /^\\[!(note|tip|important|warning|caution)\\][\\t ]*(?:\\r?\\n|$)/iu", to: "const ALERT_MARKER = /^\\[!(note|tip|important|warning|caution)\\][\\t ]*/iu" },
  { mode: 'alert-without-body', path: owner, from: 'if (!body.length) return null', to: 'if (false) return null' },
  { mode: 'html-not-projected', path: owner, from: "if (nodes.some(node => node.type === 'html')) return htmlInlines(nodes, htmlProjection(context))", to: '' },
  { mode: 'picture-follows-nothing', path: renderer, from: 'return <>{render(node.variants?.[mode] ?? node.href)}</>', to: 'return <>{render(node.href)}</>' },
  { mode: 'author-width-dropped', path: renderer, from: "return frame ? <span key={key} className=\"md-image-frame\" data-sized=\"\" style={frame}>{content}</span> : <Fragment key={key}>{content}</Fragment>", to: 'return <Fragment key={key}>{content}</Fragment>' },
  { mode: 'alert-label-missing', path: renderer, from: '<p className="md-alert__title"><Icon size={14} aria-hidden="true" />{label}</p>', to: '<p className="md-alert__title"><Icon size={14} aria-hidden="true" /></p>' },
  { mode: 'fragment-link-escapes-document', path: renderer, from: 'const fragment = context.documentMode && context.openWorkspaceFile ?', to: 'const fragment = context.openWorkspaceFile ?' },
  { mode: 'fragment-link-skips-root-check', path: renderer, from: 'const anchored = fragment ? classifyMarkdownLinkHref(fragment[1]!, context.workspaceRoot, context.homeDir, context.sourcePath) : null', to: "const anchored = fragment ? { index: 0, length: fragment[1]!.length, path: fragment[1]! } : null" },
  { mode: 'unclosed-raw-text-swallows-tail', path: parser, from: "if (!rawTextEnd(source, name, end)) { emit({ kind: 'literal', source: raw, rawText: name }, start, end); return }", to: '' },
  { mode: 'unclosed-raw-text-swallows-siblings', path: parser, from: "last.rawText && closedLater(index, last.rawText)", to: 'last.rawText' },
  { mode: 'nested-html-link-kept', path: parser, from: "if (index > 0) { for (const implied of stack.splice(index)) implied.close ??= ''; impliedAnchorEnds++ }", to: '' },
  { mode: 'link-inside-link-label', path: renderer, from: 'if (context.inLink) return <Fragment key={key}><Inline nodes={node.children} context={context} /></Fragment>', to: '' },
  { mode: 'link-label-keeps-nested-link', path: parser, from: 'content = unlink(children())', to: 'content = children()' },
  { mode: 'inherited-raw-text-lookup', path: parser, from: 'const rawMode = RAW_TEXT.get(name)', to: 'const rawMode = (Object.fromEntries(RAW_TEXT) as Record<string, number>)[name]' },
  { mode: 'flattened-heading-in-outline', path: parser, from: 'align, inlineDepth === 0)]', to: 'align, true)]' },
  { mode: 'quadratic-trim', path: parser, from: 'function trimEndHtml(text: string): string { let end = text.length; while (end > 0 && isHtmlSpace(text.charCodeAt(end - 1))) end--; return text.slice(0, end) }', to: "function trimEndHtml(text: string): string { return text.replace(/[\\t\\n\\f\\r ]+$/u, '') }" },
  { mode: 'unclosed-raw-block-reflowed', path: parser, from: '  const index = nodes.findIndex(opensRawBlock)', to: '  const index = -1' },
  { mode: 'closed-details-searchable', path: renderer, from: 'if (node.kind === \'details\') return node.open ? project(node.children) : []', to: "if (node.kind === 'details') return project(node.children)" },
]

const proof = await mkdtemp(join(root, '.tmp/markdown-html-mutation-'))
const snapshot = join(proof, 'source')
try {
  await cp(join(root, 'packages/client-ui/src'), join(snapshot, 'packages/client-ui/src'), { recursive: true })
  for (const path of [...tests, config, 'package.json', 'packages/client-ui/package.json', 'README.md', 'README.zh-CN.md', 'test/fixture-values.mjs']) {
    await mkdir(join(snapshot, path, '..'), { recursive: true })
    await cp(join(root, path), join(snapshot, path))
  }
  await symlink(join(root, 'node_modules'), join(snapshot, 'node_modules'), 'dir')
  // client-ui reaches Core through @agentmux/core. Freeze a copy of Core's package (dist and its own
  // dependencies) into the snapshot, so another build replacing the shared dist cannot fail a proof run.
  const clientModules = join(snapshot, 'packages/client-ui/node_modules')
  await mkdir(join(clientModules, '@agentmux'), { recursive: true })
  for (const entry of await readdir(join(root, 'packages/client-ui/node_modules'))) {
    if (entry !== '@agentmux') await symlink(join(root, 'packages/client-ui/node_modules', entry), join(clientModules, entry))
  }
  const core = join(snapshot, 'packages/core')
  await cp(join(root, 'packages/core/package.json'), join(core, 'package.json'))
  await cp(join(root, 'packages/core/dist'), join(core, 'dist'), { recursive: true })
  assert.ok((await readdir(join(core, 'dist'))).length > 100, 'Frozen Core dist is complete')
  await symlink(join(root, 'packages/core/node_modules'), join(core, 'node_modules'), 'dir')
  await symlink(core, join(clientModules, '@agentmux/core'), 'dir')
  // The committed owning config must name exactly these tests, so the proof and the gate run the same files.
  assert.ok(tests.every(test => readFileSync(join(root, config), 'utf8').includes(test)), 'Owning config names every proof test')
  async function run(mode) {
    const output = join(proof, `${mode}.json`)
    const exitCode = await new Promise((done, reject) => {
      const child = spawn(join(root, 'node_modules/.bin/vitest'), ['run', '--config', join(snapshot, config), '--reporter=json', `--outputFile=${output}`], { cwd: snapshot, stdio: 'ignore' })
      child.on('error', reject); child.on('exit', done)
    })
    const result = JSON.parse(await readFile(output, 'utf8'))
    const loaded = result.testResults.filter(file => file.assertionResults.length > 0).length
    const assertions = result.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'failed')
    const loadFailures = result.testResults.filter(file => file.status !== 'passed' && file.assertionResults.length === 0).map(file => (file.message ?? '').slice(0, 200))
    return { exitCode, loaded, passed: result.numPassedTests, failed: result.numFailedTests, assertions, loadFailures }
  }
  const green = await run('green')
  assert.equal(green.exitCode, 0, 'Candidate source must pass')
  assert.equal(green.loaded, tests.length, 'Every owning test file must load and collect tests')
  console.log(`green: ${green.passed} passed`)
  const results = []
  for (const mutation of mutations) {
    const file = join(snapshot, mutation.path), original = await readFile(file, 'utf8')
    assert.equal(original.split(mutation.from).length - 1, 1, `Mutation anchor ${mutation.mode} must exist exactly once`)
    assert.notEqual(mutation.from, mutation.to)
    try {
      await writeFile(file, original.replace(mutation.from, mutation.to))
      // A run where an owning test file failed to load proves nothing either way (often another
      // build replacing shared dist mid-run); retry it rather than calling the mutant killed or survived.
      let mutant = await run(mutation.mode)
      for (let attempt = 1; mutant.loaded !== tests.length && attempt <= 3; attempt++) {
        console.log(`retry   ${mutation.mode}: ${mutant.loaded}/${tests.length} files loaded`)
        await new Promise(resolve => setTimeout(resolve, 15000))
        mutant = await run(mutation.mode)
      }
      assert.equal(mutant.loaded, tests.length, `Mutant ${mutation.mode} must load every owning test file: ${mutant.loadFailures.join(' | ')}`)
      const killed = mutant.exitCode !== 0 && mutant.loaded === tests.length && mutant.assertions.some(test => test.failureMessages.some(message => /AssertionError|expected/u.test(message)))
      results.push({ mode: mutation.mode, killed, failed: mutant.failed, firstFailure: mutant.assertions[0]?.fullName })
      console.log(`${killed ? 'killed  ' : 'SURVIVED'} ${mutation.mode} (exit ${mutant.exitCode}, ${mutant.passed} passed, ${mutant.failed} failed, ${mutant.loaded}/${tests.length} loaded)${mutant.loadFailures.length ? ' LOAD: ' + mutant.loadFailures.join(' | ') : ''}`)
    } finally {
      await writeFile(file, original)
    }
  }
  const restored = await run('restored')
  assert.equal(restored.exitCode, 0, 'Restored source must pass again')
  const survived = results.filter(result => !result.killed)
  await writeFile(join(root, '.tmp/markdown-html-mutation-receipt.json'), JSON.stringify({ green: green.passed, restored: restored.passed, results }, null, 2))
  assert.deepEqual(survived.map(result => result.mode), [], 'Every mutant must be killed by a behavior assertion')
  console.log(`all ${results.length} mutants killed; restored ${restored.passed} passed`)
} finally {
  await rm(proof, { recursive: true, force: true })
}
