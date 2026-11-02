const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const OFFICIAL='https://termine.staedteregion-aachen.de/auslaenderamt/personaldata';
const jpeg=size=>'data:image/jpeg;base64,'+'A'.repeat(size);
const run=(message='页面需要接手')=>({runId:'run-one',tabId:7,phase:'handoff',message,selected:{date:'2026-11-11',time:'08:30'}});
function event(){const listeners=new Set();return {addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn),emit:(...args)=>{for(const fn of [...listeners])fn(...args);},get size(){return listeners.size;}};}
function setup({permission=false,url=OFFICIAL,capture,diagnostic,stored=[]}={}){
  const data={diagnostics:structuredClone(stored)},calls=[],tabs=new Map([[7,{id:7,windowId:3,url}],[8,{id:8,windowId:3,url:'https://example.org/private'}]]);
  let active=7,now=10000,api,removeFails=false;
  class Clock extends Date{static now(){return now;}}
  const onActivated=event(),onUpdated=event(),onRemoved=event();
  const chrome={
    storage:{local:{get:async key=>({[key]:structuredClone(data[key])}),set:async value=>{calls.push(['store']);Object.assign(data,structuredClone(value));},remove:async key=>{calls.push(['remove',key]);if(removeFails)throw new Error('storage deletion failed');for(const item of Array.isArray(key)?key:[key])delete data[item];}}},
    permissions:{contains:async request=>{calls.push(['permission',request]);return permission;}},
    tabs:{
      onActivated,onUpdated,onRemoved,
      get:async id=>{calls.push(['get',id]);if(!tabs.has(id))throw new Error('No tab: '+id);return structuredClone(tabs.get(id));},
      query:async query=>{calls.push(['query',query]);return tabs.has(active)?[structuredClone(tabs.get(active))]:[];},
      sendMessage:async(id,message)=>{calls.push(['message',id,message]);return {diagnostic:diagnostic||{step:5,forms:[{id:'cal-reservation',method:'post',action:'/auslaenderamt/personaldata?token=secret#private',controls:[{tag:'INPUT',name:'vorname',type:'text',required:true,value:'PRIVATE USER VALUE'}]}]}};},
      captureVisibleTab:async(windowId,options)=>{calls.push(['capture',windowId,options]);return capture?capture(api):jpeg(100);}
    }
  };
  const context=vm.createContext({chrome,crypto:webcrypto,Date:Clock,URL,console});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../extension/diagnostics.js'),'utf8'),context);
  api={data,calls,tabs,events:{onActivated,onUpdated,onRemoved},record:(...args)=>context.TerminDiagnostics.record(...args),clear:()=>context.TerminDiagnostics.clear(),setRemoveFails:value=>{removeFails=value;},
    tick:ms=>{now+=ms;},activate:id=>{active=id;onActivated.emit({tabId:id,windowId:3});},
    navigate:(id,next)=>{tabs.get(id).url=next;onUpdated.emit(id,{url:next},tabs.get(id));},
    close:id=>{tabs.delete(id);onRemoved.emit(id,{windowId:3,isWindowClosing:false});}};
  return api;
}
test('without screenshot permission only sanitized local structure is stored and no permission is requested',async()=>{
  const env=setup();const entry=await env.record(run());
  assert.equal(entry.image,undefined);assert.match(entry.captureError,/未授权/);
  assert.equal(entry.diagnostic.step,5);assert.equal(env.calls.filter(call=>call[0]==='capture').length,0);
  assert.equal(env.calls.filter(call=>call[0]==='message').length,1);
  assert.equal(env.data.diagnostics.length,1);
  const serialized=JSON.stringify(env.data.diagnostics);
  assert.equal(serialized.includes('PRIVATE USER VALUE'),false);assert.equal(serialized.includes('"value"'),false);
  assert.equal(serialized.includes('token=secret'),false);assert.equal(serialized.includes('#private'),false);
});
test('authorized capture verifies the bound active tab before and after and stores a JPEG locally',async()=>{
  const env=setup({permission:true});const entry=await env.record(run());
  assert.equal(entry.image,jpeg(100));assert.equal(entry.captureError,undefined);
  assert.equal(entry.selected.date,'2026-11-11');assert.equal(entry.selected.time,'08:30');
  const capture=env.calls.find(call=>call[0]==='capture');assert.equal(capture[1],3);
  assert.deepEqual({...capture[2]},{format:'jpeg',quality:50});
  assert.equal(env.calls.filter(call=>call[0]==='query').length,2);
  assert.ok(env.calls.filter(call=>call[0]==='get').length>=3);
  assert.equal(env.events.onActivated.size,0);assert.equal(env.events.onUpdated.size,0);assert.equal(env.events.onRemoved.size,0);
});
test('an inactive bound tab is not activated and is never captured',async()=>{
  const env=setup({permission:true});env.activate(8);const entry=await env.record(run());
  assert.equal(entry.image,undefined);assert.match(entry.captureError,/不在其窗口当前显示/);
  assert.equal(env.calls.some(call=>call[0]==='capture'),false);
});
test('switching tabs during capture discards the image of a potentially unrelated page',async()=>{
  const env=setup({permission:true,capture:async api=>{api.activate(8);return jpeg(100);}});
  const entry=await env.record(run());assert.equal(entry.image,undefined);assert.match(entry.captureError,/不在其窗口当前显示|发生变化/);
  assert.equal(env.data.diagnostics[0].image,undefined);
});
test('switching away and back during capture also discards the image',async()=>{
  const env=setup({permission:true,capture:async api=>{api.activate(8);api.activate(7);return jpeg(100);}});
  const entry=await env.record(run());assert.equal(entry.image,undefined);assert.match(entry.captureError,/发生变化/);
});
test('leaving the official page or closing the bound tab during capture never stores its image',async()=>{
  for(const change of [api=>api.navigate(7,'https://example.org/private?token=secret'),api=>api.close(7)]){
    const env=setup({permission:true,capture:async api=>{change(api);return jpeg(100);}});
    const entry=await env.record(run());assert.equal(entry.image,undefined);assert.ok(entry.captureError);
    assert.equal(JSON.stringify(env.data.diagnostics).includes('example.org'),false);
  }
});
test('a nonofficial bound URL is not read or captured and sensitive URL parts are never persisted',async()=>{
  for(const url of ['https://example.org/auslaenderamt/personaldata?private=secret#private','https://termine.staedteregion-aachen.de/not-appointments?private=secret#private']){
    const env=setup({permission:true,url});const entry=await env.record(run(),{title:'ignored',value:'PRIVATE'});
    assert.equal(entry.image,undefined);assert.match(entry.captureError,/不在外管局官网/);
    assert.equal(env.calls.some(call=>['message','capture','query'].includes(call[0])),false);
    assert.equal(JSON.stringify(env.data.diagnostics).includes('secret'),false);
    assert.equal(Object.keys(entry.diagnostic).length,0);
  }
  const env=setup({permission:true,url:OFFICIAL+'?token=secret#private'});const entry=await env.record(run());
  assert.equal(entry.diagnostic.url,OFFICIAL);assert.equal(entry.image,jpeg(100));
  assert.equal(JSON.stringify(env.data.diagnostics).includes('secret'),false);
});
test('native capture failure keeps structure but does not retain sensitive exception text',async()=>{
  const env=setup({permission:true,capture:async()=>{throw new Error('Failure at '+OFFICIAL+'?private=secret');}});
  const entry=await env.record(run());assert.equal(entry.diagnostic.step,5);assert.equal(entry.image,undefined);
  assert.match(entry.captureError,/截图失败/);assert.equal(JSON.stringify(env.data.diagnostics).includes('private=secret'),false);
});
test('a supplied diagnostic skips DOM messaging and strips unknown data and nested values',async()=>{
  const env=setup();const entry=await env.record(run(),{step:5,url:OFFICIAL+'?sensitive=secret',profile:{email:'private@example.org'},forms:[{id:'cal-reservation',action:'/auslaenderamt/personaldata?secret=true',fields:[{name:'email',type:'email',value:'private@example.org'}]}]});
  assert.equal(env.calls.some(call=>call[0]==='message'),false);assert.equal(entry.diagnostic.forms[0].fields[0].name,'email');
  const serialized=JSON.stringify(entry);assert.equal(serialized.includes('private@example.org'),false);assert.equal(serialized.includes('sensitive=secret'),false);
});
test('serialized recording keeps all distinct concurrent events, deduplicates for five seconds and caps history at six',async()=>{
  const env=setup();await Promise.all(Array.from({length:8},(_,i)=>env.record(run('event '+i))));
  assert.equal(env.data.diagnostics.length,6);assert.deepEqual(env.data.diagnostics.map(item=>item.message),['event 2','event 3','event 4','event 5','event 6','event 7']);
  const count=env.calls.filter(call=>call[0]==='message').length;
  assert.equal(await env.record(run('event 7')),null);assert.equal(env.calls.filter(call=>call[0]==='message').length,count);
  env.tick(4999);assert.equal(await env.record(run('event 7')),null);
  env.tick(1);assert.ok(await env.record(run('event 7')));assert.equal(env.data.diagnostics.length,6);
});
test('queued recording snapshots the triggering run before the caller advances it',async()=>{
  const env=setup(),current=run('first event');
  const first=env.record(current);current.message='second event';current.phase='done';current.selected.time='09:00';
  const second=env.record(current);await Promise.all([first,second]);
  assert.equal(env.data.diagnostics.length,2);
  assert.equal(env.data.diagnostics[0].message,'first event');assert.equal(env.data.diagnostics[0].phase,'handoff');assert.equal(env.data.diagnostics[0].selected.time,'08:30');
  assert.equal(env.data.diagnostics[1].message,'second event');assert.equal(env.data.diagnostics[1].selected.time,'09:00');
});
test('image capacity evicts the oldest records and an oversized image leaves a useful diagnostic',async()=>{
  const env=setup({permission:true,capture:async()=>jpeg(1400000)});
  for(let i=0;i<4;i++)await env.record(run('image '+i));
  assert.deepEqual(env.data.diagnostics.map(item=>item.message),['image 2','image 3']);
  assert.ok(env.data.diagnostics.reduce((sum,item)=>sum+(item.image?.length||0),0)<=4*1024*1024);
  const tooLarge=setup({permission:true,capture:async()=>jpeg(1.5*1024*1024)});
  const entry=await tooLarge.record(run());assert.equal(entry.image,undefined);assert.equal(entry.diagnostic.step,5);assert.match(entry.captureError,/1.5 MiB/);
});
test('storage or initial tab failure resolves without interrupting booking',async()=>{
  const env=setup();env.close(7);const entry=await env.record(run());assert.ok(entry.captureError);assert.equal(env.data.diagnostics.length,1);
  const failed=setup({stored:[]});Object.defineProperty(failed.data,'diagnostics',{get(){throw new Error('storage unavailable');}});
  assert.equal(await failed.record(run()),null);
});
test('clearing diagnostics removes local images and metadata without deleting unrelated settings',async()=>{
  const env=setup({permission:true});env.data.config={profile:{email:'kept@example.org'}};
  await env.record(run());assert.ok(env.data.diagnostics[0].image);
  await env.clear();assert.equal(env.data.diagnostics,undefined);
  assert.equal(env.data.config.profile.email,'kept@example.org');assert.deepEqual(env.calls.at(-1),['remove','diagnostics']);
});
test('clearing waits for an in-flight screenshot so an older image cannot be written back after deletion',async()=>{
  let releaseCapture,signalStarted,captures=0;
  const started=new Promise(resolve=>{signalStarted=resolve;});
  const env=setup({permission:true,capture:async()=>{
    if(++captures>1)return jpeg(100);
    signalStarted();return new Promise(resolve=>{releaseCapture=resolve;});
  }});
  const recording=env.record(run());await started;
  const clearing=env.clear();
  assert.equal(env.calls.some(call=>call[0]==='remove'),false);
  releaseCapture(jpeg(100));await Promise.all([recording,clearing]);
  assert.equal(env.data.diagnostics,undefined);
  const storedIndex=env.calls.findIndex(call=>call[0]==='store'),removedIndex=env.calls.findIndex(call=>call[0]==='remove');
  assert.ok(storedIndex>=0&&removedIndex>storedIndex);
  await env.record(run('a genuinely new event'));
  assert.equal(env.data.diagnostics.length,1);assert.equal(env.data.diagnostics[0].message,'a genuinely new event');
});
test('a deletion failure reaches the caller and does not poison future recording or clearing',async()=>{
  const env=setup();await env.record(run());env.setRemoveFails(true);
  await assert.rejects(env.clear(),/storage deletion failed/);assert.equal(env.data.diagnostics.length,1);
  await env.record(run('next event'));assert.equal(env.data.diagnostics.length,2);
  env.setRemoveFails(false);await env.clear();assert.equal(env.data.diagnostics,undefined);
});
