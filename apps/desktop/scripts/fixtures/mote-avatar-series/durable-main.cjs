const {app,nativeImage}=require('electron')
const fs=require('node:fs/promises'),path=require('node:path')
const [compiled,directory,builtinRoot,runtimeRoot]=process.argv.slice(2)
app.setPath('home',path.join(directory,'home'));app.setPath('userData',path.join(directory,'userData'))
app.whenReady().then(async()=>{
  const {MoteAvatarSeriesOwner,MoteAvatarControl,createMoteAvatarWriter,ConfigStore,ConfigOwner,DEFAULT_CONFIG,ScratchTopics,AgentMuxControlServer,observeClientRpcSnapshot}=require(path.join(compiled,'writer-entry.cjs'))
  const store=new ConfigStore(path.join(directory,'config.json'))
  try {await fs.access(store.filePath)} catch(error) {if(error.code!=='ENOENT')throw error;await store.save(DEFAULT_CONFIG)}
  let config=await store.get()
  const topics=new ScratchTopics(),scratch=config.workspaces.find(value=>value.id==='__scratch__')
  if(!scratch)throw Error('Original private Scratch workspace missing')
  for(const id of ['launcher:leader','launcher:legacy-face','launcher:legacy-image','launcher:legacy-glyph'])await topics.ensureMote(scratch,id)
  const sources=new MoteAvatarSeriesOwner({userRoot:path.join(directory,'avatars'),builtinRoot})
  const configOwner=new ConfigOwner({read:()=>config,save:next=>store.save(next),publish:saved=>{config=saved}})
  const picture=nativeImage.createFromPath(path.join(builtinRoot,'lowpoly/lowpoly-owl.png')),size=picture.getSize(),edge=Math.min(size.width,size.height)
  const frame=picture.crop({x:Math.floor((size.width-edge)/2),y:Math.floor((size.height-edge)/2),width:edge,height:edge}).resize({width:256,height:256,quality:'best'}).toPNG()
  await fs.writeFile(path.join(directory,'caller-frame.png'),frame)
  if (!config.appearance.spaceObjectIcons) {
    const facts=await observeClientRpcSnapshot(config,topics,{include:['motes']})
    const targets=Object.fromEntries(facts.motes.map(mote=>[mote.topicId,{workspaceId:mote.workspaceId,topicId:mote.topicId,objectKey:mote.spaceId}]))
    const imageTarget=targets['launcher:legacy-image']
    const legacyImage=await topics.saveAvatar(scratch,imageTarget.topicId,{mimeType:'image/png',dataUrl:'data:image/png;base64,'+frame.toString('base64')},imageTarget.objectKey)
    await configOwner.update(current=>({...current,appearance:{...current.appearance,spaceObjectIcons:{
      [targets['launcher:legacy-glyph'].objectKey]:'rocket',
      [targets['launcher:legacy-face'].objectKey]:{kind:'face',shape:'soft',palette:'mint',eyes:'round',brows:'soft',mouth:'smile',accessory:'tuft'},
      [imageTarget.objectKey]:legacyImage
    }}}))
  }
  const writer=createMoteAvatarWriter(configOwner,sources,topics,store)
  const control=new MoteAvatarControl(sources,writer)
  const server=new AgentMuxControlServer({moteAvatars:control,coreClients:()=>[],socketPath:path.join(runtimeRoot,'control.sock.desktop'),snapshot:params=>observeClientRpcSnapshot(config,topics,params)})
  await server.start()
  await fs.writeFile(path.join(directory,'durable-ready.json'),JSON.stringify({pid:process.pid,socket:server.path,actualNativeImage:nativeImage.createEmpty().isEmpty(),configPath:store.filePath,privateHome:app.getPath('home')}))
  process.on('SIGTERM',()=>{void server.stop().then(()=>app.quit())})
}).catch(error=>{console.error(error);app.exit(1)})
