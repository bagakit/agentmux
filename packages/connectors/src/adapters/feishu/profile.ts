import type { Client } from '@larksuiteoapi/node-sdk'
import type { ConnectionConfig, ConnectionProfileObservation, ConnectionProfileReason } from '@agentmux/core/connections'

type WithClient = <T>(config: ConnectionConfig, credential: string, call: (client: Client) => Promise<T>, signal?: AbortSignal) => Promise<T>
type ProfileReader = { get(config: ConnectionConfig, revision: number, credential: string, signal?: AbortSignal): Promise<ConnectionProfileObservation> }
const object = (v: unknown): Record<string, unknown> => { if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('Unconfirmed profile response');return v as Record<string,unknown> }
const string = (v:unknown):string => {if(typeof v!=='string'||!v.trim()||/[\0\r\n]/u.test(v))throw new Error('Unconfirmed profile field');return v}
const description = (v:unknown):string => {if(typeof v!=='string'||v.includes('\0'))throw new Error('Unconfirmed profile description');return v}
const url = (v:unknown):string => {const s=string(v),u=new URL(s);if(u.protocol!=='https:'||u.username||u.password)throw new Error('Unconfirmed profile URL');return s}
const locale = (config:ConnectionConfig) => config.application.domain==='open.larksuite.com'?'en_us' as const:'zh_cn' as const

function response(v:unknown):Record<string,unknown>{const p=object(v);if(!Number.isSafeInteger(p.code))throw new Error('Unconfirmed profile status');return p}
function refusal(code:unknown):ConnectionProfileReason|undefined {
  if([210004,210005,210021].includes(code as number))return 'creation-origin-unsupported'
  if([210006,210007,210508,99991672,99991663,99991668].includes(code as number))return 'permission-required'
  if(code===210010)return 'application-under-review'
  if([210002,210011].includes(code as number))return 'platform-rejected'
  return undefined
}
/** Independent official online observations. Existing application writes belong to Console Setup. */
export function createFeishuProfile(withClient: WithClient): ProfileReader {
  return {
    async get(config,revision,credential,signal){
      const observed:ConnectionProfileObservation={connectionId:config.connectionId,connectionRevision:revision,application:config.application,language:locale(config),state:'unknown',profile:null,metadata:null,creator:null,botId:null,onlineVersionId:null,reviewingVersionId:null,version:null,...(config.application.domain==='open.feishu.cn'?{managementUrl:'https://open.feishu.cn/app'}:{})}
      let botObserved=false,appObserved=false
      try{await withClient(config,credential,async client=>{
        try {
          const p=response(await client.request({url:'/open-apis/bot/v3/info',method:'GET'}))
          if(p.code===0){const b=object(p.bot);observed.botId=string(b.open_id);observed.profile={...(b.app_name===undefined?{}:{name:string(b.app_name)}),...(b.avatar_url===undefined?{}:{avatarUrl:url(b.avatar_url)})};botObserved=true}
        }catch{/* Bot fields remain unknown independently of application read permissions. */}
        if(signal?.aborted)return
        try {
          const p=response(await client.application.v6.application.get({path:{app_id:config.application.appId},params:{lang:locale(config),user_id_type:'open_id'}}))
          if(p.code!==0){observed.reason=refusal(p.code)??'online-unconfirmed';return}
          const app=object(object(p.data).app)
          if(app.app_id!==config.application.appId)throw new Error('Wrong application observation')
          appObserved=true
          // The requested native ID namespace belongs to this exact application, never the console account.
          if (typeof app.creator_id === 'string' && app.creator_id.trim() && !/[\u0000-\u001f\u007f]/u.test(app.creator_id)) observed.creator={idType:'open_id',userId:app.creator_id}
          observed.metadata={...(app.description===undefined?{}:{description:description(app.description)})}
          observed.onlineVersionId=app.online_version_id?string(app.online_version_id):null
          observed.reviewingVersionId=app.unaudit_version_id?string(app.unaudit_version_id):null
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
