import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { isBuiltin } from 'node:module'
import { pathToFileURL } from 'node:url'

export async function capturePerformancePanel({ root, evidence, captureScope = 'full', cssMutant = 'baseline' }) {
  assert.ok(['full','placement','buttons'].includes(captureScope),'已知明确 capture scope')
  assert.ok(['baseline','state','focus'].includes(cssMutant)&& (captureScope==='buttons'||cssMutant==='baseline'),'明确有界私有CSS变异')
  const desktop=path.join(root,'apps/desktop'),fixture=path.join(desktop,'scripts/fixtures/performance-panel')
  const require=createRequire(path.join(desktop,'package.json')),sha=bytes=>createHash('sha256').update(bytes).digest('hex')
  const {build,loadConfigFromFile}=await import(pathToFileURL(require.resolve('vite')).href)
  const viteRequire=createRequire(require.resolve('vite')),esbuild=viteRequire('esbuild').build
  const {runProbeProcess,listProbeProcesses}=await import(pathToFileURL(path.join(desktop,'scripts/probe-process.mjs')).href)
  const configFile=path.join(desktop,'scripts/fixtures/settings-overview/vitest.config.mts')
  const {config}=await loadConfigFromFile({command:'build',mode:'production'},configFile,root)
  const privateRoot=await fs.mkdtemp(path.join(os.tmpdir(),'amx-performance-ui-'))
  await fs.mkdir(evidence,{recursive:true})
  const compiled=path.join(evidence,'compiled'),inputs=new Map(),artifacts=[],cssInputs=[]
  const receipt={schema:'agentmux.performance-ui-native.v1',completed:false,captureScope,cssMutant,evidence,privateRoot,processes:[],frames:[],
    actualApp:true,actualSettings:true,actualTerminalView:true,contextIsolation:true,officialOwnerQualification:false,aestheticReview:'not-performed',
    boundary:'Actual mounted product Renderer, original TerminalView input handler, ConfigOwner/ConfigStore and product isolated preload/registered Toolkit IPC. Explicit controlled Metrics DTO port and original preview Session facts; not official Toolkit CLI/Native execution or user performance.'}
  const bind=async file=>{const bytes=await fs.readFile(file),key=path.relative(root,file);if(inputs.has(key))assert.equal(sha(inputs.get(key)),sha(bytes),'实际输入构建漂移: '+key);else inputs.set(key,bytes);return bytes}
  try {
    for(const file of [configFile,path.join(root,'package.json'),path.join(root,'pnpm-lock.yaml'),path.join(desktop,'package.json'),path.join(desktop,'scripts/probe-process.mjs'),
      ...['capture.mjs','entry.tsx','main.cjs','preload.cjs','owner-entry.ts','index.html','data.ts'].map(file=>path.join(fixture,file))])await bind(file)
    const aliases=new Map()
    for(const name of ['core','demand','layout']){
      const dir=path.join(root,'packages',name),pkg=JSON.parse(await bind(path.join(dir,'package.json')))
      for(const [key,value]of Object.entries(pkg.exports)){
        const target=typeof value==='string'?value:value.import
        aliases.set('@agentmux/'+name+(key==='.'?'':key.slice(1)),path.join(dir,target.replace('./dist/src/','./src/').replace('./dist/','./src/').replace(/\.js$/u,'.ts')))
      }
    }
    const asset=path.join(desktop,'resources/toolkit/performance.mjs');await bind(asset)
    // Vite 的 CSS @import 由 PostCSS 内部读取，不经过 JS transform。显式绑定真实层叠输入。
    const styles=path.join(desktop,'src/renderer/src/styles/index.css'),css=(await bind(styles)).toString()
    const imports=[...css.matchAll(/^\s*@import\s+['"]([^'"]+)['"];\s*$/gm)]
    assert.ok(imports.length>0,'实际CSS入口引用非空')
    assert.equal(imports.length,(css.match(/^\s*@import\s/gm)??[]).length,'所有实际CSS imports均绑定，不静默跳过')
    for(const [,relative]of imports)await bind(path.resolve(path.dirname(styles),relative))
    const vendor=path.join(root,'packages/core/vendor')
    await fs.symlink(vendor,path.join(evidence,'vendor'),'dir')
    const artifactRoot=path.join(vendor,'ctxmux',`${process.platform}-${process.arch}`)
    const manifest=JSON.parse((await bind(path.join(artifactRoot,'manifest.json'))).toString())
    for(const descriptor of [manifest.sdk.archive,...manifest.binaries])await bind(path.join(artifactRoot,descriptor.path))
    await fs.mkdir(compiled,{recursive:true})
    await fs.symlink(path.join(desktop,'node_modules'),path.join(compiled,'node_modules'),'dir')
    for(const [entry,outfile,format]of [
      [path.join(desktop,'src/preload/index.ts'),path.join(compiled,'product-preload.cjs'),'cjs'],
      [path.join(fixture,'preload.cjs'),path.join(compiled,'fixture-preload.cjs'),'cjs'],
      [path.join(fixture,'owner-entry.ts'),path.join(compiled,'owner.mjs'),'esm'],
      [path.join(root,'packages/core/src/agentmux.ts'),path.join(compiled,'agentmux.mjs'),'esm']
    ])await esbuild({entryPoints:[entry],outfile,bundle:true,platform:'node',format,target:'node24',packages:'external',logLevel:'error',
      plugins:[{name:'bind-product-node-source',setup(builder){
        builder.onResolve({filter:/^@agentmux\//},args=>aliases.has(args.path)?{path:aliases.get(args.path)}:undefined)
        builder.onResolve({filter:/^[^./]/},args=>{
          if(args.path==='electron'||isBuiltin(args.path)||aliases.has(args.path))return
          if(args.path==='@ctxmux/sdk')return {path:path.join(root,'packages/core/node_modules/@ctxmux/sdk/dist/index.js'),external:true}
          return {path:require.resolve(args.path,{paths:[path.dirname(args.importer),desktop,path.join(root,'packages/core')]}),external:true}
        })
        builder.onLoad({filter:/\.[cm]?tsx?$/},async args=>{
          if(!args.path.startsWith(root+'/apps/')&&!args.path.startsWith(root+'/packages/'))return
          const bytes=await bind(args.path);return{contents:bytes.toString(),loader:args.path.endsWith('tsx')?'tsx':'ts'}
        })
      }}]})
    const cssRules=[
      ['agent.css',".surface-navigation button.surface-navigation__slot:not(.surface-navigation__slot--launcher):is([aria-current='page'], [aria-expanded='true'])",'background','state'],
      ['agent.css','.surface-navigation button.surface-navigation__slot:not(.surface-navigation__slot--launcher):focus-visible, .window-status-bar__utilities > .window-status-bar__utility-button:focus-visible','outline','focus'],
      ['performance-toolkit.css','.performance-trigger[aria-expanded=true]','background','state'],
      ['performance-toolkit.css','.performance-trigger:focus-visible','outline','focus']]
    const cssPlugin={postcssPlugin:'bind-performance-button-owning-css',OnceExit(sheet){
      sheet.walkRules(rule=>{
        const matched=cssRules.find(([file,selector])=>rule.source?.input.file===path.join(desktop,'src/renderer/src/styles',file)&&rule.selector===selector)
        if(!matched)return
        const [file,selector,property,kind]=matched,originalRule=rule.toString(),declarations=rule.nodes.filter(node=>node.type==='decl'&&node.prop===property)
        assert.equal(declarations.length,1,'唯一非空owning CSS属性: '+selector)
        if(cssMutant===kind)declarations[0].value=kind==='state'?'transparent':'none'
        assert.ok(!cssInputs.some(item=>item.selector===selector),'实际owning CSS规则只消费一次: '+selector)
        cssInputs.push({path:'apps/desktop/src/renderer/src/styles/'+file,selector,property,kind,originalRule,consumedRule:rule.toString(),
          originalSHA256:sha(originalRule),consumedSHA256:sha(rule.toString()),mutated:cssMutant===kind})
      })
    }}
    await build({configFile:false,root:fixture,base:'./',logLevel:'error',resolve:{...config.resolve,alias:[
      ...aliases.entries()].map(([name,replacement])=>({find:new RegExp('^'+name.replace(/[.*+?^$()|[\]\\]/g,'\\$&')+'$'),replacement})).concat(config.resolve.alias??[])},
      esbuild:{jsx:'automatic'},define:{...config.define,'process.env.NODE_ENV':'"production"'},
      ...(captureScope==='buttons'?{css:{postcss:{plugins:[cssPlugin]}}}:{}),
      plugins:[{name:'bind-actual-mounted-renderer-source',enforce:'pre',async transform(_code,id){const file=id.split('?')[0];if(file.startsWith(root+'/')&&!file.includes('/node_modules/')&&!file.includes('/.tmp/'))await bind(file)}}],
      build:{target:'esnext',outDir:path.join(compiled,'renderer'),sourcemap:false,emptyOutDir:false}})
    if(captureScope==='buttons'){
      assert.equal(cssInputs.length,4,'实际PostCSS owning规则四个非空唯一')
      assert.equal(cssInputs.filter(item=>item.mutated).length,cssMutant==='baseline'?0:2,'只有实际两处状态或焦点owning声明变异')
      await fs.writeFile(path.join(evidence,'css-input.json'),JSON.stringify(cssInputs,null,2)+'\n')
      receipt.cssInputs=cssInputs
    }
    const env={...process.env,AGENTMUX_PERFORMANCE_PRODUCT_PRELOAD:path.join(compiled,'fixture-preload.cjs'),AGENTMUX_PERFORMANCE_BUTTON_MUTANT:cssMutant,
      AGENTMUX_RUNTIME_DIRECTORY:path.join(privateRoot,'runtime'),AGENTMUX_STATE_DIRECTORY:path.join(privateRoot,'runtime/state'),
      AGENTMUX_MESSAGE_QUEUE_PATH:path.join(privateRoot,'runtime/queue.ndjson'),AGENTMUX_AGENT_SESSION_STORE:path.join(privateRoot,'runtime/sessions.json')};delete env.ELECTRON_RUN_AS_NODE
    for(const phase of captureScope==='full'?['control','restart','joined']:[captureScope]){
      const process=await runProbeProcess(require('electron'),[path.join(fixture,'main.cjs'),path.join(compiled,'renderer/index.html'),path.join(compiled,'owner.mjs'),privateRoot,evidence,phase,asset,path.join(compiled,'agentmux.mjs')],
        {temporaryRoot:privateRoot,cwd:root,env,timeoutMs:90000})
      receipt.processes.push({...process,phase})
      const raw=JSON.parse(await fs.readFile(path.join(evidence,phase+'-render.json'),'utf8'))
      receipt.frames.push(...raw.frames)
      assert.equal(process.exitCode,0,phase+': private product Renderer退出必须成功')
      assert.equal(process.timedOut,false);assert.equal(raw.qualified,true,phase+': owning native断言必须通过')
      assert.equal(raw.afterDisposalLeases,0,phase+': 结束registered IPC全部自有lease归零')
      if(phase==='joined'){assert.equal(raw.joined.officialExecution,true);receipt.officialOwnerQualification=true;receipt.joined=raw.joined}
    }
    if(captureScope==='placement')receipt.boundary='仅本次 Settings 左归属修正：实际 App 9 geometry、7 native keyboard、Settings toggle/Escape/snapshot retention、完整 Footer 图；不运行或签原full hidden/restart/joined/T004。'
    if(captureScope==='buttons')receipt.boundary='仅T005底栏七常规按钮actual App样式/几何/原生焦点与原工作面保持；私有CSS输入变异。无旧full hidden/restart/joined、Backend或用户FPS资格。'
    receipt.completed=true
  } catch(error){receipt.failure={name:error.name,message:error.message,stack:error.stack}}
  finally {
    receipt.inputs={};receipt.changedAfterCapture=[]
    for(const [key,bytes]of [...inputs].sort(([a],[b])=>a.localeCompare(b))){
      receipt.inputs[key]={sha256:sha(bytes),bytes:bytes.length};const output=path.join(evidence,'source',key)
      await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,bytes);assert.equal(sha(await fs.readFile(output)),sha(bytes))
      try{if(sha(await fs.readFile(path.join(root,key)))!==sha(bytes))receipt.changedAfterCapture.push(key)}catch{receipt.changedAfterCapture.push(key)}
    }
    receipt.sourceIdentity=sha(JSON.stringify(receipt.inputs))
    receipt.sourceCurrentReadbackExact=receipt.changedAfterCapture.length===0
    if(!receipt.sourceCurrentReadbackExact)receipt.completed=false
    const collect=async directory=>{for(const entry of await fs.readdir(directory,{withFileTypes:true})){if(entry.isSymbolicLink())continue;const file=path.join(directory,entry.name);if(entry.isDirectory())await collect(file);else{const bytes=await fs.readFile(file);artifacts.push({file:path.relative(evidence,file),bytes:bytes.length,sha256:sha(bytes)})}}}
    await collect(compiled).catch(()=>{})
    receipt.compiled=artifacts;receipt.remainingPrivateProcesses=await listProbeProcesses(-1,privateRoot)
    if(receipt.remainingPrivateProcesses.length===0){await fs.rm(privateRoot,{recursive:true,force:true});receipt.privateRootRemoved=true}else{receipt.privateRootRemoved=false;receipt.completed=false}
    await fs.writeFile(path.join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')
    console.log(JSON.stringify({completed:receipt.completed,evidence,sourceIdentity:receipt.sourceIdentity,frames:receipt.frames.length,failure:receipt.failure,drift:receipt.changedAfterCapture,remainingPrivateProcesses:receipt.remainingPrivateProcesses}))
  }
  return receipt
}
