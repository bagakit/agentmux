import fs from 'node:fs/promises'
import path from 'node:path'
import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
import {createServer} from 'node:http'
const root=path.resolve(import.meta.dirname,'../../../../..'),fixture=import.meta.dirname
const proof=path.join(root,'.bagakit/feature-tracker/conversation-input-cards-artifacts/T008'),out=path.join(proof,'compiled')
const require=createRequire(path.join(root,'apps/desktop/package.json')),{build}=createRequire(require.resolve('vite'))('esbuild')
const loaded=[];const hash=data=>createHash('sha256').update(data).digest('hex')
await fs.mkdir(out,{recursive:true})
const built=await build({absWorkingDir:root,entryPoints:[path.join(fixture,'entry.tsx')],outdir:out,bundle:true,format:'esm',platform:'browser',target:'esnext',jsx:'automatic',metafile:true,logLevel:'error',define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},loader:{'.woff2':'file','.woff':'file','.ttf':'file','.svg':'file','.png':'file'},plugins:[{name:'actual-compiled-source',setup(b){b.onLoad({filter:/\.[cm]?[jt]sx?$|\.css$/},async args=>{if(!args.path.startsWith(root+'/apps/desktop/src/')&&!args.path.startsWith(fixture+'/')&&!args.path.endsWith('/packages/core/dist/agent-message-render.js'))return;const code=await fs.readFile(args.path,'utf8');loaded.push({path:path.relative(root,args.path),sha256:hash(code),bytes:Buffer.byteLength(code)});return{contents:code,loader:path.extname(args.path)==='.css'?'css':path.extname(args.path)==='.tsx'?'tsx':path.extname(args.path)==='.ts'?'ts':'js',resolveDir:path.dirname(args.path)}})}}]})
await fs.copyFile(path.join(fixture,'index.html'),path.join(out,'index.html'));await fs.copyFile(path.join(proof,'public-reader-page.json'),path.join(out,'public-reader-page.json'))
const assets=Object.fromEntries(await Promise.all((await fs.readdir(out)).map(async file=>[file,hash(await fs.readFile(path.join(out,file)))])))
await fs.writeFile(path.join(proof,'compiled-inputs.json'),JSON.stringify({sourceRoot:root,loaded,metafile:built.metafile,assets,boundary:'actual compiled Activity/NativeThread/Message/Reasoning/Workflow and product CSS; native page from real public Claude FileStore reader; declared hook answer and empty/redacted transport; no App/Run/Runtime or full Desktop build'},null,2)+'\n')
const server=createServer(async(req,res)=>{try{const name=new URL(req.url,'http://localhost').pathname==='/'?'index.html':new URL(req.url,'http://localhost').pathname.slice(1);if(name.includes('..'))throw Error('Invalid path');const data=await fs.readFile(path.join(out,name));res.setHeader('Content-Type',name.endsWith('.html')?'text/html':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.json')?'application/json':'application/octet-stream');res.end(data)}catch{res.writeHead(404);res.end('Not found')}})
server.listen(0,'127.0.0.1',()=>{const url='http://127.0.0.1:'+server.address().port+'/';fs.writeFile(path.join(proof,'preview-server.json'),JSON.stringify({pid:process.pid,url,output:out}));console.log(JSON.stringify({url,pid:process.pid,loaded:loaded.length}))})
