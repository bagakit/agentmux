import { afterEach, expect, it, vi } from 'vitest'
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import zlib, { gunzipSync, type Gzip } from 'node:zlib'
import { syncBuiltinESMExports } from 'node:module'
import type { Socket } from 'node:net'
import { MobileAssetsOwner } from '../src/mobile-assets-owner.js'
import { mobileDigest } from '../src/mobile-assets.js'

const cleanup: Array<() => Promise<unknown>> = []
const evidence = process.env.MOBILE_ASSET_TRANSFER_EVIDENCE!
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.restoreAllMocks();syncBuiltinESMExports()})
async function release(directory:string,buildId:string,large=false) {
  const js=Buffer.from(large?'window.largeTransfer='+JSON.stringify(randomBytes(9*1024*1024).toString('base64'))+';':
    "window.assetTransferSentinel='Original decoded JavaScript 原字节🙂';sessionStorage.setItem('transfer-loads',String(Number(sessionStorage.getItem('transfer-loads')||0)+1));\n"+'// original source\n'.repeat(1000))
  const css=Buffer.from('body{color:rgb(20,30,40)}\n'+'/* original style */\n'.repeat(1000))
  const html=Buffer.from('<!doctype html><meta charset="utf-8"><title>Original transfer</title><link rel="stylesheet" href="./assets/app.css"><body>Original byte-preserving mobile transfer<script src="./assets/app.js"></script></body>'+'<!-- original document -->'.repeat(100))
  const binary=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),randomBytes(2048)])
  const bytes=new Map([['index.html',html],['assets/app.js',js],['assets/app.css',css],['assets/original.png',binary]])
  await mkdir(join(directory,'assets'),{recursive:true})
  for(const [file,body] of bytes)await writeFile(join(directory,file),body)
  const body={schema:'agentmux.mobile-web-release.v1',buildId,files:[...bytes].sort(([left],[right])=>left.localeCompare(right)).map(([path,data])=>({path,bytes:data.length,digest:mobileDigest(data)}))}
  const manifest={...body,digest:mobileDigest(JSON.stringify(body))}
  await writeFile(join(directory,'mobile-release.json'),JSON.stringify(manifest))
  return {manifest,bytes}
}
async function fixture(large=false) {
  const root=await mkdtemp(join(tmpdir(),'amux-mobile-transfer-'))
  cleanup.push(()=>rm(root,{recursive:true,force:true}))
  const initial=await release(join(root,'release-a'),'release-a',large), owner=new MobileAssetsOwner()
  await owner.initialize(join(root,'release-a'))
  const sockets=new Set<Socket>(), counts=new Map<string,number>(), requests:unknown[]=[]
  const server=createServer((req,res)=>{
    const path=new URL(req.url??'/','http://localhost').pathname
    counts.set(path,(counts.get(path)??0)+1);requests.push({path,method:req.method,encoding:req.headers['accept-encoding']??null})
    owner.route(req,res)
  })
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket))})
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done))
  cleanup.push(async()=>{for(const s of sockets)s.destroy();await new Promise<void>(done=>server.close(()=>done()))})
  const port=(server.address() as {port:number}).port,origin='http://127.0.0.1:'+port
  const namespace='/mobile/'+initial.manifest.buildId+'/'+initial.manifest.digest.slice(7)+'/'
  const publish=async(name:string,revision:number)=>{
    const next=await release(join(root,name),name)
    const result=await owner.activate({hostId:'local',operationId:name,candidatePath:name,candidateDigest:next.manifest.digest,expectedActiveRevision:revision},
      {hostId:'local',agentSessionId:'isolated-author',runId:'isolated-run',workspacePath:root,assertCurrent:async()=>{}})
    expect(result.status).toBe('active');return next
  }
  return{root,owner,origin,namespace,initial,counts,requests,publish}
}
function wire(url:string,headers:IncomingHttpHeaders={},method='GET') {
  return new Promise<{status:number;headers:IncomingHttpHeaders;body:Buffer}>((accept,reject)=>{
    const req=request(url,{method,headers},res=>{const chunks:Buffer[]=[];res.on('data',data=>chunks.push(data));res.once('error',reject);res.once('end',()=>accept({status:res.statusCode!,headers:res.headers,body:Buffer.concat(chunks)}))})
    req.once('error',reject);req.end()
  })
}
it('negotiates gzip through original HTTP and preserves exact JS CSS HTML binary and HEAD bytes',async()=>{
  const f=await fixture()
  const observations=[]
  for(const path of ['assets/app.js','assets/app.css','index.html']) {
    const encoded=await wire(f.origin+f.namespace+path,{'accept-encoding':'gzip'})
    expect(encoded.status).toBe(200)
    expect(encoded.headers['content-encoding'],'Gzip-capable text uses the original streaming compressor').toBe('gzip')
    expect(encoded.headers.vary).toBe('Accept-Encoding')
    expect(gunzipSync(encoded.body)).toEqual(f.initial.bytes.get(path))
    expect(encoded.body.length).toBeLessThan(f.initial.bytes.get(path)!.length)
    for(const encoding of ['gzip;q=0','br','identity','gzip;q=0, *;q=1']) {
      const identity=await wire(f.origin+f.namespace+path,{'accept-encoding':encoding})
      expect(identity.headers['content-encoding']).toBeUndefined();expect(identity.body).toEqual(f.initial.bytes.get(path))
    }
    const wildcard=await wire(f.origin+f.namespace+path,{'accept-encoding':'br;q=0, *;q=0.5'})
    expect(wildcard.headers['content-encoding']).toBe('gzip');expect(gunzipSync(wildcard.body)).toEqual(f.initial.bytes.get(path))
    const head=await wire(f.origin+f.namespace+path,{'accept-encoding':'gzip'},'HEAD')
    expect(head.status).toBe(200);expect(head.body.length).toBe(0)
    observations.push({path,originalBytes:f.initial.bytes.get(path)!.length,wireBytes:encoded.body.length,headers:encoded.headers})
  }
  const binary=await wire(f.origin+f.namespace+'assets/original.png',{'accept-encoding':'gzip'})
  expect(binary.headers['content-encoding']).toBeUndefined();expect(binary.body).toEqual(f.initial.bytes.get('assets/original.png'))
  await expect.poll(()=>(f.owner as any).responseCount).toBe(0)
  expect((f.owner as any).sending.size).toBe(0)
  await writeFile(join(evidence,'http-byte-consumer.json'),JSON.stringify({observations,binaryBytes:binary.body.length,active:f.owner.inspect({hostId:'local'}).active},null,2))
})
it('ordinary Chromium document navigations reuse original namespace scripts and styles while HTML is read again',async()=>{
  const f=await fixture(),output=join(evidence,'browser')
  const env={...process.env,MOBILE_ASSET_TRANSFER_BROWSER_INPUT:JSON.stringify({origin:f.origin,evidence:output})};delete env.ELECTRON_RUN_AS_NODE
  const child=spawn(process.execPath,[resolve('apps/desktop/node_modules/electron/cli.js'),resolve('apps/host/test/fixtures/mobile-asset-transfer-browser.cjs')],{env,stdio:['ignore','pipe','pipe']})
  cleanup.push(async()=>{if(child.exitCode===null&&child.signalCode===null){const stopped=once(child,'exit');child.kill('SIGTERM');await stopped}await rm(join(output,'profile'),{recursive:true,force:true})})
  let log='';child.stdout.on('data',data=>{log+=data;process.stderr.write('private-transfer-browser: '+data)});child.stderr.on('data',data=>{log+=data;process.stderr.write('private-transfer-browser: '+data)})
  const code=await new Promise<number|null>((done,reject)=>{child.once('error',reject);child.once('exit',done)})
  expect(code,log).toBe(0)
  const browser=JSON.parse(await readFile(join(output,'receipt.json'),'utf8'))
  expect(browser.passed).toBe(true);expect(browser.navigations).toHaveLength(2)
  const encodings=browser.responses.filter((row:any)=>row.url.endsWith('/assets/app.js')||row.url.endsWith('/assets/app.css')).flatMap((row:any)=>row.headers?.['Content-Encoding']??row.headers?.['content-encoding']??[])
  expect(encodings.length).toBeGreaterThanOrEqual(2);expect(encodings.every((value:string)=>value==='gzip')).toBe(true)
  expect(f.counts.get(f.namespace+'index.html'),'Every ordinary navigation must reread the original HTML').toBe(2)
  expect(f.counts.get(f.namespace+'assets/app.js'),'Ordinary Chromium navigation reuses the original cached JavaScript').toBe(1)
  expect(f.counts.get(f.namespace+'assets/app.css'),'Ordinary Chromium navigation reuses the original cached stylesheet').toBe(1)
  expect(browser.navigations[1].resources.filter((row:any)=>/\/assets\/app\.(js|css)$/u.test(row.name)).every((row:any)=>row.transferSize===0&&row.decodedBodySize>0),'Original browser Resource Timing confirms cached decoded scripts and styles').toBe(true)
  await writeFile(join(evidence,'browser-http-counts.json'),JSON.stringify({counts:[...f.counts],requests:f.requests},null,2))
})
it('keeps current previous entry recovery and errors no-store when old namespace resources retire',async()=>{
  const f=await fixture(),old=f.namespace
  expect((await wire(f.origin+'/')).headers['cache-control']).toBe('no-store')
  expect((await wire(f.origin+old+'index.html')).headers['cache-control']).toBe('no-store')
  await f.publish('release-b',0)
  expect((await wire(f.origin+old+'index.html')).status).toBe(200)
  await f.publish('release-c',1)
  const retired=await wire(f.origin+old+'index.html?original=kept')
  expect(retired.status).toBe(302);expect(retired.headers.location).toContain('index.html?original=kept');expect(retired.headers['cache-control']).toBe('no-store')
  for(const path of [old+'assets/app.js','/unknown-resource']) {
    const failure=await wire(f.origin+path)
    expect([404,410]).toContain(failure.status);expect(failure.headers['cache-control']).toBe('no-store');expect(failure.headers['content-encoding']).toBeUndefined()
  }
  expect(f.owner.inspect({hostId:'local'}).retained.map(value=>value.buildId)).toEqual(['release-c','release-b'])
})
it('backpressures the actual gzip producer and releases original response and sending budgets after client abort',async()=>{
  const producers:Gzip[]=[],real=zlib.createGzip
  vi.spyOn(zlib,'createGzip').mockImplementation((...args:Parameters<typeof real>)=>{const producer=real(...args);producers.push(producer);return producer})
  syncBuiltinESMExports()
  const f=await fixture(true),before=f.owner.inspect({hostId:'local'}).active
  let incoming:IncomingMessage|undefined
  const pending=request(f.origin+f.namespace+'assets/app.js',{headers:{'accept-encoding':'gzip'}},res=>{incoming=res;res.pause()})
  pending.on('error',()=>{});pending.end();cleanup.push(async()=>{incoming?.destroy();pending.destroy()})
  await expect.poll(()=>incoming?.statusCode).toBe(200)
  await expect.poll(()=>producers.length).toBe(1)
  const producer=producers[0]!
  let previous=-1,stable=0
  await expect.poll(()=>{const now=producer.bytesWritten;stable=now===previous?stable+1:0;previous=now;return stable},{interval:60,timeout:5000}).toBeGreaterThanOrEqual(3)
  const paused={readableHighWaterMark:producer.readableHighWaterMark,writableHighWaterMark:producer.writableHighWaterMark,consumed:producer.bytesWritten,readableLength:producer.readableLength,writableLength:producer.writableLength,total:f.initial.bytes.get('assets/app.js')!.length}
  expect(paused.consumed).toBeGreaterThan(0);expect(paused.consumed).toBeLessThan(paused.total)
  expect(producer.destroyed).toBe(false);expect((f.owner as any).responseCount).toBe(1)
  expect([...((f.owner as any).sending as Map<unknown,number>).values()]).toEqual([1])
  expect(f.owner.inspect({hostId:'local'}).active).toEqual(before)
  const stopped=new Promise<void>(done=>producer.once('close',()=>done()));incoming!.destroy();pending.destroy();await stopped
  await expect.poll(()=>producer.destroyed).toBe(true)
  await expect.poll(()=>(f.owner as any).responseCount).toBe(0)
  expect((f.owner as any).sending.size).toBe(0)
  const stoppedAt=producer.bytesWritten;await new Promise(done=>setTimeout(done,60));expect(producer.bytesWritten).toBe(stoppedAt)
  const healthy=await wire(f.origin+f.namespace+'assets/app.css',{'accept-encoding':'gzip'})
  expect(healthy.status).toBe(200);expect(gunzipSync(healthy.body)).toEqual(f.initial.bytes.get('assets/app.css'))
  await expect.poll(()=>(f.owner as any).responseCount).toBe(0)
  expect(f.owner.inspect({hostId:'local'}).active).toEqual(before)
  await writeFile(join(evidence,'backpressure-abort.json'),JSON.stringify({paused,stoppedAt,producerDestroyed:producer.destroyed,responseCount:(f.owner as any).responseCount,sending:(f.owner as any).sending.size,healthyStatus:healthy.status},null,2))
})
