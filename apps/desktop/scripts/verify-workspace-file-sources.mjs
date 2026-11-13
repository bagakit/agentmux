import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {copyFile,cp,mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {tmpdir} from 'node:os'
import {dirname,join,resolve} from 'node:path'
import {runProbeProcess,listProbeProcesses,signalOwnedProbeProcess} from './probe-process.mjs'
import {privatePackageSmokeEnvironment} from './package-smoke-context.mjs'

const require=createRequire(import.meta.url),{build,loadConfigFromFile}=await import('vite'),esbuild=createRequire(require.resolve('vite'))('esbuild')
const desktop=resolve(import.meta.dirname,'..'),root=resolve(desktop,'../..'),fixture=join(desktop,'scripts/fixtures/workspace-file-sources')
const outputArg=process.argv.find(value=>value.startsWith('--output='))?.slice(9)
const evidence=resolve(root,outputArg??'.tmp/workspace-file-sources')
const temporary=await mkdtemp(join(tmpdir(),'agentmux-pdf-source-')),profile=join(temporary,'profile'),workspace=join(temporary,'workspace'),outDir=join(temporary,'renderer')
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const paths=['apps/desktop/src/main/workspace-file-sources.ts','apps/desktop/src/main/workspace-files.ts','apps/desktop/src/renderer/src/lib/use-workspace-file-source.ts',
  'apps/desktop/src/renderer/src/components/FilePreviewPane.tsx','packages/editor-extensions/src/pdf/PdfReader.tsx','packages/editor-extensions/src/bytes.ts',
  'apps/desktop/scripts/verify-workspace-file-sources.mjs','apps/desktop/test/vitest.file-sources.config.mts',...['entry.tsx','preload.ts','main.cjs','native-owner.ts','index.html'].map(file=>'apps/desktop/scripts/fixtures/workspace-file-sources/'+file)]
const sources=async()=>Object.fromEntries(await Promise.all(paths.map(async path=>[path,sha(await readFile(join(root,path)))])))
const receipt={schema:'agentmux.workspace-file-sources.v1',passed:false,sources:await sources()}
try{
  await mkdir(evidence,{recursive:true});await mkdir(workspace,{recursive:true})
  // Group page dictionaries separately from 256 KiB content streams. This distinguishes eager content
  // prefetch from PDF.js's legitimate page-tree metadata traversal when checking the page count.
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  const kids=[]
  for(let page=1;page<=100;page++){
    const id=3+page;kids.push(`${id} 0 R`)
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${103+page} 0 R >>`)
  }
  for(let page=1;page<=100;page++){
    const content='%'+('x'.repeat(256*1024))+`\n${page===100?'0.15 0.55 0.3':'0.15 0.3 0.65'} rg 30 600 550 150 re f\nBT /F1 30 Tf 48 720 Td (Original file - page ${page}) Tj ET\n`
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}endstream`)
  }
  objects[1]=`<< /Type /Pages /Kids [${kids.join(' ')}] /Count 100 >>`
  let pdf='%PDF-1.4\n';const offsets=[]
  for(const[index,object]of objects.entries()){offsets.push(pdf.length);pdf+=`${index+1} 0 obj\n${object}\nendobj\n`}
  const start=pdf.length;pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  await writeFile(join(workspace,'large.pdf'),pdf)
  const aliases=(await loadConfigFromFile({command:'build',mode:'production'},join(desktop,'test/vitest.file-sources.config.mts'))).config.resolve.alias
  const page=await readFile(join(desktop,'src/renderer/index.html'),'utf8'),csp=/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(page)?.[1];assert.ok(csp)
  await build({configFile:false,root:fixture,base:'./',logLevel:'error',worker:{format:'es'},resolve:{alias:aliases},
    plugins:[{name:'production-csp',transformIndexHtml:html=>html.replace('__PRODUCTION_CSP__',csp)}],
    define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},esbuild:{jsx:'automatic'},build:{outDir,emptyOutDir:true}})
  const pdfjs=dirname(require.resolve('pdfjs-dist/package.json'))
  for(const directory of ['cmaps','standard_fonts','wasm','iccs'])await cp(join(pdfjs,directory),join(outDir,'pdfjs',directory),{recursive:true})
  await symlink(join(desktop,'node_modules'),join(temporary,'node_modules'))
  const nativeModule=join(temporary,'native/src/main/native-owner.mjs')
  await esbuild.build({entryPoints:[join(fixture,'native-owner.ts')],outfile:nativeModule,bundle:true,platform:'node',format:'esm',logLevel:'error',
    external:['electron','@agentmux/core','@agentmux/core/*'],plugins:[{name:'workspace-source-leaves',setup(builder){builder.onResolve({filter:/^@agentmux\//},args=>{
      if(args.path.startsWith('@agentmux/core'))return {path:args.path,external:true}
      const found=aliases.find(alias=>alias.find.test(args.path));return found?{path:found.replacement}:undefined
    })}}],banner:{js:"import {createRequire as proofRequire} from 'node:module';const require=proofRequire(import.meta.url);"}})
  await build({configFile:false,logLevel:'error',resolve:{alias:aliases},define:{'process.env.NODE_ENV':'"production"'},build:{outDir:temporary,emptyOutDir:false,minify:false,ssr:false,
    lib:{entry:join(fixture,'preload.ts'),formats:['cjs'],fileName:()=>'preload.cjs'},rollupOptions:{external:['electron']}}})
  const main=join(temporary,'main.cjs');await copyFile(join(fixture,'main.cjs'),main)
  const env=privatePackageSmokeEnvironment(process.env,{userData:join(profile,'user-data'),runtimeRoot:join(temporary,'runtime'),readyFile:join(temporary,'ready.json')})
  for(const directory of [env.HOME,env.TMPDIR,join(profile,'app-data')])await mkdir(directory,{recursive:true})
  const lines=[]
  receipt.outcome=await runProbeProcess(require('electron'),[main,join(outDir,'index.html'),profile,evidence,nativeModule,workspace],{temporaryRoot:temporary,cwd:root,env,timeoutMs:120000,onLine:line=>lines.push(line)})
  await writeFile(join(evidence,'process.log'),lines.join('\n'))
  receipt.process=JSON.parse(await readFile(join(evidence,'process-receipt.json'),'utf8'))
  assert.equal(receipt.outcome.exitCode,0,receipt.process.failure?.message);assert.equal(receipt.process.passed,true)
  assert.deepEqual(await sources(),receipt.sources,'Relevant source stayed unchanged during the real proof')
  receipt.frames=await Promise.all(receipt.process.frames.map(async file=>({file,sha256:sha(await readFile(join(evidence,file)))})))
  receipt.passed=true
}catch(error){receipt.failure={name:error.name,message:error.message,stack:error.stack}}
finally{
  const remaining=await listProbeProcesses(-1,temporary);for(const pid of remaining)await signalOwnedProbeProcess(pid,temporary,'SIGKILL')
  await rm(temporary,{recursive:true,force:true});receipt.cleanup={privateRootRemoved:true}
  await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')
  console.log(JSON.stringify({passed:receipt.passed,evidence,checks:receipt.process?.checks,failure:receipt.failure?.message}));process.exitCode=receipt.passed?0:1
}
