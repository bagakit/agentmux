import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
import { root, desktopRequire as require, aliases } from './fixtures/settings-resource-library/environment.mjs'
const fixture = path.join(root, 'apps/desktop/scripts/fixtures/settings-reference')
const evidence = path.join(root, '.tmp/settings-reference', 'run-' + crypto.randomUUID())
await fs.mkdir(evidence, { recursive: true })
const owned = await fs.mkdtemp(path.join(os.tmpdir(), 'amux-settings-reference-'))
const inputs = new Map(), runs = []
const visualOnly = process.argv.includes('--visual-only')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function bind(file) {
  const bytes = await fs.readFile(file), digest = hash(bytes)
  if (inputs.has(file)) assert.equal(inputs.get(file), digest, 'Actual proof input unchanged: ' + file)
  else { inputs.set(file, digest); const target = path.join(evidence, 'source', path.relative(root, file)); await fs.mkdir(path.dirname(target), {recursive:true}); await fs.writeFile(target, bytes) }
}
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
try {
  for (const relative of [
    'components/SettingsPanel.tsx', 'components/settings/AgentSettingsPane.tsx',
    'components/settings/ProviderCatalogPane.tsx', 'components/settings/ShortcutSettingsPane.tsx', 'components/settings/SettingsResourceLibrary.tsx',
    'styles/surfaces.css', 'styles/settings-prompts.css', 'styles/settings-materials.css', 'styles/settings-resource-library.css', 'styles/agent.css'
  ]) await bind(path.join(root, 'apps/desktop/src/renderer/src', relative))
  for (const relative of ['test/settings-reference.test.tsx', 'test/settings-resource-library.test.tsx',
    'test/settings-executor-creation.test.tsx', 'test/settings-prompt-workbench.test.tsx', 'test/settings-prompts-save.test.tsx', 'test/settings-prompts-library.test.tsx', 'test/settings-prompts-liquid.test.tsx', 'scripts/verify-settings-reference.mjs',
    ...['entry.tsx', 'index.html', 'main.cjs', 'vitest.config.mts', 'tsconfig.owning.json'].map(file => 'scripts/fixtures/settings-reference/' + file)
  ]) await bind(path.join(root, 'apps/desktop', relative))
  const typeOutput = []
  const typecheck = await runProbeProcess(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '-p', path.join(fixture,'tsconfig.owning.json')], {cwd:root,temporaryRoot:owned,env,timeoutMs:90000,onLine:line=>typeOutput.push(line)})
  await fs.writeFile(path.join(evidence,'typecheck.log'),typeOutput.join('\n'))
  assert.equal(typecheck.exitCode,0,typeOutput.join('\n'))
  for (const mode of visualOnly ? [] : ['baseline','sidebar','selection','drafts','creation','prompt-scope','restored']) {
    const directory = path.join(evidence, mode); await fs.mkdir(directory)
    const output = []
    const run = await runProbeProcess(process.execPath, [require.resolve('vitest/vitest.mjs'), 'run', '--config', path.join(fixture, 'vitest.config.mts')], {
      cwd: root, temporaryRoot: owned, env: { ...env, AGENTMUX_RESOURCE_LIBRARY_SECTION: 'agents', AGENTMUX_SETTINGS_REFERENCE_EVIDENCE: directory,
        ...(mode === 'baseline' || mode === 'restored' ? {} : {AGENTMUX_SETTINGS_REFERENCE_MUTANT:mode}) }, timeoutMs: 90000, onLine: line => output.push(line)
    })
    await fs.writeFile(path.join(directory, 'test.log'), output.join('\n'))
    assert.equal(run.timedOut, false)
    const green = mode === 'baseline' || mode === 'restored'
    if (green) assert.equal(run.exitCode, 0, output.join('\n'))
    else {
      assert.notEqual(run.exitCode, 0)
      assert.match(output.join('\n'), /AssertionError|expected .*to /u, 'Mutation killed by an assertion')
      const mutation = (await fs.readFile(path.join(directory,'mutation.jsonl'),'utf8')).trim().split('\n').map(JSON.parse)
      assert.ok(mutation.length > 0 && mutation.every(record => record.mutant === mode))
    }
    runs.push({mode, ...run}); console.log(JSON.stringify({mode,pass:green,assertionRed:!green,evidence:directory}))
  }
  const { build } = await import(pathToFileURL(require.resolve('vite')).href)
  const compiled = path.join(owned, 'compiled')
  await build({configFile:false, root:fixture, base:'./', logLevel:'error', worker:{format:'es'}, resolve:{alias:aliases}, define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},
    plugins:[{name:'bind-actual-settings-product-inputs',enforce:'pre',async transform(code,id){const file=id.split('?')[0];if(file.startsWith(root+'/')&&!file.includes('/node_modules/'))await bind(file)}}],
    css:{postcss:{plugins:[{postcssPlugin:'bind-actual-settings-css',async OnceExit(css){const files=new Set();css.walk(n=>{if(n.source?.input?.file)files.add(n.source.input.file)});for(const file of files)if(file.startsWith(root+'/')&&!file.includes('/node_modules/'))await bind(file)}}]}},
    build:{target:'esnext',outDir:compiled,emptyOutDir:true}})
  await fs.cp(compiled,path.join(evidence,'compiled'),{recursive:true})
  const frames = path.join(evidence, 'visual'); await fs.mkdir(frames)
  const stderr=[]
  const capture=await runProbeProcess(require('electron'),[path.join(fixture,'main.cjs'),path.join(compiled,'index.html'),owned,frames],{cwd:root,temporaryRoot:owned,env,timeoutMs:90000,onLine:line=>stderr.push(line)})
  await fs.writeFile(path.join(frames,'stderr.log'),stderr.join('\n'))
  const render=JSON.parse(await fs.readFile(path.join(frames,'render.json'),'utf8'))
  assert.equal(capture.exitCode,0,render.failure?.message)
  assert.equal(render.passed,true)
  assert.ok(render.frames.length >= 10)
  // Source-derived external product consumers, never a hand-maintained list of exports.
  const ts=require('typescript'), callers=[]
  for(const file of ['components/SettingsPanel.tsx','components/settings/modules/agents.tsx','components/settings/modules/prompts.tsx','App.tsx']) {
    const actual=path.join(root,'apps/desktop/src/renderer/src',file), source=await fs.readFile(actual,'utf8')
    const tree=ts.createSourceFile(actual,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
    function visit(node){if((ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node))&&['SettingsPanel','AgentSettingsPane','ShortcutSettingsPane'].includes(node.tagName.getText(tree)))callers.push({file,symbol:node.tagName.getText(tree)});ts.forEachChild(node,visit)}visit(tree)
  }
  assert.ok(callers.some(x=>x.symbol==='SettingsPanel')&&callers.some(x=>x.symbol==='AgentSettingsPane')&&callers.some(x=>x.symbol==='ShortcutSettingsPane'))
  assert.ok(inputs.size>0)
  const relevant = [...inputs].filter(([file]) => /(?:components\/settings\/|components\/SettingsPanel|styles\/settings|styles\/surfaces|styles\/(?:agent|tokens|base|native-controls|selection-field|index)\.css|shared\/config-edit|lib\/api\.ts|settings-reference|settings-executor-creation|settings-resource-library|settings-prompt-workbench|settings-prompts-|shared\/composer-shortcut|client-ui\/src\/(?:input|theme|ime))/.test(file))
  for(const [file,digest]of relevant)assert.equal(hash(await fs.readFile(file)),digest,'Changed Settings proof input')
  const receipt={passed:true,captureOnly:true,aestheticReview:'not-performed',typecheck,testEvidence:visualOnly?'not-run':'passed-with-mutations',runs,render,callers,inputs:Object.fromEntries(relevant.map(([file,digest])=>[path.relative(root,file),digest])),boundary:render.boundary}
  await fs.writeFile(path.join(evidence,'receipt.json'),JSON.stringify(receipt,null,2))
  await fs.writeFile(path.join(root,'.tmp/settings-reference/latest.json'),JSON.stringify({evidence,receipt:path.join(evidence,'receipt.json')},null,2))
  console.log(JSON.stringify({passed:true,evidence,frames:render.frames.length,inputs:inputs.size}))
}finally{assert.deepEqual(await listProbeProcesses(-1,owned),[]);await fs.rm(owned,{recursive:true,force:true})}
