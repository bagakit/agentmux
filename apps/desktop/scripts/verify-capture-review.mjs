import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
const require=createRequire(resolve('apps/desktop/package.json')), {build}=createRequire(require.resolve('vite'))('esbuild')
await mkdir('.local/capture-review-proof',{recursive:true})
const out=await mkdtemp(resolve('.local/capture-review-proof/run-')), work=await mkdtemp(join(tmpdir(),'agentmux-capture-review-'))
const inputs=new Map(), receipt={passed:false,controlledPixels:true,nativeInputClaim:false,variants:[],inputs:{},cleanup:false}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
try {
  const main=join(work,'app/out/main'),preload=join(work,'app/out/preload'),renderer=join(work,'app/out/renderer/screenshot-editor')
  for(const dir of [main,preload,renderer])await mkdir(dir,{recursive:true})
  await writeFile(join(work,'app/package.json'),JSON.stringify({type:'module',main:'out/main/main.js'}))
  const alias={react:dirname(require.resolve('react/package.json')),'react-dom':dirname(require.resolve('react-dom/package.json')),'@agentmux/client-ui/theme':resolve('packages/client-ui/src/theme/index.ts'),'@agentmux/native-desktop/image':resolve('packages/native-desktop/src/image.ts')}
  async function bundle(options){const {plugins=[],...rest}=options;const r=await build({bundle:true,logLevel:'silent',metafile:true,alias,...rest,plugins:[{name:'current-core-source-exports',setup(builder){builder.onResolve({filter:/^@agentmux\/core(?:\/|$)/},args=>{if(args.path==='@agentmux/core')return {path:resolve('packages/core/src/errors.ts')};const value=JSON.parse(require('node:fs').readFileSync('packages/core/package.json')).exports['.'+args.path.slice('@agentmux/core'.length)];const target=typeof value==='string'?value:value?.import;assert.ok(target,'actual Core export '+args.path);return {path:resolve('packages/core',target.replace('./dist/','./src/').replace(/\.js$/,'.ts'))}})}},...plugins]});for(const file of Object.keys(r.metafile.inputs)){if(file.startsWith('<'))continue;const digest=hash(await readFile(file));if(inputs.has(file))assert.equal(inputs.get(file),digest,'candidate changed between builds: '+file);else inputs.set(file,digest)}return r}
  await bundle({entryPoints:['apps/desktop/src/preload/capture-sequence.ts'],outfile:join(preload,'capture-sequence.cjs'),platform:'node',format:'cjs',external:['electron']})
  await bundle({entryPoints:['apps/desktop/scripts/fixtures/capture-review/entry.tsx'],outfile:join(renderer,'entry.js'),platform:'browser',format:'esm',jsx:'automatic',conditions:['browser']})
  const htmlFile='apps/desktop/src/renderer/screenshot-editor/index.html',html=await readFile(htmlFile,'utf8');inputs.set(htmlFile,hash(html));await writeFile(join(renderer,'index.html'),html.replace('./entry.tsx','./entry.js').replace('</head>','<link rel="stylesheet" href="entry.css"></head>'))
  for(const mutation of [false,true]){
    const label=mutation?'close-bypass':'baseline',scene=join(out,label);await mkdir(scene)
    await bundle({entryPoints:['apps/desktop/scripts/fixtures/capture-review/main.ts'],outfile:join(main,'main.js'),platform:'node',format:'esm',external:['electron'],banner:{js:"import {createRequire as fixtureRequire} from 'node:module';const require=fixtureRequire(import.meta.url);"},plugins:[{name:'real-close-owner-mutation',setup(builder){builder.onLoad({filter:/\/main\/capture-sequence\.ts$/},async args=>{const original=await readFile(args.path,'utf8'),contents=mutation?original.replace('event.preventDefault()\n        window.webContents.send(CAPTURE_SEQUENCE_CLOSE_REQUESTED)', '/* native close guard removed */\n        window.webContents.send(CAPTURE_SEQUENCE_CLOSE_REQUESTED)'):original;if(mutation)assert.notEqual(contents,original,'mutation is consumed in the actual owner');return {contents,loader:'ts',resolveDir:dirname(args.path)}})}}]})
    const env={...process.env,CAPTURE_REVIEW_OUT:scene,ELECTRON_RENDERER_URL:''};delete env.ELECTRON_RUN_AS_NODE
    const execution=await new Promise((resolve,reject)=>{const child=spawn(require('electron'),[join(work,'app')],{env,stdio:['ignore','pipe','pipe']});let log='',timeout=false;child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);const timer=setTimeout(()=>{timeout=true;child.kill('SIGKILL')},60000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);resolve({code,log,timeout})})})
    await writeFile(join(scene,'electron.log'),execution.log);assert.equal(execution.timeout,false,'timeout is not mutation proof')
    const result=JSON.parse(await readFile(join(scene,'result.json'),'utf8'));receipt.variants.push({label,code:execution.code,result})
    if(mutation){assert.notEqual(execution.code,0);assert.equal(result.failure.name,'AssertionError');assert.match(result.failure.message,/native close must retain/)}else{assert.equal(execution.code,0,JSON.stringify(result.failure));assert.equal(result.passed,true)}
    process.stdout.write(label+': '+(mutation?'AssertionRED':'GREEN')+'\n')
  }
  for(const [file,digest]of inputs)assert.equal(hash(await readFile(file)),digest,'candidate changed during verification: '+file)
  receipt.inputs=Object.fromEntries(inputs);receipt.passed=true
}finally{await rm(work,{recursive:true,force:true});receipt.cleanup=true;await writeFile(join(out,'receipt.json'),JSON.stringify(receipt,null,2));process.stdout.write(JSON.stringify({passed:receipt.passed,receipt:join(out,'receipt.json')})+'\n')}
