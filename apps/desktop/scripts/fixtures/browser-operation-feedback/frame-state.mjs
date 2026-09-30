// Test-only observation of computed paint, converted by Chromium's own maintained Canvas API.
// The 1px OffscreenCanvas is never attached or presented and cannot obscure the original page.
export function feedbackPaintPreparation(moduleSource, outputSpace) {
  if (!['srgb', 'display-p3'].includes(outputSpace)) throw new Error('Unsupported observed display color space')
  const sheet = /sheet\.replaceSync\(`([^`]+)`\)/.exec(moduleSource)
  if (!sheet?.[1]) throw new Error('Actual product stylesheet unavailable')
  const colors = [...new Set((sheet[1] + moduleSource.match(/arrow\.setAttribute\('fill', '([^']+)'\)/)?.[1]).match(/#[\da-f]{6}|rgba?\([\d.,\s]+\)/gi))]
  if (!colors.length) throw new Error('Actual product paint palette is empty')
  return `(()=>{const canvas=new OffscreenCanvas(1,1),ctx=canvas.getContext('2d',{colorSpace:${JSON.stringify(outputSpace)}});
    if(!ctx||ctx.getContextAttributes().colorSpace!==${JSON.stringify(outputSpace)})throw new Error('Observed paint conversion unavailable');
    const key=color=>{let m=/^#([\\da-f]{6})$/i.exec(color);if(m)return [0,2,4].map(i=>parseInt(m[1].slice(i,i+2),16)).concat(1).join(',');
      m=/^rgba?\\(([-\\d.]+),\\s*([-\\d.]+),\\s*([-\\d.]+)(?:,\\s*([-\\d.]+))?\\)$/.exec(color);return m?[+m[1],+m[2],+m[3],m[4]===undefined?1:+m[4]].join(','):null};
    const cache={};for(const color of ${JSON.stringify(colors)}){ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);
      cache[key(color)]=Array.from(ctx.getImageData(0,0,1,1).data).map((v,i)=>i===3?v/255:v)}return {outputSpace:${JSON.stringify(outputSpace)},cache}})()`
}

export function withFeedbackFramePaint(originalExpression, prepared) {
  if (!prepared?.cache || !Object.keys(prepared.cache).length || !['srgb', 'display-p3'].includes(prepared.outputSpace)) throw new Error('Prepared actual paint cache unavailable')
  return `(()=>{const hud=${originalExpression};if(!hud?.hostConnected)return hud;const s=globalThis.__agentMuxBrowserOperationFeedback;
    const cache=${JSON.stringify(prepared.cache)},raster=color=>{const m=/^rgba?\\(([-\\d.]+),\\s*([-\\d.]+),\\s*([-\\d.]+)(?:,\\s*([-\\d.]+))?\\)$/.exec(color);
      return m?cache[[+m[1],+m[2],+m[3],m[4]===undefined?1:+m[4]].join(',')]??null:null};
    for(const [name,selector] of [['label','.label'],['executor','.executor'],['arrow','.pointer svg path']]){
      const item=hud[name],el=s.shadow?.querySelector(selector);if(!item||!el)continue;const css=getComputedStyle(el);
      item.paint={color:css.color,backgroundColor:css.backgroundColor,paddingTop:css.paddingTop,fill:css.fill,
        outputColor:raster(css.color),outputBackground:raster(css.backgroundColor),outputFill:raster(css.fill),outputSpace:${JSON.stringify(prepared.outputSpace)}};
    }return hud})()`
}
