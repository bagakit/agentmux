import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
import { root, desktopRequire as require, aliases } from './fixtures/settings-resource-library/environment.mjs'

const fixture = path.join(root,'apps/desktop/scripts/fixtures/settings-home')
const evidence = path.join(root,'.tmp/settings-home','run-'+randomUUID())
const owned = await fs.mkdtemp(path.join(os.tmpdir(),'amux-settings-home-'))
const env = {...process.env,TMPDIR:owned,TEMP:owned,TMP:owned}; delete env.ELECTRON_RUN_AS_NODE
const inputs = new Map(), runs = []
const navigationMutant = process.argv.includes('--navigation-mutation')
const pageArguments = process.argv.filter(argument => argument.startsWith('--pages='))
assert.ok(pageArguments.length <= 1, 'One explicit page selection')
const requestedPages = pageArguments.length ? pageArguments[0].slice('--pages='.length).split(',') : null
if (requestedPages) {
  assert.ok(requestedPages.every(Boolean), 'Page selection is nonempty')
  assert.equal(new Set(requestedPages).size, requestedPages.length, 'Page selection contains no duplicate')
}
let navigationMutationLoads = 0
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
await fs.mkdir(evidence,{recursive:true})
async function bind(file) {
  const bytes = await fs.readFile(file), digest = sha(bytes)
  if (inputs.has(file)) assert.equal(inputs.get(file),digest,'Actual proof input unchanged: '+path.relative(root,file))
  else {
    inputs.set(file,digest)
    const target = path.join(evidence,'source',path.relative(root,file))
    await fs.mkdir(path.dirname(target),{recursive:true}); await fs.writeFile(target,bytes)
  }
}
try {
  for (const file of ['index.html','entry.mjs','main.cjs','vitest.config.mts','scenario.md']) await bind(path.join(fixture,file))
  for (const file of ['apps/desktop/scripts/verify-settings-home.mjs','apps/desktop/test/settings-home.test.tsx','apps/desktop/test/settings-overview.test.tsx']) await bind(path.join(root,file))
  for (const mode of process.argv.includes('--visual-only') || navigationMutant ? [] : ['baseline','expanded','entry','drafts','exact','destination','restored']) {
    const directory = path.join(evidence,mode), temporary = path.join(owned,mode), output = []
    await fs.mkdir(directory)
    await fs.mkdir(temporary)
    const green = mode==='baseline'||mode==='restored'
    const execution = await runProbeProcess(process.execPath,[require.resolve('vitest/vitest.mjs'),'run','--config',path.join(fixture,'vitest.config.mts')],{
      cwd:root,env:{...env,TMPDIR:temporary,TEMP:temporary,TMP:temporary,AGENTMUX_SETTINGS_HOME_EVIDENCE:directory,...(green?{}:{AGENTMUX_SETTINGS_HOME_MUTANT:mode})},
      timeoutMs:90000,onLine:line=>output.push(line)
    })
    await fs.writeFile(path.join(directory,'test.log'),output.join('\n'))
    assert.equal(execution.timedOut,false,'Test termination must not masquerade as a mutation failure')
    if (green) assert.equal(execution.exitCode,0,output.join('\n'))
    else {
      assert.notEqual(execution.exitCode,0)
      assert.match(output.join('\n'),/AssertionError|expected .*to /u,'The owning mutation fails a behavioral assertion')
      const mutations = (await fs.readFile(path.join(directory,'mutation.jsonl'),'utf8')).trim().split('\n').map(JSON.parse)
      assert.equal(mutations.length,1,'The owning source mutation is consumed once')
      assert.equal(mutations[0].mutant,mode)
      assert.notEqual(mutations[0].original,mutations[0].consumed)
    }
    runs.push({mode,...execution}); console.log(JSON.stringify({mode,passed:green,assertionRed:!green,evidence:directory}))
    assert.deepEqual(await listProbeProcesses(-1,temporary),[],'This completed test left no owned worker')
    await fs.rm(temporary,{recursive:true,force:true})
  }
  const { build } = await import(pathToFileURL(require.resolve('vite')).href)
  const compiled = path.join(owned,'compiled')
  await build({configFile:false,root:fixture,base:'./',logLevel:'error',worker:{format:'es'},resolve:{alias:aliases},
    define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},
    plugins:[{name:'bind-settings-home-product',enforce:'pre',async transform(code,id){
      const file=id.split('?')[0]
      if(file.startsWith(root+'/')&&!file.includes('/node_modules/'))await bind(file)
      if(navigationMutant&&file.endsWith('/components/settings/SettingsSidebarNavigation.tsx')) {
        const anchor="key={[...expanded].sort().join(' ')}"
        assert.equal(code.split(anchor).length,2,'One actual navigation geometry rebind')
        navigationMutationLoads++
        const mutated=code.replace(anchor,'key="fixed"')
        await fs.writeFile(path.join(evidence,'navigation-mutant.tsx'),mutated)
        return {code:mutated,map:null}
      }
    }}],
    css:{postcss:{plugins:[{postcssPlugin:'bind-settings-home-css',async OnceExit(css){const files=new Set();css.walk(node=>{if(node.source?.input?.file)files.add(node.source.input.file)});for(const file of files)if(file.startsWith(root+'/')&&!file.includes('/node_modules/'))await bind(file)}}]}},
    build:{target:'esnext',outDir:compiled,emptyOutDir:true,minify:false}})
  await fs.cp(compiled,path.join(evidence,'compiled'),{recursive:true})
  const visual = path.join(evidence,'visual'), stderr=[]
  await fs.mkdir(visual)
  const capture = await runProbeProcess(require('electron'),[path.join(fixture,'main.cjs'),path.join(compiled,'index.html'),owned,visual,navigationMutant?'navigation':'full',requestedPages?.join(',')??''],{
    cwd:root,env,timeoutMs:180000,onLine:line=>stderr.push(line)
  })
  await fs.writeFile(path.join(visual,'stderr.log'),stderr.join('\n'))
  const render = JSON.parse(await fs.readFile(path.join(visual,'render.json'),'utf8'))
  assert.equal(capture.timedOut,false)
  if (navigationMutant) {
    assert.equal(navigationMutationLoads,1,'The actual navigation mutant was consumed once')
    assert.equal(capture.exitCode,1)
    assert.equal(render.failure?.name,'AssertionError')
    assert.match(render.failure.message,/Current selection surface follows disclosure geometry/u,'Native geometry, not fixture startup, kills the mutant')
  } else {
    assert.equal(capture.exitCode,0,render.failure?.message)
    assert.equal(render.passed,true,render.failure?.message)
    assert.ok(render.catalog.length>0)
    assert.ok(render.scope.resolved.length > 0)
    for (const entry of render.catalog.filter(entry=>render.scope.resolved.includes(entry.id))) for (const theme of ['dark','light']) {
      assert.ok(render.frames.some(frame=>frame.page===entry.id&&frame.theme===theme&&frame.position==='top'),'Every actual page is captured in both themes: '+entry.id)
    }
  }
  const ts=require('typescript'), callers=[]
  for (const [file,symbol] of [['App.tsx','SettingsPanel'],['components/SettingsPanel.tsx','SettingsOverviewPane'],['components/SettingsPanel.tsx','SettingsSearchResults']]) {
    const actual=path.join(root,'apps/desktop/src/renderer/src',file), source=await fs.readFile(actual,'utf8')
    const tree=ts.createSourceFile(actual,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX), found=[]
    function visit(node){if((ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node))&&node.tagName.getText(tree)===symbol)found.push(node);ts.forEachChild(node,visit)}visit(tree)
    assert.ok(found.length>0,'Actual definition-excluded product consumer: '+symbol)
    callers.push(...found.map(node=>({file,symbol,line:tree.getLineAndCharacterOfPosition(node.getStart()).line+1})))
  }
  const relevant = [...inputs]
  assert.ok(relevant.length>0)
  for (const [file,digest] of relevant) assert.equal(sha(await fs.readFile(file)),digest,'Changed candidate source: '+path.relative(root,file))
  const receipt={passed:true,captureOnly:!navigationMutant,aestheticReview:'not-performed',assertionRed:navigationMutant,testEvidence:runs.length?'passed-with-owning-mutations':navigationMutant?'native-navigation-assertion-red':'not-run',
    runs,capture,render,callers,inputs:Object.fromEntries(relevant.map(([file,digest])=>[path.relative(root,file),digest])),boundary:render.boundary}
  await fs.writeFile(path.join(evidence,'receipt.json'),JSON.stringify(receipt,null,2))
  await fs.writeFile(path.join(evidence,'review.md'),['# Settings Home visual review','',render.boundary,'',
    navigationMutant ? 'The owning mutation failed the expected native geometry assertion. This does not establish aesthetic approval.' : 'Capture succeeded; independent aesthetic review is still required. Read every complete frame before ranking the pages.','',
    '| Page | Theme | Position | Screenshot |','| --- | --- | --- | --- |',
    ...render.frames.map(frame=>`| ${frame.page} | ${frame.theme} | ${frame.position} | [${frame.file}](visual/${frame.file}) |`),''].join('\n'))
  if (!navigationMutant) await fs.writeFile(path.join(root,'.tmp/settings-home/latest.json'),JSON.stringify({evidence,receipt:path.join(evidence,'receipt.json')},null,2))
  console.log(JSON.stringify({passed:true,assertionRed:navigationMutant,evidence,pages:render.scope?.resolved.length??render.catalog.length+1,frames:render.frames.length,aestheticReview:'not-performed'}))
} finally {
  assert.deepEqual(await listProbeProcesses(-1,owned),[],'Owned private Renderer processes have exited')
  await fs.rm(owned,{recursive:true,force:true})
}
