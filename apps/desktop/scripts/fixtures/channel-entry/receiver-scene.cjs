module.exports=async({read,until,click,capture,details,dismiss,result})=>{
 const set=values=>read('Object.assign(window.channelEntryProof.receiver,'+JSON.stringify(values)+')')
 const button=name=>'[data-receiver-action="'+name+'"]'
 await set({state:'ended'});await details('healthy','dark',1380);await until('document.querySelector("[data-receiver-action=recover]")');await capture('receiver-stopped-wide-dark');await dismiss()
 await set({state:'ended',longName:true});await details('healthy','light',520);await capture('receiver-stopped-narrow-light');await dismiss()
 await set({state:'ended',longName:false});await details('healthy','light',1380);await click(button('recover'));await until('document.querySelector(".connector-traffic-summary").textContent.includes("Reconnect requested")');await capture('receiver-scheduled-wide-light');await dismiss()
 await set({state:'ended',loseReply:true});await details('healthy','dark',520);await click(button('recover'));await until('document.querySelector(".connector-traffic-summary").textContent.includes("Recovery reply unconfirmed")');await capture('receiver-unknown-narrow-dark');await click(button('inspect'));await until('document.querySelector(".connector-traffic-summary").textContent.includes("Reconnect requested")');await dismiss()
 await set({state:'ready',refusal:true});await details('healthy','dark',1380);await until('document.querySelector(".connector-traffic-summary").textContent.includes("Message type not supported")');await capture('receiver-healthy-refusal-wide-dark');await dismiss()
 await set({state:'ready',refusal:false});await details('healthy','light',520);await until('document.querySelector(".connector-traffic-summary").textContent.includes("Receiver connected")');await capture('receiver-restored-narrow-light');await dismiss()
 result.receiverScope='Actual production Renderer/native input with typed visual leaves; no live SDK or management qualification.'
}
