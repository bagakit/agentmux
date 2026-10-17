import type { Client } from '@larksuiteoapi/node-sdk'
import type { ConnectionConfig, ConnectionProfileObservation, ConnectionProfileReason } from '@agentmux/core/connections'
import { CONNECTION_PROFILE_TRANSPORT_CODES, type ConnectionProfileDiagnostic } from '@agentmux/core/connections'
import { ProfilePreparationError } from '../../connection-profile-adapter.js'
import type { ConnectionProfileAdapter, ProfileEffect, ProfilePreparedRequest } from '../../connection-profile-adapter.js'

type WithClient = <T>(config: ConnectionConfig, credential: string, call: (client: Client) => Promise<T>, signal?: AbortSignal) => Promise<T>
type NativeFacts = Omit<ConnectionProfileDiagnostic, 'stage'>
/** The SDK callback may retain these primitives; no original exception or cause is kept. */
export class FeishuSdkRequestFailure extends Error {
  readonly code = 'FEISHU_SDK_REQUEST_FAILED'
  constructor(readonly facts: NativeFacts) { super('The original application request could not be confirmed.') }
}
export function feishuSdkRequestFailure(error: unknown): FeishuSdkRequestFailure {
  if (error instanceof FeishuSdkRequestFailure) return error
  const source = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  const transportCode = CONNECTION_PROFILE_TRANSPORT_CODES.find(code => code === source.code)
  const response = source.isAxiosError === true && source.response && typeof source.response === 'object' ? source.response as Record<string, unknown> : {}
  return new FeishuSdkRequestFailure({ ...(transportCode ? { transportCode } : {}),
    ...(Number.isSafeInteger(response.status) && Number(response.status) >= 100 && Number(response.status) <= 599 ? { httpStatus: Number(response.status) } : {}) })
}
const diagnostic = (stage: ConnectionProfileDiagnostic['stage'], error?: unknown): ConnectionProfileDiagnostic => ({ stage, ...(error instanceof FeishuSdkRequestFailure ? error.facts : {}) })
const object = (v: unknown): Record<string, unknown> => { if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('Unconfirmed profile response');return v as Record<string,unknown> }
const string = (v:unknown):string => {if(typeof v!=='string'||!v.trim()||/[\0\r\n]/u.test(v))throw new Error('Unconfirmed profile field');return v}
const description = (v:unknown):string => {if(typeof v!=='string'||v.includes('\0'))throw new Error('Unconfirmed profile description');return v}
const url = (v:unknown):string => {const s=string(v),u=new URL(s);if(u.protocol!=='https:'||u.username||u.password)throw new Error('Unconfirmed profile URL');return s}
const locale = (config:ConnectionConfig) => config.application.domain==='open.larksuite.com'?'en_us' as const:'zh_cn' as const
const prepared = (format:string,body:unknown):ProfilePreparedRequest => ({format,body:JSON.stringify(body)})
function i18nList(value:unknown): Array<{i18n_key:string;name?:string;description?:string;help_use?:string}> {
  if(!Array.isArray(value))throw new ProfilePreparationError('source-unconfirmed')
  const list=value.map(v=>{const i=object(v);if(Object.keys(i).some(k=>!['i18n_key','name','description','help_use'].includes(k)))throw new ProfilePreparationError('source-unconfirmed');return {i18n_key:string(i.i18n_key),...(i.name===undefined?{}:{name:string(i.name)}),...(i.description===undefined?{}:{description:description(i.description)}),...(i.help_use===undefined?{}:{help_use:string(i.help_use)})}})
  if(new Set(list.map(i=>i.i18n_key)).size!==list.length)throw new ProfilePreparationError('source-unconfirmed')
  return list
}

function native(request:ProfilePreparedRequest,format:string,config:ConnectionConfig):Record<string,unknown> {
  if(request.format!==format)throw new Error('Unsupported frozen profile format')
  const p=object(JSON.parse(request.body));if(p.appId!==config.application.appId)throw new Error('Wrong frozen profile application');return p
}
function response(v:unknown):Record<string,unknown>{const p=object(v);if(!Number.isSafeInteger(p.code))throw new Error('Unconfirmed profile status');return p}
function refusal(code:unknown):ConnectionProfileReason|undefined {
  if([210004,210005,210021].includes(code as number))return 'creation-origin-unsupported'
  if([210006,210007,99991672,99991663,99991668].includes(code as number))return 'permission-required'
  if(code===210010)return 'application-under-review'
  if([210002,210011].includes(code as number))return 'platform-rejected'
  return undefined
}
function effect(p:Record<string,unknown>):ProfileEffect {
  if(p.code===0){if(p.data!==undefined)object(p.data);return {state:'confirmed'}}
  return refusal(p.code)?{state:'refused',reason:refusal(p.code)!,diagnostic:{stage:'patch',nativeCode:Number(p.code)}}:{state:'unknown',reason:'effect-unconfirmed',diagnostic:{stage:'patch',nativeCode:Number(p.code)}}
}
/** Official tenant self-management leaf. A write never calls publication or infers creation origin. */
export function createFeishuProfile(withClient:WithClient):ConnectionProfileAdapter {
  return {
    prepareUpload(config,pngDataUrl){return prepared('feishu-profile-png-v1',{appId:config.application.appId,pngDataUrl})},
    async upload(config,request,credential,signal){
      try {
        const p=native(request,'feishu-profile-png-v1',config),data=string(p.pngDataUrl)
        if(!data.startsWith('data:image/png;base64,'))throw new Error('Wrong frozen image')
        const bytes=Buffer.from(data.slice(22),'base64')
        if(bytes.length>512*1024||bytes.length<24||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.toString('ascii',12,16)!=='IHDR'||bytes.readUInt32BE(16)!==256||bytes.readUInt32BE(20)!==256)return {state:'refused',reason:'source-unconfirmed',diagnostic:diagnostic('upload')}
        if(signal?.aborted)return {state:'not-dispatched',reason:'source-unconfirmed',diagnostic:diagnostic('upload')}
        return await withClient(config,credential,async client=>{
          try {
          // This SDK method unwraps {code,data:{url}} and returns {url}, unlike base.patch.
          const result=await client.application.v7.appAvatarUpload.create({data:{avatar:bytes}})
          return {state:'confirmed',avatarUrl:url(object(result).url)}
          } catch(error) { return {state:'unknown',reason:'effect-unconfirmed',diagnostic:diagnostic('upload',error)} }
        },signal)
      }catch{return {state:'unknown',reason:'effect-unconfirmed',diagnostic:diagnostic('upload')}}
    },
    async preparePatch(config,desired,avatarUrl,credential,signal){
      const fields={...(desired.name===undefined?{}:{name:desired.name}),...(desired.description===undefined?{}:{description:desired.description})}
      let baseline:unknown
      let i18ns: Array<{i18n_key: string; name?: string; description?: string; help_use?: string}> | undefined
      let nativeCode: number | undefined
      if(Object.keys(fields).length){
        try{
          const reading=await withClient(config,credential,async client=>{
            try{return {payload:await client.application.v6.application.get({path:{app_id:config.application.appId},params:{lang:locale(config)}})}}
            catch(error){return {diagnostic:diagnostic('prepare-patch',error)}}
          },signal)
          if('diagnostic' in reading)throw new ProfilePreparationError('source-unconfirmed',reading.diagnostic)
          const p=response(reading.payload);nativeCode=Number(p.code)
          if(p.code!==0)throw new ProfilePreparationError(refusal(p.code)??'source-unconfirmed')
          const app=object(object(p.data).app)
          if(app.app_id!==config.application.appId||!Array.isArray(app.i18n))throw new ProfilePreparationError('source-unconfirmed')
          i18ns=i18nList(app.i18n)
          baseline=structuredClone(i18ns)
          const index=i18ns.findIndex(i=>i.i18n_key===locale(config))
          if(index<0)i18ns.push({i18n_key:locale(config),...fields});else i18ns[index]={...i18ns[index]!,...fields}
        }catch(e){throw new ProfilePreparationError(e instanceof ProfilePreparationError?e.reason:'source-unconfirmed',e instanceof ProfilePreparationError&&e.diagnostic?e.diagnostic:{stage:'prepare-patch',...(nativeCode===undefined?{}:{nativeCode})})}
      }
      return {...prepared('feishu-profile-base-v1',{appId:config.application.appId,...(i18ns?{i18nBaseline:baseline}:{}),data:{...(i18ns?{i18ns}:{}),...(avatarUrl===undefined?{}:{avatar_url:url(avatarUrl)})}}),...(i18ns?{language:locale(config)}:{})}
    },
    async patch(config,request,credential,signal){
      let invoked=false
      try {
        const p=native(request,'feishu-profile-base-v1',config)
        if(signal?.aborted)return {state:'not-dispatched',reason:'source-unconfirmed',diagnostic:diagnostic('patch')}
        return await withClient(config,credential,async client=>{
          try {
          if(p.i18nBaseline!==undefined){
            const current=response(await client.application.v6.application.get({path:{app_id:config.application.appId},params:{lang:locale(config)}}))
            if(current.code!==0)return {state:'not-dispatched',reason:refusal(current.code)??'source-unconfirmed',diagnostic:{stage:'patch',nativeCode:Number(current.code)}}
            const app=object(object(current.data).app)
            if(app.app_id!==config.application.appId||JSON.stringify(i18nList(app.i18n).sort((a,b)=>a.i18n_key.localeCompare(b.i18n_key)))!==JSON.stringify(i18nList(p.i18nBaseline).sort((a,b)=>a.i18n_key.localeCompare(b.i18n_key))))return {state:'not-dispatched',reason:'source-unconfirmed',diagnostic:diagnostic('patch')}
          }
          if(signal?.aborted)return {state:'not-dispatched',reason:'source-unconfirmed',diagnostic:diagnostic('patch')}
          invoked=true
          return effect(response(await client.application.v7.applicationBase.patch({path:{app_id:config.application.appId},data:object(p.data) as NonNullable<NonNullable<Parameters<Client['application']['v7']['applicationBase']['patch']>[0]>['data']>})))
          }catch(error){return {state:invoked?'unknown':'not-dispatched',reason:invoked?'effect-unconfirmed':'source-unconfirmed',diagnostic:diagnostic('patch',error)}}
        },signal)
      }catch{return {state:invoked?'unknown':'not-dispatched',reason:invoked?'effect-unconfirmed':'source-unconfirmed',diagnostic:diagnostic('patch')}}
    },
    async get(config,revision,credential,signal){
      const observed:ConnectionProfileObservation={connectionId:config.connectionId,connectionRevision:revision,application:config.application,language:locale(config),state:'unknown',profile:null,metadata:null,botId:null,onlineVersionId:null,reviewingVersionId:null,version:null,...(config.application.domain==='open.feishu.cn'?{managementUrl:'https://open.feishu.cn/app'}:{})}
      let botObserved=false,appObserved=false
      try{await withClient(config,credential,async client=>{
        try {
          const p=response(await client.request({url:'/open-apis/bot/v3/info',method:'GET'}))
          if(p.code===0){const b=object(p.bot);observed.botId=string(b.open_id);observed.profile={...(b.app_name===undefined?{}:{name:string(b.app_name)}),...(b.avatar_url===undefined?{}:{avatarUrl:url(b.avatar_url)})};botObserved=true}
        }catch{/* Bot fields remain unknown independently of application read permissions. */}
        if(signal?.aborted)return
        try {
          const p=response(await client.application.v6.application.get({path:{app_id:config.application.appId},params:{lang:locale(config)}}))
          if(p.code!==0){observed.reason=refusal(p.code)??'online-unconfirmed';return}
          const app=object(object(p.data).app)
          if(app.app_id!==config.application.appId)throw new Error('Wrong application observation')
          observed.metadata={...(app.description===undefined?{}:{description:description(app.description)})}
          observed.onlineVersionId=app.online_version_id?string(app.online_version_id):null
          observed.reviewingVersionId=app.unaudit_version_id?string(app.unaudit_version_id):null;appObserved=true
          if(!observed.onlineVersionId)return
          const pver=response(await client.application.v6.applicationAppVersion.get({path:{app_id:config.application.appId,version_id:observed.onlineVersionId},params:{lang:locale(config)}}))
          if(pver.code!==0){observed.reason=refusal(pver.code)??'online-unconfirmed';return}
          const ver=object(object(pver.data).app_version)
          if(ver.app_id!==config.application.appId||ver.version_id!==observed.onlineVersionId)throw new Error('Wrong online application version')
          const status=({0:'unknown',1:'approved',2:'rejected',3:'reviewing',4:'unsubmitted'} as const)[ver.status as 0|1|2|3|4]
          if(typeof ver.status!=='number'||status===undefined)throw new Error('Unknown application version status')
          observed.version={versionId:observed.onlineVersionId,status}
          if(ver.description!==undefined)observed.profile={...observed.profile,description:description(ver.description)}
        }catch{observed.reason='online-unconfirmed'}
      },signal)}catch{observed.reason='online-unconfirmed'}
      observed.state=botObserved||appObserved?'observed':'unknown'
      return observed
    }
  }
}
