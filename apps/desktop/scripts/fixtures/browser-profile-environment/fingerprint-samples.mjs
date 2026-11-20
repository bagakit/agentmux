/** Only the observations needed to distinguish the existing five overrides. */
export const documentSample = `(async()=>{
  const canvas = document.createElement('canvas'); canvas.width=64; canvas.height=16;
  const ctx=canvas.getContext('2d'); ctx.font='14px monospace';
  ctx.fillStyle='#465078';ctx.fillRect(0,0,64,16);
  const fonts=ctx.measureText('Proof native metrics').width;
  const canvasReadback=canvas.toDataURL();
  const box=document.createElement('div');box.style.cssText='position:fixed;left:23px;top:36px;width:40px;height:50px';
  document.body.append(box);const clientRects=box.getBoundingClientRect().x;box.remove();
  const gl=document.createElement('canvas').getContext('webgl');
  const debug=gl?.getExtension('WEBGL_debug_renderer_info');
  const webgl=debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):null;
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  const audio=new OfflineAudioContext(1,1024,44100);const oscillator=audio.createOscillator();
  oscillator.connect(audio.destination);oscillator.start();
  const signal=(await audio.startRendering()).getChannelData(0);
  return {fonts,canvas:canvasReadback,clientRects,webgl,audio:[signal[0],signal[113],signal[226]],cookie:document.cookie};
})()`

export const workerSample = `
  const canvas = new OffscreenCanvas(64,16);
  const ctx=canvas.getContext('2d');ctx.font='14px monospace';
  ctx.fillStyle='#465078';ctx.fillRect(0,0,64,16);
  const gl=new OffscreenCanvas(64,16).getContext('webgl');
  const debug=gl?.getExtension('WEBGL_debug_renderer_info');
  const webgl=debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):null;
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  postMessage({ fonts:ctx.measureText('Proof native metrics').width,
    canvas:Array.from(ctx.getImageData(0,0,64,16).data), webgl,
    clientRects:typeof Element === 'undefined' ? 'unavailable' : 'available',
    audio:typeof OfflineAudioContext === 'undefined' ? 'unavailable' : 'available' })
`
