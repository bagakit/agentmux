import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
import { root, desktopRequire as require, aliases } from './fixtures/settings-resource-library/environment.mjs'

const fixture = path.join(root,'apps/desktop/scripts/fixtures/settings-home')
const conceptIntros = process.argv.includes('--concept-intros')
const conceptIntroMutant = process.argv.includes('--concept-intro-mutation')
assert.ok(!conceptIntroMutant || conceptIntros, 'The concept mutation requires its bounded scenario')
const evidenceRoot = path.join(root,conceptIntros?'.tmp/settings-companion-intros':'.tmp/settings-home')
const evidence = path.join(evidenceRoot,'run-'+randomUUID())
const owned = await fs.mkdtemp(path.join(os.tmpdir(),'amux-settings-home-'))
const env = {...process.env,TMPDIR:owned,TEMP:owned,TMP:owned}; delete env.ELECTRON_RUN_AS_NODE
const inputs = new Map(), runs = []
const navigationMutant = process.argv.includes('--navigation-mutation')
const providerMutant = process.argv.includes('--provider-scroll-mutation')
const takeoverMutant = process.argv.includes('--takeover-scroll-mutation')
const appearanceMutant = process.argv.includes('--appearance-contrast-mutation')
const previewReturnMutant = process.argv.includes('--preview-return-mutation')
const larkNavigationMutant = process.argv.includes('--lark-navigation-mutation')
const focusContentMutant = process.argv.includes('--focus-content-mutation')
const toolkitModelMutant = process.argv.includes('--toolkit-model-mutation')
assert.ok([navigationMutant,providerMutant,takeoverMutant,appearanceMutant,previewReturnMutant,larkNavigationMutant,focusContentMutant,toolkitModelMutant,conceptIntroMutant].filter(Boolean).length<=1,'One native source mutation per receipt')
const nativeMutant = conceptIntroMutant || navigationMutant || providerMutant || takeoverMutant || appearanceMutant || previewReturnMutant || larkNavigationMutant || focusContentMutant || toolkitModelMutant
const pageArguments = process.argv.filter(argument => argument.startsWith('--pages='))
assert.ok(pageArguments.length <= 1, 'One explicit page selection')
const requestedPages = pageArguments.length ? pageArguments[0].slice('--pages='.length).split(',') : conceptIntros ? ['capsule','goals'] : null
if (conceptIntros) assert.deepEqual([...requestedPages].sort(),['capsule','goals'],'Concept scope is exactly Capsule and Goals')
if (requestedPages) {
  assert.ok(requestedPages.every(Boolean), 'Page selection is nonempty')
  assert.equal(new Set(requestedPages).size, requestedPages.length, 'Page selection contains no duplicate')
}
let navigationMutationLoads = 0, providerMutationLoads = 0, takeoverMutationLoads = 0, appearanceMutationLoads = 0
let previewReturnMutationLoads = 0, larkNavigationMutationLoads = 0
let toolkitModelMutationLoads = 0, conceptIntroMutationLoads = 0
let conceptIntroMutationReceipt = null
let focusContentMutationLoads = 0
const focusContentMutationOwners = new Set()
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
  for (const file of ['index.html','entry.mjs','lark-preview.ts','main.cjs','vitest.config.mts','scenario.md']) await bind(path.join(fixture,file))
  for (const file of ['apps/desktop/scripts/verify-settings-home.mjs','apps/desktop/test/settings-home.test.tsx','apps/desktop/test/settings-overview.test.tsx']) await bind(path.join(root,file))
  await bind(path.join(root,'apps/desktop/resources/icon-512.png'))
  for (const mode of process.argv.includes('--visual-only') || conceptIntros || nativeMutant ? [] : ['baseline','expanded','disclosure','entry','drafts','exact','destination','restored']) {
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
    plugins:[{name:'bind-settings-home-product',enforce:'pre',async resolveId(specifier){
      if (!conceptIntros || !specifier.startsWith('@agentmux/host/')) return
      const manifestFile=path.join(root,'apps/host/package.json'); await bind(manifestFile)
      const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'))
      const entry=manifest.exports['./'+specifier.slice('@agentmux/host/'.length)]
      assert.ok(entry,'The current Host public export exists: '+specifier)
      const target=typeof entry==='string'?entry:entry.import
      return path.join(root,'apps/host',target.replace('./dist/','./src/').replace(/\.js$/u,'.ts'))
    },async transform(code,id){
      const file=id.split('?')[0]
      if(file.startsWith(root+'/')&&!file.includes('/node_modules/'))await bind(file)
      if(conceptIntroMutant&&file.endsWith('/components/settings/CapsuleSettingsPane.tsx')) {
        const anchor='<CapsuleIntroduction />'
        assert.equal(code.split(anchor).length,2,'One original Capsule introduction consumer')
        const mutated=code.replace(anchor,'{null}')
        conceptIntroMutationLoads++
        conceptIntroMutationReceipt={file:path.relative(root,file),original:sha(code),consumed:sha(mutated),change:'Remove the original Capsule introduction consumer'}
        await fs.writeFile(path.join(evidence,'concept-intro-mutation.json'),JSON.stringify(conceptIntroMutationReceipt,null,2))
        return {code:mutated,map:null}
      }
      if(file.endsWith('/components/settings/ToolkitScriptEditor.tsx')) {
        const original = code
        const stable = "${display ? '/display' : actionId === null ? '/main' : `/actions/${encodeURIComponent(actionId)}`}"
        if(toolkitModelMutant) {
          assert.equal(code.split(stable).length,2,'One original Toolkit document identity')
          code=code.replace(stable,"${display ? '/display' : actionId === null ? '' : `/actions/${encodeURIComponent(actionId)}`}.${mode === 'tui' ? 'sh' : 'mjs'}")
          toolkitModelMutationLoads++
        }
        const theme = '  const theme = useMonacoTheme()'
        assert.equal(code.split(theme).length,2,'One committed Toolkit draft observer')
        code="import { useLayoutEffect } from 'react'\n"+code.replace(theme,theme+"\n  useLayoutEffect(() => { window.settingsHomeProbe.toolkitDraft = { id, actionId, display, mode, value } }, [id, actionId, display, mode, value])")
        const editor = '<Editor height="260px"'
        assert.equal(code.split(editor).length,2,'One actual Toolkit Monaco consumer')
        code=code.replace(editor,editor+' onMount={editor => { window.settingsHomeProbe.toolkitEditor = { value: () => editor.getValue(), uri: () => editor.getModel()?.uri.toString(), node: () => editor.getDomNode(), focused: () => editor.hasTextFocus(), selectedAll: () => { const range=editor.getModel()?.getFullModelRange(), selection=editor.getSelection(); return !!range && !!selection && range.startLineNumber===selection.startLineNumber && range.startColumn===selection.startColumn && range.endLineNumber===selection.endLineNumber && range.endColumn===selection.endColumn } } }}')
        await fs.writeFile(path.join(evidence,'toolkit-model-observation.json'),JSON.stringify({file:path.relative(root,file),original:sha(original),consumed:sha(code),mutant:toolkitModelMutant,observation:'Committed props and exact original Monaco model; no writes'},null,2))
        return {code,map:null}
      }
      if(larkNavigationMutant&&file.endsWith('/components/settings/useConnectionManagementSetup.ts')) {
        const start=code.indexOf('  function inspectOriginal('),end=code.indexOf('  function inspect()',start)
        assert.ok(start>=0&&end>start,'Exact original setup inspection owner is present')
        const owner=code.slice(start,end),anchor="source('connection.setup.inspect',"
        assert.equal(owner.split(anchor).length,2,'One local original inspection dispatch')
        const mutated=code.slice(0,start)+owner.replace(anchor,"source('connection.setup.advance',")+code.slice(end)
        larkNavigationMutationLoads++
        await fs.writeFile(path.join(evidence,'lark-navigation-mutant.ts'),mutated)
        await fs.writeFile(path.join(evidence,'lark-navigation-mutation.json'),JSON.stringify({file:path.relative(root,file),original:sha(code),consumed:sha(mutated),owner:'inspectOriginal',change:'inspect becomes advance'},null,2))
        return {code:mutated,map:null}
      }
      if(previewReturnMutant&&file.endsWith('/components/settings/use-settings-preview-return.tsx')) {
        const anchor='previous.pane.scrollTop = previous.scrollTop'
        assert.equal(code.split(anchor).length,2,'One actual preview return scroll owner')
        previewReturnMutationLoads++
        const mutated=code.replace(anchor,'previous.pane.scrollTop = 0')
        await fs.writeFile(path.join(evidence,'preview-return-mutant.tsx'),mutated)
        return {code:mutated,map:null}
      }
      if(appearanceMutant&&file.endsWith('/components/settings/AppearanceSettingsPane.tsx')) {
        const anchor='background: theme.selectionBackground, color: theme.selectionForeground ?? theme.foreground'
        assert.equal(code.split(anchor).length,2,'One actual terminal sample color pair')
        appearanceMutationLoads++
        const mutated=code.replace(anchor,'background: theme.black, color: theme.foreground')
        await fs.writeFile(path.join(evidence,'appearance-mutant.tsx'),mutated)
        return {code:mutated,map:null}
      }
      if(providerMutant&&file.endsWith('/components/settings/SettingsResourceLibrary.tsx')) {
        const anchor='left: direction * list.current.clientWidth * .75'
        assert.equal(code.split(anchor).length,2,'One actual provider scroll control')
        providerMutationLoads++
        const mutated=code.replace(anchor,'left: 0')
        await fs.writeFile(path.join(evidence,'provider-mutant.tsx'),mutated)
        return {code:mutated,map:null}
      }
      if(navigationMutant&&file.endsWith('/components/settings/SettingsSidebarNavigation.tsx')) {
        const anchor="key={[...expanded].sort().join(' ')}"
        assert.equal(code.split(anchor).length,2,'One actual navigation geometry rebind')
        navigationMutationLoads++
        const mutated=code.replace(anchor,'key="fixed"')
        await fs.writeFile(path.join(evidence,'navigation-mutant.tsx'),mutated)
        return {code:mutated,map:null}
      }
    }}],
    css:{postcss:{plugins:[{postcssPlugin:'bind-settings-home-css',async OnceExit(css){
      const files=new Set();css.walk(node=>{if(node.source?.input?.file)files.add(node.source.input.file)})
      for(const file of files)if(file.startsWith(root+'/')&&!file.includes('/node_modules/'))await bind(file)
      const before=takeoverMutationLoads
      if(focusContentMutant) css.walkDecls('height',declaration=>{
        if(!declaration.source?.input?.file?.endsWith('/styles/settings-focus.css')||declaration.value!=='auto'||!declaration.parent.selector.includes("[data-scene='links']"))return
        focusContentMutationOwners.add(declaration.source.input.file+':'+declaration.source.start.line+':'+declaration.source.start.column)
        focusContentMutationLoads++;declaration.value='370px'
      })
      if(focusContentMutationLoads) await fs.writeFile(path.join(evidence,'focus-content-mutant.css'),css.toString())
      if(takeoverMutant) css.walkDecls('position',declaration=>{
        if(!declaration.source?.input?.file?.endsWith('/components/settings/agent-takeover-settings.css')||declaration.value!=='static'||declaration.parent?.parent?.name!=='container'||declaration.parent.parent.params!=='agent-control-settings (max-width: 639px)')return
        assert.equal(declaration.parent.selector,'.browser-agent-control-settings .browser-agent-preview','Exact compact preview owner')
        takeoverMutationLoads++;declaration.value='sticky'
      })
      if(takeoverMutationLoads>before) await fs.writeFile(path.join(evidence,'takeover-mutant.css'),css.toString())
    }}]}},
    build:{target:'esnext',outDir:compiled,emptyOutDir:true,minify:false}})
  await fs.cp(compiled,path.join(evidence,'compiled'),{recursive:true})
  const visual = path.join(evidence,'visual'), stderr=[]
  await fs.mkdir(visual)
  if(takeoverMutant) assert.equal(takeoverMutationLoads,1,'One exact compact preview declaration is mutated')
  const capture = await runProbeProcess(require('electron'),[path.join(fixture,'main.cjs'),path.join(compiled,'index.html'),owned,visual,conceptIntros?'concept-intros':toolkitModelMutant?'toolkit-model':focusContentMutant?'focus-content':larkNavigationMutant?'lark-navigation':previewReturnMutant?'preview-return':navigationMutant?'navigation':providerMutant?'provider-scroll':takeoverMutant?'takeover-scroll':'full',requestedPages?.join(',')??''],{
    cwd:root,env,timeoutMs:1200000,onLine:line=>stderr.push(line)
  })
  await fs.writeFile(path.join(visual,'stderr.log'),stderr.join('\n'))
  const render = JSON.parse(await fs.readFile(path.join(visual,'render.json'),'utf8'))
  assert.equal(capture.timedOut,false)
  if (conceptIntroMutant) {
    assert.equal(conceptIntroMutationLoads,1,'The actual introduction consumer mutation is loaded once')
    assert.equal(capture.exitCode,1)
    assert.equal(render.failure?.name,'AssertionError')
    assert.match(render.failure.message,/The production Capsule introduction is present in its original pane/u,'The real missing introduction assertion kills its consumer mutation')
  } else if (toolkitModelMutant) {
    assert.equal(toolkitModelMutationLoads,1,'One actual Toolkit document owner was reverted')
    assert.equal(capture.exitCode,1)
    assert.equal(render.failure?.name,'AssertionError')
    assert.match(render.failure.message,/Changing the type preserves the command draft until explicitly edited|The original settings draft receives the complete editor text/u,'The original editor roundtrip kills its model mutation')
  } else if (focusContentMutant) {
    assert.equal(focusContentMutationOwners.size,1,'One original content-sized canvas rule was mutated across its CSS bundle copies')
    assert.ok(focusContentMutationLoads>0,'The original content-sized canvas mutation was consumed')
    assert.equal(capture.exitCode,1)
    assert.equal(render.failure?.name,'AssertionError')
    assert.match(render.failure.message,/Focus short examples fit their content/u,'Real content geometry kills the original CSS mutant')
  } else if (larkNavigationMutant) {
    assert.equal(larkNavigationMutationLoads,1,'The actual Lark inspection owner mutant was consumed once')
    assert.equal(capture.exitCode,1)
    assert.equal(render.failure?.name,'AssertionError')
    assert.match(render.failure.message,/Lark navigation preserves a read-only connector boundary/u,'Actual navigation, not fixture startup, kills the owner mutant')
  } else if (previewReturnMutant) {
    assert.equal(previewReturnMutationLoads,1,'The actual preview return mutant was consumed once')
    assert.equal(capture.exitCode,1)
    assert.equal(render.failure?.name,'AssertionError')
    assert.match(render.failure.message,/Preview return restores original reading position/u,'Native behavior, not fixture startup, kills the mutant')
  } else if (appearanceMutant) {
    assert.equal(appearanceMutationLoads,1,'The actual terminal sample mutant was consumed once')
    assert.equal(capture.exitCode,1)
    assert.equal(render.failure?.name,'AssertionError')
    assert.match(render.failure.message,/Workspace terminal sample text keeps readable contrast/u)
  } else if (takeoverMutant) {
    assert.equal(capture.exitCode,1)
    assert.equal(render.failure?.name,'AssertionError')
    assert.match(render.failure.message,/Compact takeover preview (does not cover|leaves) the original fine tuning control/u)
  } else if (providerMutant) {
    assert.equal(providerMutationLoads,1)
    assert.equal(capture.exitCode,1)
    assert.equal(render.failure?.name,'AssertionError')
    assert.match(render.failure.message,/Provider forward control reveals more entries/u)
  } else if (navigationMutant) {
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
    for(const id of render.scope.resolved.filter(id=>id!=='overview')) {
      assert.ok(render.interactions.some(event=>event.kind==='page-interactions-complete'&&event.page===id&&event.actions>0&&event.implicitSaves===0),'Every selected original page consumes input without an implicit save: '+id)
      for(const theme of ['dark','light']) assert.ok(render.frames.some(frame=>frame.page===id&&frame.theme===theme&&frame.file===`page-${id}-compact-${theme}.png`),'Every selected page has both compact themes: '+id)
    }
    if(render.scope.resolved.includes('lark')) {
      assert.ok(render.lark.calls.some(call=>call.method==='connection.setup.inspect'),'Lark consumes its actual original Setup path')
      assert.ok(render.interactions.some(event=>event.kind==='lark-read-only-navigation'&&event.calls>0&&event.implicitConnectorWrites===0))
      assert.ok(render.interactions.some(event=>event.kind==='lark-explicit-actions'&&event.serviceSaves===1&&event.botSaves===1&&event.permissionRequests===1&&event.versionCreations===1))
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
  const receipt={passed:true,captureOnly:!nativeMutant,aestheticReview:'not-performed',assertionRed:nativeMutant,testEvidence:runs.length?'passed-with-owning-mutations':nativeMutant?'native-control-assertion-red':'not-run',
    runs,capture,render,callers,conceptIntroMutation:conceptIntroMutationReceipt,inputs:Object.fromEntries(relevant.map(([file,digest])=>[path.relative(root,file),digest])),boundary:render.boundary}
  await fs.writeFile(path.join(evidence,'receipt.json'),JSON.stringify(receipt,null,2))
  await fs.writeFile(path.join(evidence,'review.md'),['# Settings Home visual review','',render.boundary,'',
    nativeMutant ? 'The owning mutation failed the expected native behavior assertion. This does not establish aesthetic approval.' : 'Capture succeeded; independent aesthetic review is still required. Read every complete frame before ranking the pages.','',
    '| Page | Theme | Position | Screenshot |','| --- | --- | --- | --- |',
    ...render.frames.map(frame=>`| ${frame.page} | ${frame.theme} | ${frame.position} | [${frame.file}](visual/${frame.file}) |`),''].join('\n'))
  if (!nativeMutant || conceptIntros) await fs.writeFile(path.join(evidenceRoot,nativeMutant?'latest-mutant.json':'latest.json'),JSON.stringify({evidence,receipt:path.join(evidence,'receipt.json')},null,2))
  console.log(JSON.stringify({passed:true,assertionRed:nativeMutant,evidence,pages:render.scope?.resolved.length??render.catalog.length+1,frames:render.frames.length,aestheticReview:'not-performed'}))
} finally {
  assert.deepEqual(await listProbeProcesses(-1,owned),[],'Owned private Renderer processes have exited')
  await fs.rm(owned,{recursive:true,force:true})
}
