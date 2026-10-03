import { fixtureCivil as _hygiene_fixtureCivil, fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, writeFile, copyFile, rm, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve, relative } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { runProbeProcess, listProbeProcesses, signalOwnedProbeProcess } from './probe-process.mjs'
const require = createRequire(import.meta.url), { build } = await import('vite')
const esbuild = createRequire(require.resolve('vite'))('esbuild'), run = promisify(execFile)
const desktop = resolve(import.meta.dirname, '..'), root = resolve(desktop, '../..')
const fixture = join(desktop, 'scripts/fixtures/file-surface-quality/visual')
const evidence = join(root, '.tmp/file-surface-quality-visual')
const temporary = await mkdtemp(_hygiene_fixturePath("tmp/amx-file-quality-")), workspace = join(temporary, 'workspace'), profile = join(temporary, 'profile'), outDir = join(temporary, 'out')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const report = { passed: false, boundary: 'Real compiled Workbench/FileExplorer/Editor/Note/Markdown/PDF/media in two private ordinary Electron processes. Real WorkspaceFiles byte authority and production files preload bridge. No installed-user-App or healthy native Run claim.', sourceHashes: {}, frames: [], processes: [] }
async function manifest() {
  const files = {}
  async function visit(directory = '') {
    for (const entry of await readdir(join(workspace, directory), { withFileTypes: true })) {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile()) files[file] = sha(await readFile(join(workspace, file)))
    }
  }
  await visit()
  return files
}
await mkdir(evidence, { recursive: true })
try {
  await mkdir(workspace); await mkdir(profile)
  await run('ffmpeg', ['-loglevel','error','-y','-f','lavfi','-i','color=c=0x7699ac:size=1280x720','-vf','drawbox=x=0:y=420:w=1280:h=300:color=0x38545c:t=fill,drawbox=x=180:y=180:w=360:h=390:color=0xebdcc2:t=fill,drawbox=x=230:y=240:w=72:h=150:color=0x456574:t=fill,drawbox=x=400:y=240:w=72:h=150:color=0x456574:t=fill,drawbox=x=280:y=450:w=170:h=120:color=0x9b8060:t=fill','-frames:v','1',join(workspace,'original.png')])
  await run('ffmpeg',['-loglevel','error','-y','-f','lavfi','-i','sine=frequency=440:duration=2',join(workspace,'tone.wav')])
  await run('ffmpeg',['-loglevel','error','-y','-f','lavfi','-i','testsrc=size=640x360:rate=12','-t','2','-c:v','libvpx','-pix_fmt','yuv420p',join(workspace,'motion.webm')])
  await writeFile(join(workspace,'drawing.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="720" height="440"><rect width="720" height="440" fill="#f3eee4"/><path d="M60 340L190 280L320 302L450 150L590 96L660 130" fill="none" stroke="#397e80" stroke-width="6"/><g fill="#397e80"><circle cx="190" cy="280" r="7"/><circle cx="450" cy="150" r="7"/><circle cx="590" cy="96" r="7"/></g><text x="60" y="60" font-family="sans-serif" font-size="26" fill="#273b42">A clearer view of progress</text><text x="60" y="395" font-family="sans-serif" font-size="16" fill="#60777e">Vector artwork · Original editable source</text></svg>')
  await writeFile(join(workspace,'notes.md'),`# Reading, with room to think\n\nA file should feel like a document. Clear structure and quiet controls keep the content in focus.\n\n## The details matter\n\nParagraphs preserve **emphasis**, *nuance*, and a deliberate line break.  \nThis is a second line, not a second paragraph.\n\n3. Keep the original document\n4. Follow references without losing your place\n\n- [x] Read the current unsaved draft\n- [ ] Review the next revision\n\n> The workspace is the shared context. Files retain their own identity.\n\n| Format | Reader | Source |\n| :--- | :--- | ---: |\n| Markdown | Document | Editable |\n| CSV | Table | Editable |\n| PDF | Pages | Original bytes |\n\n### Local references\n\n[Open the source][source] or [jump to the notes](#local-references). A local image shares the same file authority.\n\n![A quiet architectural study](original.png)\n\nA precise claim has a footnote.[^one]\n\n\`\`\`ts\nconst view = workspace.file('notes.md')\nawait view.preview()\n\`\`\`\n\n[source]: code.ts\n[^one]: This note stays in the same document.\n`)
  await writeFile(join(workspace,'preferences.json'),JSON.stringify({ project:'File surface quality', revision:7, healthy:true, summary:'Small, independent readers over one shared document.', limits:{ sourceBytes:16777216, structuredBytes:1048576 }, formats:['Markdown','JSON','CSV','PDF'], optional:null },null,2))
  await writeFile(join(workspace,'measurements.csv'),("Date,Format,Read time (ms),Size (KB),Status,Notes\n" + _hygiene_fixtureCivil(10, 7) + ",Markdown,12.8,42,Ready,\"Preserves headings, references and lists\"\n" + _hygiene_fixtureCivil(10, 7) + ",JSON,3.1,8,Ready,Exact source literals\n" + _hygiene_fixtureCivil(10, 7) + ",CSV,4.6,96,Ready,\"Quoted fields\nkeep line breaks\"\n" + _hygiene_fixtureCivil(10, 7) + ",PDF,86.2,512,Ready,Local fonts and selectable text\n" + _hygiene_fixtureCivil(10, 7) + ",Image,18.4,1200,Ready,Fit without upscaling\n" + _hygiene_fixtureCivil(10, 7) + ",Video,34.1,2200,Ready,Native controls\n" + _hygiene_fixtureCivil(10, 7) + ",Audio,7.5,172,Ready,No autoplay\n"))
  await writeFile(join(workspace,'lookup.tsv'),'Key\tValue\tDescription\n001\t9007199254740993\tExact text\n002\t=1+1\tLiteral cell\n003\t\tEmpty value\n')
  await writeFile(join(workspace,'code.ts'),'/** One document, several views. */\nexport function openFile(path: string) {\n  const document = workspace.document(path)\n  return {\n    source: document.content,\n    revision: document.revision,\n    preview: readers.for(path)\n  }\n}\n')
  const note = { schema:'agentmux.note.v1', noteId:'quality-note', content:{type:'doc',content:[
    {type:'heading',attrs:{blockId:'title',level:1},content:[{type:'text',text:'A place for lasting knowledge'}]},
    {type:'paragraph',attrs:{blockId:'intro'},content:[{type:'text',text:'Notes keep meaning, references and edits together. A readable page gives each idea enough space.'}]},
    {type:'heading',attrs:{blockId:'section',level:2},content:[{type:'text',text:'Keep the context close'}]},
    {type:'paragraph',attrs:{blockId:'body'},content:[{type:'text',text:'The same original file owns the source, the revision and the save. Switching views changes the presentation.'}]}
  ]}}
  await writeFile(join(workspace,'knowledge.note.json'),JSON.stringify(note,null,2))
  for (const [file, bytes] of [['broken.png','not an image'], ['broken.pdf','%PDF-1.4\ninvalid document contents'], ['broken.json','{"title": }'], ['opaque.unknown',Buffer.from([0,255,128])]]) await writeFile(join(workspace,file),bytes)
  const helper = join(temporary,'pdf-fixture.mjs')
  await esbuild.build({entryPoints:[join(desktop,'test/helpers/pdf-reader-fixture.ts')],outfile:helper,platform:'node',format:'esm',bundle:true,logLevel:'error'})
  await writeFile(join(workspace,'sample.pdf'),(await import(helper)).pdfReaderFixture())
  const photo=await readFile(join(workspace,'original.png'))
  for(let index=0;index<4;index++)await writeFile(join(workspace,'large-photo-'+index+'.png'),Buffer.concat([photo,Buffer.alloc(4*1024*1024-photo.length)]))
  await mkdir(join(workspace,'many-files'))
  for(let start=0;start<1200;start+=100)await Promise.all(Array.from({length:100},(_,offset)=>{
    const index=start+offset
    return writeFile(join(workspace,'many-files',`item-${String(index).padStart(4,'0')}.ts`),`export const item = ${index}\n`)
  }))
  report.originalFiles = await manifest()
  const pluginFile = join(temporary,'pdf-assets.mjs')
  await esbuild.build({entryPoints:[join(desktop,'scripts/pdfjs-viewer-assets.ts')],outfile:pluginFile,platform:'node',format:'esm',bundle:true,logLevel:'error'})
  const { pdfjsViewerAssets } = await import(pluginFile)
  const assetsRoot = dirname(require.resolve('pdfjs-dist/package.json'))
  await build({configFile:false,root:fixture,base:'./',logLevel:'error',plugins:[pdfjsViewerAssets(assetsRoot),{
    name:'candidate-source-binding', enforce:'pre',
    async generateBundle(){for(const file of this.getWatchFiles()) if(file.startsWith(root+'/') && !file.includes('/node_modules/') && /\.(?:tsx?|css|html)$/.test(file)) report.sourceHashes[relative(root,file)]=sha(await readFile(file))}
  }],define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},esbuild:{jsx:'automatic'},build:{outDir,emptyOutDir:true}})
  report.sourceHashes['apps/desktop/scripts/pdfjs-viewer-assets.ts']=sha(await readFile(join(desktop,'scripts/pdfjs-viewer-assets.ts')))
  report.sourceHashes['apps/desktop/src/renderer/index.html']=sha(await readFile(join(desktop,'src/renderer/index.html')))
  report.sourceHashes['apps/desktop/scripts/fixtures/file-surface-quality/visual/main.cjs']=sha(await readFile(join(fixture,'main.cjs')))
  const nativeModule=join(temporary,'workspace-files.mjs')
  const nativeBuild=await esbuild.build({entryPoints:[join(fixture,'native-file-owner.ts')],outfile:nativeModule,bundle:true,platform:'node',format:'esm',external:['@agentmux/core/spatial-state'],metafile:true,logLevel:'error'})
  for(const file of Object.keys(nativeBuild.metafile.inputs)) {
    const absolute=resolve(file)
    if(absolute.startsWith(root+'/')&&!absolute.includes('/node_modules/'))report.sourceHashes[relative(root,absolute)]=sha(await readFile(absolute))
  }
  for(const file of ['pnpm-lock.yaml','apps/desktop/electron.vite.config.ts','apps/desktop/scripts/fixtures/file-surface-quality/visual/preload.ts'])report.sourceHashes[file]=sha(await readFile(join(root,file)))
  const coreSpatialModule=fileURLToPath(import.meta.resolve('@agentmux/core/spatial-state'))
  report.sourceHashes[relative(root,coreSpatialModule)]=sha(await readFile(coreSpatialModule))
  await symlink(join(desktop,'node_modules'),join(temporary,'node_modules'),'dir')
  await esbuild.build({entryPoints:[join(fixture,'preload.ts')],outfile:join(temporary,'preload.cjs'),bundle:true,platform:'node',format:'cjs',external:['electron'],logLevel:'error'})
  await copyFile(join(fixture,'main.cjs'),join(temporary,'main.cjs'))
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  for(const phase of ['capture','restart']) {
    const lines=[],outcome=await runProbeProcess(require('electron'),[join(temporary,'main.cjs'),join(outDir,'index.html'),profile,evidence,phase,nativeModule,workspace],{temporaryRoot:temporary,cwd:root,env,timeoutMs:180000,onLine:line=>lines.push(line)})
    await writeFile(join(evidence,phase+'-process.log'),lines.join('\n'))
    const render=JSON.parse(await readFile(join(evidence,phase+'-render.json'),'utf8'));report.processes.push({phase,outcome,render})
    for(const frame of render.frames)report.frames.push({...frame,sha256:sha(await readFile(join(evidence,frame.file)))})
    assert.equal(outcome.exitCode,0,render.failure?.message);assert.equal(render.passed,true)
  }
  assert.notEqual(report.processes[0].render.pid,report.processes[1].render.pid)
  assert.equal(report.processes[1].render.durable.passed,true)
  assert.deepEqual(await manifest(),report.originalFiles,'All original bytes survive presentation, drafts and restart')
  for(const [file, expected] of Object.entries(report.sourceHashes)) assert.equal(sha(await readFile(join(root,file))),expected,'Capture used stable candidate '+file)
  report.passed=true
}catch(error){report.failure={name:error.name,message:error.message,stack:error.stack}}
finally{
  for(const pid of await listProbeProcesses(-1,temporary))await signalOwnedProbeProcess(pid,temporary,'SIGKILL')
  report.cleanup={remaining:await listProbeProcesses(-1,temporary)};assert.equal(report.cleanup.remaining.length,0)
  await rm(temporary,{recursive:true,force:true});await writeFile(join(evidence,'capture-receipt.json'),JSON.stringify(report,null,2))
  console.log(JSON.stringify({passed:report.passed,evidence,failure:report.failure??null}));process.exitCode=report.passed?0:1
}
