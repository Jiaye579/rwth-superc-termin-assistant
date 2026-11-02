/* Only inserted by the loopback preview server; not included in the extension. */
globalThis.TERMIN_DEMO = true;
const demoListeners = [];
const demoData = {config: {interval:60,from:'',until:'',after:'00:00',before:'23:59',weekdays:[1,2,3,4,5],excludedDates:[],eligible:true,profile:{firstName:'Xiaoming',lastName:'WANG',email:'demo@example.org',birthDate:'2001-01-01',phone:'',street:'',houseNumber:'',postalCode:'',city:''},extraFields:{}},run:{active:false,phase:'idle',message:'演示环境已就绪。此页面不会访问外管局。',checks:0,log:[]}};
function demoState(message, phase, active) {
  demoData.run = {...demoData.run, message, phase, active, updatedAt:Date.now(),log:[...(demoData.run.log || []),{at:Date.now(),message}]};
  for (const listener of demoListeners) listener({run:{newValue:structuredClone(demoData.run)}},'local');
}
globalThis.chrome = {
  storage:{local:{get:async () => structuredClone(demoData)},onChanged:{addListener:fn=>demoListeners.push(fn)}},
  runtime:{sendMessage:async msg=>{
    if(msg.type==='SAVE_CONFIG') demoData.config=msg.config;
    if(msg.type==='CLEAR_PROFILE') {delete demoData.config;demoState('演示资料已清除。','paused',false);}
    if(msg.type==='START') demoState('演示：正在等待可用时间；真实监测需安装扩展。','waiting',true);
    if(msg.type==='STOP') demoState('演示已暂停。','paused',false);
    if(msg.type==='OPEN_TAB') demoState('演示模式不会打开官网或创建预约。','idle',false);
    return {ok:true};
  }}
};
