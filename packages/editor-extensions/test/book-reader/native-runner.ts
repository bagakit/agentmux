import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve, relative, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { build, type Plugin } from 'vite'
import { recoveredPageSvg } from './fixture-page'
import { largeCbr } from './large-cbr'
import { epub, mobi, fb2, png, zip } from '../books/fixtures'
import { runProbeProcess, listProbeProcesses, signalOwnedProbeProcess } from '../../../../apps/desktop/scripts/probe-process.mjs'
import { privatePackageSmokeEnvironment } from '../../../../apps/desktop/scripts/package-smoke-context.mjs'

const repository = resolve(import.meta.dirname, '../../../..'), packageRoot = resolve(import.meta.dirname, '../..')
const mutations = {
  fit: ['src/books/image-page-style.ts', 'max-width:100%;max-height:100%', 'max-width:none;max-height:none'],
  navigation: ['src/book-reader/BookReader.tsx', 'if (generation !== navigation.current || activeBook.current !== book) return;', 'if (false) return;'],
  illustration: ['src/book-reader/BookReader.tsx', "if (!readableText) throw new Error('This page image could not be decoded')", "if (true) throw new Error('This page image could not be decoded')"],
  axis: ['src/book-reader/reading-progress.ts', 'if (horizontal) element.scrollLeft = sign * progress * length', 'if (false) element.scrollLeft = sign * progress * length'],
  reload: ['src/book-reader/BookReader.tsx', 'onClick={onRetry}>Reload original file', 'onClick={() => {}}>Reload original file'],
  csp: ['src/book-reader/BookReader.tsx', ' {...{csp: BOOK_CONTENT_CSP}}', ''],
  caller: ['apps/desktop/src/main/file-book-realms.ts', 'realm.caller !== caller', 'false'],
  'source-close': ['apps/desktop/src/main/file-book-realms.ts', 'if (realm.caller === caller && realm.source === id) this.release(realm)', 'if (false) this.release(realm)'],
} as const
export async function runReaderProbe(): Promise<{checks: number; formats: Record<string, unknown>; failure?: string}> {
  const require = createRequire(import.meta.url), esbuild = await import(createRequire(require.resolve('vite')).resolve('esbuild'))
  const root = await mkdtemp(join(tmpdir(), 'agentmux-book-reader-')), profile = join(root, 'profile'), output = join(root, 'renderer'), workspace = join(root, 'workspace'), reportFile = join(root, 'report.json')
  const sourceHashes: Record<string, string> = {}, mutation = process.env.BOOK_READER_MUTATION as keyof typeof mutations | undefined
  let mutationHits = 0, mutatedSource: unknown
  function transform(source: string, id: string) {
    const packagePath = relative(packageRoot, id), repoPath = relative(repository, id), path = packagePath.startsWith('src/') ? packagePath : repoPath
    if (!repoPath.startsWith('packages/editor-extensions/src/') && !repoPath.startsWith('apps/desktop/src/')) return source
    const before = createHash('sha256').update(source).digest('hex'); sourceHashes[repoPath] = before
    if (mutation && mutations[mutation][0] === path) {
      const [,needle,replacement] = mutations[mutation]
      if (source.split(needle).length !== 2) throw new Error('Mutation must hit one exact loaded source anchor')
      source = source.replace(needle, replacement); mutationHits++
      mutatedSource = {path: repoPath, before, after: createHash('sha256').update(source).digest('hex')}
    }
    return source
  }
  const plugin: Plugin = { name: 'book-reader-source-proof', enforce: 'pre', transform(source,id) { return {code: transform(source,id.split('?')[0]!), map:null} } }
  const env = privatePackageSmokeEnvironment(process.env, {userData: profile, runtimeRoot:join(root,'runtime'), readyFile:join(root,'ready.json')})
  try {
    for (const path of [env.HOME, env.TMPDIR, profile, join(root,'app-data'), join(root,'session-data'), workspace]) await mkdir(path,{recursive:true})
    const fixtureRoot = resolve(packageRoot,'test/fixtures/page-decoders')
    const longEntries = {mimetype:'application/epub+zip', 'META-INF/container.xml':'<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      'package.opf':'<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">reader-proof</dc:identifier><dc:title>A Book for Reading</dc:title></metadata><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>',
      'nav.xhtml':'<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head/><body><nav epub:type="toc"><ol><li><a href="one.xhtml#one">First chapter</a></li><li><a href="two.xhtml#two">Second chapter</a></li></ol></nav></body></html>',
      'one.xhtml':'<html xmlns="http://www.w3.org/1999/xhtml"><head><title>First chapter</title></head><body><h1 id="one">A Book for Reading</h1><p>The missing illustration must not block this text.</p><img src="missing.png"/>'+Array.from({length:100},(_,i)=>`<p>Paragraph ${i+1}. The quiet library opens onto a garden. Reading keeps its place as the light changes.</p>`).join('')+'</body></html>',
      'two.xhtml':'<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Second chapter</title></head><body><h1 id="two">Second chapter</h1><p>A late old link must not take us away from this chapter.</p></body></html>'}
    const long = await zip(longEntries)
    const fixedText = await zip({...longEntries, 'package.opf': longEntries['package.opf'].replace('</metadata>','<meta property="rendition:layout">pre-paginated</meta></metadata>')})
    const vertical = await zip({...longEntries, 'one.xhtml': longEntries['one.xhtml'].replace('<body>','<body style="writing-mode:vertical-rl;height:calc(100vh - 64px)">')})
    const largeFb2 = '<?xml version="1.0"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info><book-title>Large FictionBook</book-title></title-info></description><body>'+Array.from({length:128},(_,index)=>`<section id="chapter-${index}"><title><p>Chapter ${index+1}</p></title><p>${'Original XML book content, read in the private parser process. '.repeat(2300)}</p></section>`).join('')+'</body></FictionBook>'
    const localSentinel=pathToFileURL(join(root,'book-secret-sentinel.css')).href
    await writeFile(join(root,'book-secret-sentinel.css'),'svg{fill:blue}')
    const svgBook = await zip({mimetype:'application/epub+zip','META-INF/container.xml':'<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>', 'package.opf':'<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>SVG page</dc:title></metadata><manifest><item id="svg" href="page.svg" media-type="image/svg+xml"/></manifest><spine><itemref idref="svg"/></spine></package>', 'page.svg':'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><style>@import url(' + localSentinel + ');svg{background-image:url(https://book.invalid/external.png)}</style><rect id="pixel" width="100" height="100" fill="red"/><text x="10" y="130">Inert SVG page</text></svg>'})
    const desktopRequire=createRequire(resolve(repository,'apps/desktop/package.json')), {Resvg}=desktopRequire('@resvg/resvg-js')
    const recoveredPage = new Uint8Array(new Resvg(recoveredPageSvg,{fitTo:{mode:'width',value:1200}}).render().asPng())
    const fixtures = {'book.epub':await epub(),'book.mobi':mobi(),'book.fb2':fb2(),'book.cbz':await zip({'one.png':png,'two.png':png}),'book.azw3':await readFile(resolve(packageRoot,'test/books/fixtures/alice-gutenberg-11.azw3')),'book.cbr':await readFile(join(fixtureRoot,'original-pages.cbr')),'book.djvu':await readFile(join(fixtureRoot,'chinese-cookbook.djvu')),'long.epub':long,'broken.cbz':await zip({'one.png':new Uint8Array([1,2,3]),'two.png':recoveredPage})}
    await writeFile(join(workspace,'large.fb2'),largeFb2)
    await writeFile(join(workspace,'svg.epub'),svgBook)
    await writeFile(join(workspace,'vertical.epub'),vertical)
    await writeFile(join(workspace,'fixed-text.epub'),fixedText)
    for (const [name,bytes] of Object.entries(fixtures)) await writeFile(join(workspace,name),bytes)
    await largeCbr(join(workspace,'large.cbr'))
    await build({configFile:false,root:repository,base:'./',logLevel:'error',plugins:[plugin],worker:{format:'es'},build:{outDir:output,emptyOutDir:true,rollupOptions:{input:{'book-reader':resolve(repository,'apps/desktop/src/renderer/book-reader/index.html'),proof:resolve(import.meta.dirname,'index.html')}}}})
    const bundle = async (entryPoints: string[], outfile: string) => esbuild.build({entryPoints,bundle:true,platform:'node',format:'cjs',external:['electron'],outfile,logLevel:'error',plugins:[{name:'book-host-source-proof',setup(context:any){context.onLoad({filter:/\.ts$/},async({path}:{path:string})=>({contents:transform(await readFile(path,'utf8'),path),loader:'ts'}))}}]})
    await bundle([resolve(repository,'apps/desktop/src/preload/book-reader.ts')],join(root,'book-reader.cjs'))
    await writeFile(join(root,'proof-preload.cjs'),"const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('bookTest',{invoke:(method,args)=>ipcRenderer.invoke('proof:book',method,args)});")
    const service=resolve(repository,'apps/desktop/src/main/file-book-realms.ts'),sources=resolve(repository,'apps/desktop/src/main/workspace-file-sources.ts'),archives=resolve(repository,'apps/desktop/src/main/workspace-cbr-archives.ts')
    await writeFile(join(root,'host.ts'),`export {FileBookRealms} from ${JSON.stringify(service)};export {WorkspaceFileSources} from ${JSON.stringify(sources)};export {WorkspaceCbrArchives} from ${JSON.stringify(archives)};`)
    await bundle([join(root,'host.ts')],join(root,'host.cjs'))
    if (mutation && mutationHits !== 1) throw new Error('The actual native code must contain exactly one source mutation')
    await copyFile(resolve(import.meta.dirname,'native-electron.cjs'),join(root,'main.cjs'))
    const outcome = await runProbeProcess(require('electron'),[join(root,'main.cjs'),root,process.env.BOOK_READER_CAPTURE_DIR ?? '',process.env.BOOK_READER_CAPTURE_FILTER??''],{temporaryRoot:root,cwd:repository,env,timeoutMs:60000})
    const report = JSON.parse(await readFile(reportFile,'utf8'))
    if (process.env.BOOK_READER_RECEIPT) await writeFile(process.env.BOOK_READER_RECEIPT,JSON.stringify({schema:'agentmux.book-reader-native.v1',sourceHashes,mutation:mutation??null,mutationHits,mutatedSource,outcome,report},null,2))
    return report
  } finally { for(const pid of await listProbeProcesses(-1,root)) await signalOwnedProbeProcess(pid,root,'SIGKILL'); await rm(root,{recursive:true,force:true}) }
}
