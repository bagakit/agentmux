import { mkdtemp, mkdir, readFile, writeFile, symlink, copyFile, rm, cp } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve, relative, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { build, type Plugin } from 'vite'
import ts from 'typescript'
import { zip } from '../../../../../packages/editor-extensions/test/books/fixtures'
import { privatePackageSmokeEnvironment } from '../../../scripts/package-smoke-context.mjs'
import { runProbeProcess, listProbeProcesses, signalOwnedProbeProcess } from '../../../scripts/probe-process.mjs'
import { noteParsingAliases } from '../../../../../packages/client-ui/scripts/note-parsing-aliases'
import { radixOverlayAliases } from '../../../scripts/radix-overlay-aliases'

const repository=resolve(import.meta.dirname,'../../../../..')
export async function runBookRestart(){
  const require=createRequire(import.meta.url),appRequire=createRequire(resolve(repository,'apps/desktop/package.json')),esbuild=await import(createRequire(require.resolve('vite')).resolve('esbuild'))
  const root=await mkdtemp(join(tmpdir(),'agentmux-book-file-restart-')),profile=join(root,'profile'),buildRoot=resolve(process.env.BOOK_FILE_BUILD_DIR??join(root,'build')),output=join(buildRoot,'renderer'),workspace=join(root,'workspace'),sourceHashes:Record<string,string>={}
  const env=privatePackageSmokeEnvironment(process.env,{userData:profile,runtimeRoot:join(root,'runtime'),readyFile:join(root,'ready.json')})
  const record=(path:string,source:string)=>{if(!path.startsWith(repository+'/'))return source;const key=relative(repository,path),hash=createHash('sha256').update(source).digest('hex');if(sourceHashes[key]&&sourceHashes[key]!==hash)throw new Error('Source changed during the restart build: '+key);sourceHashes[key]=hash;return source}
  const painter=resolve(import.meta.dirname,'unused-painter.tsx')
  const plugin:Plugin={name:'actual-file-reader-restart',enforce:'pre',resolveId(source,importer){
    if(importer?.endsWith('/components/FileSurfaceView.tsx')&&['./file-preview/SourceFilePreview','./EditorPane','./NoteFileSurfaceView'].includes(source))return painter
    if(importer?.endsWith('/lib/file-surface-loading.ts')&&source==='../components/FileSourceEditor')return painter
    if(['@agentmux/editor-extensions/pdf','@agentmux/editor-extensions/ui/MediaPlayer'].includes(source))return painter
  },transform(source,id){if(id.includes('?'))return null;const path=id;if(path.startsWith(repository+'/')&&!path.includes('/node_modules/'))record(path,source);return null}}
  try{
    for(const path of [env.HOME,env.TMPDIR,profile,workspace,join(root,'app-data'),join(root,'session-data')])await mkdir(path,{recursive:true})
    const book=await zip({mimetype:'application/epub+zip','META-INF/container.xml':'<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      'package.opf':'<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Original File</dc:title></metadata><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>',
      'one.xhtml':'<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Original chapter</title></head><body><h1>The Original File</h1>'+Array.from({length:100},(_,i)=>`<p>Paragraph ${i+1}. The original file keeps its place across a real application process restart.</p>`).join('')+'</body></html>',
      'two.xhtml':'<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Two</title></head><body><h1>Second chapter</h1></body></html>'})
    await writeFile(join(workspace,'long.epub'),book);await writeFile(join(workspace,'neighbor.txt'),'An original neighboring File')
    await mkdir(buildRoot,{recursive:true})
    await symlink(resolve(repository,'apps/desktop/node_modules'),join(buildRoot,'node_modules'),'dir').catch(error=>{if(error.code!=='EEXIST')throw error})
    let cached:any=null
    try{cached=JSON.parse(await readFile(join(buildRoot,'sources.json'),'utf8'));for(const [path,hash]of Object.entries(cached)){if(createHash('sha256').update(await readFile(resolve(repository,path))).digest('hex')!==hash)throw new Error('Source changed')}}catch{cached=null}
    if(cached)Object.assign(sourceHashes,cached)
    if(!cached){
    record(resolve(import.meta.dirname,'runner.ts'),await readFile(resolve(import.meta.dirname,'runner.ts'),'utf8'))
    for(const html of [resolve(import.meta.dirname,'index.html'),resolve(repository,'apps/desktop/src/renderer/book-reader/index.html')])record(html,await readFile(html,'utf8'))
    await build({configFile:false,root:repository,base:'./',logLevel:'error',plugins:[plugin],resolve:{alias:{...radixOverlayAliases,...noteParsingAliases,react:dirname(appRequire.resolve('react/package.json')),'react-dom':dirname(appRequire.resolve('react-dom/package.json'))}},worker:{format:'es'},define:{__AGENTMUX_WEB_PREVIEW__:'false'},build:{outDir:output,emptyOutDir:true,rollupOptions:{input:{proof:resolve(import.meta.dirname,'index.html'),'book-reader':resolve(repository,'apps/desktop/src/renderer/book-reader/index.html')}}}})
    const bundle=async(entryPoints:string[],outfile:string,preload=false)=>esbuild.build({entryPoints,bundle:true,platform:preload?'browser':'node',format:preload?'cjs':'esm',external:preload?['electron']:['electron','@agentmux/core','@agentmux/core/*'],outfile,logLevel:'error',...(!preload?{banner:{js:"import{createRequire}from'node:module';const require=createRequire(import.meta.url);"}}:{}),plugins:[{name:'restart-original-node-sources',setup(context:any){context.onLoad({filter:/\.ts$/},async({path}:{path:string})=>({contents:record(path,await readFile(path,'utf8')),loader:'ts'}))}}]})
    await bundle([resolve(repository,'apps/desktop/src/preload/index.ts')],join(buildRoot,'index.cjs'),true)
    await bundle([resolve(repository,'apps/desktop/src/preload/book-reader.ts')],join(buildRoot,'book-reader.cjs'),true)
    const imports={FileBookRealms:'apps/desktop/src/main/file-book-realms.ts',WorkspaceFileSources:'apps/desktop/src/main/workspace-file-sources.ts',WorkspaceCbrArchives:'apps/desktop/src/main/workspace-cbr-archives.ts',WorkspaceFiles:'apps/desktop/src/main/workspace-files.ts',WorkbenchUserStateStore:'apps/desktop/src/main/workbench-user-state.ts',assertAppDocumentSender:'apps/desktop/src/main/ipc-sender-trust.ts',ipcResult:'apps/desktop/src/shared/ipc-result.ts'}
    await writeFile(join(buildRoot,'host.ts'),Object.entries(imports).map(([name,path])=>`export {${name}} from ${JSON.stringify(resolve(repository,path))};`).join('\n'))
    await bundle([join(buildRoot,'host.ts')],join(buildRoot,'host.mjs'))
    // Keep the original production forwarding bodies. This fixture supplies native owners,
    // never a separately maintained version of source/book/user-state IPC wiring.
    const ipcPath=resolve(repository,'apps/desktop/src/main/ipc.ts'),ipc=record(ipcPath,await readFile(ipcPath,'utf8')),parsed=ts.createSourceFile(ipcPath,ipc,ts.ScriptTarget.Latest,true)
    const wanted=new Set(['files:openSource','files:readSource','files:cancelSourceRead','files:releaseSource','files:openBook','files:loadBookSection','files:unloadBookSection','files:resolveBookHref','files:closeBook','files:comicArchiveEntries','files:readComicArchiveEntry','ui:readWorkbenchState','ui:importWorkbenchState','ui:writeWorkbenchState','ui:requestStorageFlush','ui:readFileViewReading','ui:writeFileViewReading'])
    const calls:string[]=[]
    const visit=(node:ts.Node)=>{if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='handleWithEvent'&&ts.isStringLiteral(node.arguments[0]!)&&wanted.has((node.arguments[0] as ts.StringLiteral).text)){wanted.delete((node.arguments[0] as ts.StringLiteral).text);calls.push(node.getText(parsed)+';')}ts.forEachChild(node,visit)};visit(parsed)
    if(wanted.size)throw new Error('Every restart capability must use its original IPC forwarding body: '+[...wanted])
    await writeFile(join(buildRoot,'bindings.cjs'),ts.transpileModule('module.exports = ({handleWithEvent,fileSources,comicArchives,bookRealms,workspace,config,workbenchUserState,ipcResult}) => {'+calls.join('\n')+'}',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)
    await writeFile(join(buildRoot,'sources.json'),JSON.stringify(sourceHashes))
    }
    const driverPath=resolve(import.meta.dirname,'electron.mjs')
    // The driver is copied on every run; its identity belongs to the receipt,
    // not to the reusable production build graph.
    record(driverPath,await readFile(driverPath,'utf8'))
    await copyFile(driverPath,join(buildRoot,'main.mjs'))
    const reports:any[]=[]
    for(const mode of ['writer','reader']){
      const diagnostics:string[]=[]
      const outcome=await runProbeProcess(require('electron'),[join(buildRoot,'main.mjs'),root,mode,process.env.BOOK_FILE_CAPTURE_DIR??''],{temporaryRoot:root,cwd:repository,env,timeoutMs:45000,onLine:(line:string)=>diagnostics.push(line)})
      let report:any
      try{report=JSON.parse(await readFile(join(root,mode+'.json'),'utf8'))}catch(error){report={failure:'The native process did not write its report: '+String(error),outcome}}
      report.processDiagnostics=diagnostics
      reports.push({outcome,report})
      if(report.failure)break
    }
    const result={sourceHashes,buildReused:Boolean(cached),writer:reports[0]?.report,reader:reports[1]?.report??{failure:'The writer process did not complete'},processes:reports.map(value=>value.outcome)}
    if(process.env.BOOK_FILE_RECEIPT)await writeFile(process.env.BOOK_FILE_RECEIPT,JSON.stringify({schema:'agentmux.book-file-restart.v1',...result},null,2))
    return result
  }finally{for(const pid of await listProbeProcesses(-1,root))await signalOwnedProbeProcess(pid,root,'SIGKILL');await rm(root,{recursive:true,force:true})}
}
