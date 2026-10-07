import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHmac } from 'node:crypto'
import { vi } from 'vitest'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import type { ConnectionConfig, ConnectionProfileSync } from '@agentmux/core/connections'
import type { ConnectionProfileAdapter, ConnectionAdapter } from '@agentmux/connectors'
import { createDesktopConnections } from '../../../../apps/desktop/src/main/connector-host.js'
import { imagePng } from '../../../../apps/desktop/test/fixtures/mote-identity-image.js'
import { enrollmentEncryption } from './connection-enrollment.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../core/test/helpers/object-cli-rpc.js'

export const profilePng=imagePng(), profileDataUrl='data:image/png;base64,'+profilePng.toString('base64')
export type ProfileRequest={url?:string;method?:string;data?:Record<string,unknown>;signal?:AbortSignal}
export const originalI18n=[{i18n_key:'en_us',name:'Keep English',description:'Keep description',help_use:'https://docs.example.invalid/help'},{i18n_key:'zh_cn',name:'Old name',description:'Old description'}]
export async function profileFixture(options:{generic?:boolean;http?:(request:ProfileRequest)=>Promise<unknown>;profile?:Partial<ConnectionProfileAdapter>}={}) {
  const root=await mkdtemp(join(tmpdir(),'profile-')),directory=join(root,'connections'),socketPath=join(root,'owner.sock')
  const calls:ProfileRequest[]=[],effects:Array<{kind:string;preclaimed:boolean;data:unknown}>=[]
  let services!:Awaited<ReturnType<typeof createDesktopConnections>>,server:AgentMuxControlServer,sdk!:Awaited<ReturnType<typeof connectAgentMuxRpc>>
  const profile:ConnectionProfileAdapter={
    prepareUpload:(config,pngDataUrl)=>({format:'signed-image-v1',body:JSON.stringify({app:config.application,pngDataUrl})}),
    upload:vi.fn<ConnectionProfileAdapter['upload']>(async(config,wire)=>{effects.push({kind:'upload',preclaimed:preclaimed('upload'),data:wire});return {state:'confirmed',avatarUrl:'https://images.example.invalid/original.png'}}),
    preparePatch:(config,desired,avatarUrl)=>{const body=JSON.stringify({app:config.application,desired,avatarUrl});return {format:'signed-patch-v1',body:JSON.stringify({body,signature:createHmac('sha256','fixture-signing').update(body).digest('hex')})}},
    patch:vi.fn<ConnectionProfileAdapter['patch']>(async(config,wire)=>{const p=JSON.parse(wire.body);if(p.signature!==createHmac('sha256','fixture-signing').update(p.body).digest('hex')||JSON.parse(p.body).app.appId!==config.application.appId)throw new Error('Wrong signed request');effects.push({kind:'patch',preclaimed:preclaimed('patch'),data:p});return {state:'confirmed'}}),
    get:vi.fn<ConnectionProfileAdapter['get']>(async(config,revision)=>({connectionId:config.connectionId,connectionRevision:revision,application:config.application,language:null,state:'observed',profile:{name:'Observed original'},metadata:null,botId:'signed-bot',onlineVersionId:null,reviewingVersionId:null,version:null})),...options.profile
  }
  const adapter:ConnectionAdapter={adapterId:'signed-profile',profile,test:async()=>({authentication:{state:'ready'},transport:{state:'unknown'},intake:{state:'unknown'},delivery:{state:'unknown'}})}
  const preclaimed=(kind:string)=>{
    const row=services.database!.prepare('SELECT record_json FROM connection_profile_operation ORDER BY ordinal DESC LIMIT 1').get()
    return !!row&&JSON.parse(String(row.record_json))[kind].state==='dispatching'
  }
  if(!options.generic)vi.spyOn(defaultHttpInstance,'request').mockImplementation(async(request)=>{
    const r=request as ProfileRequest;if(r.url?.includes('/auth/v3/'))return {code:0,tenant_access_token:'fixture-tenant-access',app_access_token:'fixture-app-access',expire:3600}
    calls.push(r)
    if(r.method==='PATCH'||r.url?.endsWith('/app_avatar/upload'))effects.push({kind:r.method==='PATCH'?'patch':'upload',preclaimed:preclaimed(r.method==='PATCH'?'patch':'upload'),data:r.data})
    if(options.http)return options.http(r)
    if(r.url?.endsWith('/bot/v3/info'))return {code:0,bot:{open_id:'native-bot',app_name:'Online name',avatar_url:'https://images.example.invalid/online.png'}}
    if(r.url?.endsWith('/app_avatar/upload'))return {code:0,data:{url:'https://images.example.invalid/upload.png'}}
    if(r.method==='PATCH')return {code:0,data:{}}
    if(r.url?.includes('/app_versions/'))return {code:0,data:{app_version:{app_id:'cli_profile',version_id:'online-original',description:'Exact online description',status:1}}}
    return {code:0,data:{app:{app_id:'cli_profile',description:'Draft metadata description',online_version_id:'online-original',unaudit_version_id:'reviewing-original',i18n:structuredClone(originalI18n)}}}
  })
  const encryption=enrollmentEncryption()
  const open=async()=>{services=await createDesktopConnections({directory,encryption,...(options.generic?{adapters:[adapter]}:{})});server=new AgentMuxControlServer({socketPath,connections:services.connections,coreClients:()=>{throw new Error('Profile cannot borrow an Agent Runtime')}});await server.start();sdk=await connectAgentMuxRpc({endpoint:{transport:'unix',path:socketPath}})}
  const closeOwner=async()=>{await sdk?.dispose();await server?.stop();services?.close()}
  await open()
  const stored=await services.secrets.store({operationId:'profile-credential',secret:'private-profile-secret'})
  const config:ConnectionConfig={connectionId:'profile-connection',adapterId:options.generic?adapter.adapterId:'feishu',application:{domain:options.generic?'signed.example':'open.feishu.cn',appId:options.generic?'signed-profile-app':'cli_profile'},label:'Original profile bot',enabled:true,credentialRef:stored.credentialRef}
  await sdk.call('connection.configure',{operationId:'profile-configure',expectedRevision:null,connection:config})
  const input:ConnectionProfileSync={operationId:'profile-original',connectionId:config.connectionId,expectedConnectionRevision:1,desired:{name:'Desired name',description:'Desired description',avatar:{pngDataUrl:profileDataUrl}}}
  return {root,directory,input,config,profile,effects,calls,get services(){return services},get sdk(){return sdk},cli:(args:string[],body?:unknown)=>runCompiledObjectCli(['--endpoint','unix:'+socketPath,'connection','profile',...args],objectCliEnvironment(root),body===undefined?'':JSON.stringify(body)),closeOwner,reopen:open,close:async()=>{await closeOwner();await rm(root,{recursive:true,force:true})}}
}
