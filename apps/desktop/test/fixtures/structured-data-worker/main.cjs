const { fixtureClock: _hygiene_fixtureClock } = require("../../../scripts/lib/fixture-values.mjs")
const {app,BrowserWindow}=require('electron'),fs=require('node:fs/promises'),assert=require('node:assert/strict')
const [html,profile,output]=process.argv.slice(2);app.setPath('userData',profile)
const report={passed:false,pid:process.pid,samples:[]};let win
app.whenReady().then(async()=>{try{
  win=new BrowserWindow({show:false,width:1100,height:750,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}})
  await win.loadFile(html);const evaluate=code=>win.webContents.executeJavaScript(code,true)
  const until=Date.now()+10000;while(!await evaluate('Boolean(window.structuredProbe)')){if(Date.now()>until)throw Error('Fixture did not mount');await new Promise(resolve=>setTimeout(resolve,10))}
  const yaml=Array.from({length:34000},(_,index)=>`key${index}: value for this entry\n`).join('')
  for(const[kind,content]of[['yaml',yaml],['toml',("value = 9223372036854775807\nwhen = " + _hygiene_fixtureClock(7, 32, 0, 123456789, 9))],['jsonl','{"id":9223372036854775807}\n{bad}\nfalse']]){
    const sample=await evaluate(`structuredProbe.sample(${JSON.stringify(kind)},${JSON.stringify(content)})`);report.samples.push(sample)
    assert.ok(sample.maxTimerGap<150,'Bounded worker clone+DOM preserve UI responsiveness: '+JSON.stringify(sample));assert.ok(sample.elements<1000);assert.equal(sample.workers.length,1);assert.equal(sample.workers[0].terminated,true)
    if(kind==='toml')assert.ok(sample.text.includes('123456789')||sample.text.includes('Temporal is unavailable'))
  }
  report.hidden=await evaluate(`structuredProbe.hidden(${JSON.stringify(yaml)})`)
  assert.equal(report.hidden.hiddenStarts,0);assert.equal(report.hidden.workers.length,1);assert.equal(report.hidden.workers[0].terminated,true);assert.equal(report.hidden.empty,true);assert.ok(report.hidden.hideElapsed<150)
  report.passed=true
}catch(error){report.failure={message:error.message,stack:error.stack}}
finally{await fs.writeFile(output,JSON.stringify(report,null,2));app.exit(report.passed?0:1)}})
