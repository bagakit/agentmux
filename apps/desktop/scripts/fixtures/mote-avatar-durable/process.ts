import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ConfigStore, DEFAULT_CONFIG } from '../../../src/main/config-store'
import { ConfigOwner } from '../../../src/main/config-owner'
import { saveObjectAvatarFile, readObjectAvatarFile } from '../../../src/main/object-avatar-files'
import { restoreSpaceIconOverrides } from '../../../src/shared/space-object-appearance'
import { DEFAULT_MOTE_FACE } from '../../../src/shared/mote-avatars'
import { readSpatialAppearance } from '../../../src/renderer/src/lib/mobile-presentation'

const root=process.env.AVATAR_FIXTURE_ROOT!, mode=process.argv[2]!, original=join(root,'motes','one'), other=join(root,'motes','two')
const key=JSON.stringify(['local',original]), otherKey=JSON.stringify(['local',other])
const store=new ConfigStore(join(root,'user-data','config.json'))
async function run(){
  let config
  if(mode==='write'){
    await mkdir(original,{recursive:true});await mkdir(other,{recursive:true})
    config=await store.save({...structuredClone(DEFAULT_CONFIG),appearance:{terminalTheme:'graphite',spaceObjectIcons:{}},
      workspaces:[{id:'__scratch__',hostId:'local',path:join(root,'motes'),name:'Motes',kind:'folder'}]})
  } else config=await store.get()
  const owner=new ConfigOwner({read:()=>config,save:next=>store.save(next),publish:saved=>{config=saved}})
  const saveChoice=async(key:string,value:unknown)=>{const before=owner.current;await owner.edit(before,{...before,appearance:{...before.appearance,spaceObjectIcons:{...before.appearance.spaceObjectIcons,[key]:value}}})}
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64')
  if(mode==='write'){
    await saveChoice(key,await saveObjectAvatarFile(original,png))
    await saveChoice(otherKey,{...DEFAULT_MOTE_FACE,eyes:'spark',marking:'freckles'})
  }
  const topics=[{id:'view:one',title:'One',directoryPath:original,topicPath:join(original,'topic.md'),collaborators:[],summary:'',soul:{path:'SOUL.md',content:'Mote',version:'one'}},
    {id:'view:two',title:'Two',directoryPath:other,topicPath:join(other,'topic.md'),collaborators:[],summary:'',soul:{path:'SOUL.md',content:'Mote',version:'one'}}]
  const projection=await readSpatialAppearance({config:owner.current,spaceObjectIcons:restoreSpaceIconOverrides(owner.current.appearance.spaceObjectIcons),spaceZoneBindings:{},sessions:[],timelines:{}} as never,{spaces:[{kind:'mote',spaceId:key,hostId:'local',topicId:'view:one'},{kind:'mote',spaceId:otherKey,hostId:'local',topicId:'view:two'}]} as never,key,topics,
    async(target,ref)=>{if(target.objectKey!==key)throw Error('wrong original object');return {dataUrl:'data:image/png;base64,'+(await readObjectAvatarFile(original,ref)).toString('base64'),width:1,height:1}})
  console.log(JSON.stringify({pid:process.pid,packageLocation:process.cwd(),choices:restoreSpaceIconOverrides(owner.current.appearance.spaceObjectIcons),projection,png:png.toString('base64')}))
}
run().catch(cause=>{console.error(cause);process.exitCode=1})
