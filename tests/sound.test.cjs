const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function setup(){
  const timers=new Map(),messages=[];let listener,audio,index=0;
  class FakeAudio{constructor(){audio=this;this.paused=true;}play(){this.paused=false;return Promise.resolve();}pause(){this.paused=true;}}
  const chrome={runtime:{id:'test',getURL:file=>'chrome-extension://test/'+file,onMessage:{addListener:fn=>listener=fn},sendMessage:async msg=>messages.push(msg)}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/offscreen.js'),'utf8'),{chrome,Audio:FakeAudio,setTimeout:(fn,ms)=>{timers.set(++index,{fn,ms});return index;},clearTimeout:id=>timers.delete(id)});
  const send=msg=>new Promise(resolve=>listener({target:'offscreen',...msg},{id:'test'},resolve));
  return {send,timers,messages,get audio(){return audio;}};
}
test('two-minute alarm loops and stops at 120 seconds without a real delay',async()=>{
  const env=setup();assert.equal((await env.send({type:'PLAY_ALARM',runId:'one',duration:120})).ok,true);
  assert.equal(env.audio.loop,true);assert.equal(env.audio.paused,false);
  const timer=[...env.timers.values()][0];assert.equal(timer.ms,120000);timer.fn();
  assert.equal(env.audio.paused,true);assert.equal(env.messages[0].type,'SOUND_ENDED');
});
test('manual-close mode has no timer and explicit stop silences it',async()=>{
  const env=setup();await env.send({type:'PLAY_ALARM',runId:'one',duration:0});assert.equal(env.timers.size,0);assert.equal(env.audio.paused,false);
  await env.send({type:'STOP_ALARM'});assert.equal(env.audio.paused,true);assert.equal(env.audio.currentTime,0);
});
