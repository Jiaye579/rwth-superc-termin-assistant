const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {webcrypto} = require('node:crypto');
const C = require('../extension/core.js');
const cfg = () => ({...structuredClone(C.DEFAULTS), eligible: true, profile: {...C.DEFAULTS.profile, firstName: 'Test', lastName: 'User', email: 'test@example.org'}});
function setup({transformStoredConfig = value => value, beforeStorageSet = () => {}} = {}) {
  const handlers = {}, alarms = new Map(), tabs = new Map(), data = {config: cfg()}, events = [];
  let id = 0, safeToReload = true, offscreenExists = false, tabReadFails = false;
  // Storage serializes values and can return dictionaries in a different key order.
  // Unlike structuredClone, this models that boundary rather than preserving insertion order.
  function storageCopy(value) {
    if (value === undefined) return undefined;
    const serialized = JSON.parse(JSON.stringify(value));
    const order = item => Array.isArray(item) ? item.map(order) : item && typeof item === 'object'
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, order(item[key])])) : item;
    return order(serialized);
  }
  const event = name => ({addListener: fn => { handlers[name] = fn; }});
  const chrome = {
    storage: {local: {
      get: async key => { if (Array.isArray(key)) return Object.fromEntries(key.map(k => [k, storageCopy(data[k])])); return {[key]: storageCopy(data[key])}; },
      set: async value => { await beforeStorageSet(value); Object.assign(data, storageCopy(value)); if (value.config) data.config = transformStoredConfig(data.config); },
      remove: async key => { for (const entry of Array.isArray(key) ? key : [key]) delete data[entry]; }
    }},
    runtime: {id: 'test', getURL: file => 'chrome-extension://test/' + file, getContexts: async () => offscreenExists ? [{}] : [], sendMessage: async message => { events.push([message.type, message.duration]); return {ok: true}; }, onMessage: event('message'), onStartup: event('startup'), onInstalled: event('installed'), openOptionsPage: async () => {}},
    offscreen: {createDocument: async () => { offscreenExists = true; }},
    action: {setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, onClicked: event('action')},
    alarms: {get: async name => alarms.get(name), create: async (name, value) => alarms.set(name, value), clear: async name => alarms.delete(name), onAlarm: event('alarm')},
    tabs: {create: async args => { const tab = {id: ++id, windowId: 10, ...args}; tabs.set(id, tab); return tab; },
      get: async id => { if (tabReadFails || !tabs.has(id)) throw new Error('closed'); return tabs.get(id); },
      update: async (id, value) => Object.assign(tabs.get(id), value),
      reload: async id => events.push(['reload', id]),
      sendMessage: async (id, msg) => { events.push([msg.type, id]); return msg.type === 'CAN_RELOAD' ? {safe: safeToReload} : {ok: true}; }, onRemoved: event('removed')},
    notifications: {create: async (id, options) => events.push(['notify', id, options]), onClicked: event('notify'), onButtonClicked: event('notifyButton')}
  };
  chrome.windows={get:async id=>({id,state:'minimized'}),update:async (id,changes)=>{events.push(['focus-window',id,changes]);return {id,...changes};}};
  const context = vm.createContext({chrome, console, crypto: webcrypto, URL, Date, Math, setTimeout, clearTimeout});
  context.importScripts = file => vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'), context);
  const options = {id: 'test', tab: {id: 999}, frameId: 0, url: 'chrome-extension://test/options.html'};
  const sender = () => ({id: 'test', tab: {id: data.run.tabId}, frameId: 0, url: C.START});
  const message = (value, source = options) => new Promise(resolve => handlers.message(value, source, resolve));
  return {data, alarms, tabs, events, handlers, message, sender, setSafe: v => { safeToReload = v; }, setTabReadFails: v => { tabReadFails = v; }};
}
// Sound playback has its own serialized queue. Drain its microtasks before
// asserting that a background event did or did not start audio.
const settleSound = () => new Promise(resolve => setImmediate(resolve));
const plays = env => env.events.filter(event => event[0] === 'PLAY_ALARM');
test('clearing personal data also removes local diagnostic screenshots and stops an active run', async () => {
  const env=setup();await env.message({type:'START'});
  await env.message({type:'HUMAN_WAIT',runId:env.data.run.runId,message:'等待验证码'},env.sender());
  env.data.diagnostics=[{image:'data:image/jpeg;base64,PRIVATE',message:'local screen'}];
  assert.equal((await env.message({type:'CLEAR_PROFILE'})).ok,true);
  assert.equal(env.data.config,undefined);assert.equal(env.data.diagnostics,undefined);assert.equal(env.data.run.active,false);
});
function assertSilentAttention(env) {
  assert.equal(plays(env).length, 0, 'attention without a slot must not play the appointment alarm');
  const notices = env.events.filter(event => event[0] === 'notify');
  assert.equal(notices.length, 1, 'the reason must remain visible in a notification');
  assert.equal(notices[0][2].silent, true, 'the OS notification must also be silent');
}
test('options opened in a browser tab can save and read back the actual persisted config', async () => {
  const env = setup();
  delete env.data.config;
  const config = cfg(); config.profile.firstName = 'Updated';
  const result = await env.message({type: 'SAVE_CONFIG', config});
  assert.equal(result.ok, true);
  assert.deepEqual(env.data.config, config);
  assert.equal(typeof result.savedAt, 'number');
  assert.equal(env.data.configSavedAt, result.savedAt);
});
test('a real difference in stored data still fails readback verification', async () => {
  const env = setup({transformStoredConfig: config => ({...config, profile: {...config.profile, firstName: 'Changed'}})});
  const result = await env.message({type: 'SAVE_CONFIG', config: cfg()});
  assert.equal(result.ok, false);
  assert.match(result.error, /未能确认资料已保存/);
});
test('only this extension options document may save, including tabless and fragment URLs', async () => {
  const env = setup(), config = cfg();
  for (const source of [
    {id: 'test', url: 'chrome-extension://test/options.html'},
    {id: 'test', tab: {id: 999}, frameId: 0, url: 'chrome-extension://test/options.html#settings'}
  ]) assert.equal((await env.message({type: 'SAVE_CONFIG', config}, source)).ok, true);
  for (const source of [
    {id: 'other', url: 'chrome-extension://test/options.html'},
    {id: 'test', url: 'https://example.org/options.html'},
    {id: 'test', url: 'chrome-extension://test/other.html'},
    {id: 'test', frameId: 1, url: 'chrome-extension://test/options.html'},
    {url: 'chrome-extension://test/options.html'}
  ]) assert.equal((await env.message({type: 'SAVE_CONFIG', config}, source)).ok, false);
  assert.deepEqual(env.data.config, config);
});
test('start creates only one tab and exposes no profile to another tab or frame', async () => {
  const env = setup();
  assert.equal((await env.message({type: 'START'})).ok, true);
  await env.message({type: 'START'});
  assert.equal(env.tabs.size, 1);
  const good = await env.message({type: 'READY'}, env.sender());
  assert.equal(good.config.profile.firstName, 'Test');
  for (const source of [{...env.sender(), frameId: 1}, {...env.sender(), tab: {id: 99}}, {...env.sender(), url: 'https://example.com/'}]) {
    const bad = await env.message({type: 'READY'}, source);
    assert.equal(bad.active, false); assert.equal(bad.config, undefined);
  }
});
test('no slot arms one alarm; paused run never reloads', async () => {
  const env = setup(); await env.message({type: 'START'});
  await env.message({type: 'WAIT', runId: env.data.run.runId, message: '暂无空位'}, env.sender());
  assert.equal(env.data.run.checks, 1); assert.ok(env.alarms.has('termin-poll')); assert.equal(env.alarms.has('termin-guard'), false);
  await env.message({type: 'STOP'});
  await env.handlers.alarm({name: 'termin-poll'});
  assert.equal(env.data.run.active, false); assert.equal(env.events.some(e => e[0] === 'reload'), false);
});
test('a changed form is never refreshed by a pending alarm', async () => {
  const env = setup(); await env.message({type: 'START'});
  await env.message({type: 'WAIT', runId: env.data.run.runId, message: 'wait'}, env.sender());
  env.setSafe(false); await env.handlers.alarm({name: 'termin-poll'});
  assert.equal(env.data.run.phase, 'handoff'); assert.equal(env.events.some(e => e[0] === 'reload'), false);
});
test('selected slot is persisted before clicking; handoff stops all alarms', async () => {
  const env = setup(); await env.message({type: 'START'});
  await env.message({type: 'ACTION', runId: env.data.run.runId, slot: {date: '2026-11-02', time: '08:00'}, message: 'selected'}, env.sender());
  assert.equal(env.data.run.selected.date, '2026-11-02');
  await env.message({type: 'HANDOFF', runId: env.data.run.runId, message: 'review'}, env.sender());
  assert.equal(env.data.run.active, false); assert.equal(env.alarms.size, 0);
  assert.equal((await env.message({type: 'ACTION', runId: env.data.run.runId}, env.sender())).active, false);
});
test('returned availability after a selected slot stops instead of rebooking', async () => {
  const env = setup(); await env.message({type: 'START'});
  await env.message({type: 'ACTION', runId: env.data.run.runId, slot: {date: '2026-11-02', time: '08:00'}, message: 'selected'}, env.sender());
  await env.message({type: 'WAIT', runId: env.data.run.runId, message: 'wait'}, env.sender());
  assert.equal(env.data.run.phase, 'handoff'); assert.equal(env.alarms.size, 0);
});
test('profile cannot be edited during an active run; malformed config does not start', async () => {
  const env = setup(); await env.message({type: 'START'});
  assert.equal((await env.message({type: 'SAVE_CONFIG', config: cfg()})).ok, false);
  await env.message({type: 'STOP'}); env.data.config.eligible = false;
  assert.equal((await env.message({type: 'START'})).ok, false);
});
test('browser restart stops the old run and resume preserves current tab', async () => {
  const env = setup(); await env.message({type: 'START'});
  const id = env.data.run.tabId;
  await env.handlers.startup(); assert.equal(env.data.run.active, false);
  await env.message({type: 'START', resume: true}); assert.equal(env.data.run.tabId, id); assert.equal(env.tabs.size, 1);
});
test('final submission is durable and allowed only once, including resume and duplicate messages', async () => {
  const env=setup(); await env.message({type:'START'});
  const runId=env.data.run.runId, slot={date:'2026-11-11',time:'08:30'};
  await env.message({type:'ACTION',runId,slot,message:'select'},env.sender());
  const first=await env.message({type:'SUBMIT',runId,slot},env.sender());
  assert.equal(first.ok,true);assert.equal(env.data.run.phase,'submitting');assert.equal(env.data.run.submittedAt,first.submittedAt);
  const again=await env.message({type:'SUBMIT',runId,slot},env.sender());assert.equal(again.ok,false);
  const ready=await env.message({type:'READY'},env.sender());assert.equal(ready.submittedAt,first.submittedAt);
  await env.message({type:'STOP'});assert.equal((await env.message({type:'START',resume:true})).ok,false);
});
test('final submission rejects a different appointment and disabled automatic mode', async () => {
  const env=setup();await env.message({type:'START'});const runId=env.data.run.runId;
  await env.message({type:'ACTION',runId,slot:{date:'2026-11-11',time:'08:30'},message:'select'},env.sender());
  assert.equal((await env.message({type:'SUBMIT',runId,slot:{date:'2026-11-11',time:'09:00'}},env.sender())).ok,false);
  env.data.config.autoSubmit=false;
  assert.equal((await env.message({type:'SUBMIT',runId,slot:env.data.run.selected},env.sender())).ok,false);
  assert.equal(env.data.run.submittedAt,undefined);
});
test('submission lock resets only after pausing and explicitly acknowledging no successful booking', async () => {
  const env=setup();await env.message({type:'START'});const runId=env.data.run.runId,slot={date:'2026-11-11',time:'08:30'};
  await env.message({type:'ACTION',runId,slot,message:'select'},env.sender());await env.message({type:'SUBMIT',runId,slot},env.sender());
  assert.equal((await env.message({type:'RESET_SUBMISSION',confirmedNotBooked:true})).ok,false);
  await env.message({type:'STOP'});assert.equal((await env.message({type:'RESET_SUBMISSION'})).ok,false);
  assert.equal((await env.message({type:'RESET_SUBMISSION',confirmedNotBooked:true})).ok,true);
  assert.equal(env.data.run.submittedAt,null);assert.equal(env.data.run.selected,null);
  assert.equal((await env.message({type:'START'})).ok,true);
});
test('background sound uses two minutes or manual stop and does not restart after dismissal in the same run', async () => {
  const env=setup();env.data.config.alarmDuration=0;await env.message({type:'START'});
  const runId=env.data.run.runId;
  await env.message({type:'ACTION',runId,slot:{date:'2026-11-11',time:'08:30'},message:'select'},env.sender());
  await env.message({type:'STOP_SOUND'});
  assert.ok(env.events.some(event=>event[0]==='PLAY_ALARM'&&event[1]===0));
  const count=env.events.filter(event=>event[0]==='PLAY_ALARM').length;
  await env.message({type:'HANDOFF',runId,message:'attention'},env.sender());
  await env.message({type:'STOP_SOUND'});
  assert.equal(env.events.filter(event=>event[0]==='PLAY_ALARM').length,count);
  assert.equal(env.data.sound.active,false);
});
test('a matching appointment activates its tab and restores the browser window to the foreground', async () => {
  const env=setup();await env.message({type:'START'});
  await env.message({type:'ACTION',runId:env.data.run.runId,slot:{date:'2026-11-11',time:'08:30'},message:'select'},env.sender());
  await env.message({type:'STOP_SOUND'});
  assert.equal(env.tabs.get(env.data.run.tabId).active,true);
  const focused=env.events.find(event=>event[0]==='focus-window');
  assert.ok(focused);assert.equal(focused[1],10);assert.deepEqual({...focused[2]},{state:'normal',focused:true});
});
test('ordinary no-slot waiting and polling produce no audio or attention notification', async () => {
  const env=setup();await env.message({type:'START'});
  await env.message({type:'WAIT',runId:env.data.run.runId,message:'暂无空位，等待下次检查。'},env.sender());
  await env.handlers.alarm({name:'termin-poll'});await settleSound();
  assert.equal(env.data.run.active,true);assert.equal(plays(env).length,0);
  assert.equal(env.events.some(event=>event[0]==='notify'),false);
  assert.equal(env.events.filter(event=>event[0]==='reload').length,1);
});
test('an unrecognized page without a slot prompts silently instead of playing the appointment alarm', async () => {
  const env=setup();await env.message({type:'START'});
  const reason='时间页面结构无法识别，请手动选择。';
  await env.message({type:'HANDOFF',runId:env.data.run.runId,message:reason},env.sender());await settleSound();
  assert.equal(env.data.run.phase,'handoff');assert.equal(env.data.run.message,reason);
  assertSilentAttention(env);
});
test('the 45-second guard without a slot reports a silent interruption', async () => {
  const env=setup();await env.message({type:'START'});
  await env.handlers.alarm({name:'termin-guard'});await settleSound();
  assert.equal(env.data.run.active,false);assert.match(env.data.run.message,/45 秒/);
  assertSilentAttention(env);
});
test('a page that is no longer safe to refresh prompts silently without a slot', async () => {
  const env=setup();await env.message({type:'START'});
  await env.message({type:'WAIT',runId:env.data.run.runId,message:'暂无空位'},env.sender());
  env.setSafe(false);await env.handlers.alarm({name:'termin-poll'});await settleSound();
  assert.equal(env.events.some(event=>event[0]==='reload'),false);
  assert.match(env.data.run.message,/页面已改变/);assertSilentAttention(env);
});
test('a tab read failure without a slot reports the failure silently', async () => {
  const env=setup();await env.message({type:'START'});
  await env.message({type:'WAIT',runId:env.data.run.runId,message:'暂无空位'},env.sender());
  env.setTabReadFails(true);await env.handlers.alarm({name:'termin-poll'});await settleSound();
  assert.equal(env.data.run.phase,'handoff');assert.match(env.data.run.message,/关闭或无法读取/);
  assertSilentAttention(env);
});
test('a completion message without a previously found slot cannot start the appointment alarm', async () => {
  const env=setup();await env.message({type:'START'});
  await env.message({type:'DONE',runId:env.data.run.runId,message:'官网提示需要邮箱确认。'},env.sender());await settleSound();
  assert.equal(env.data.run.phase,'done');assertSilentAttention(env);
});
test('a found appointment records its date and time as the alarm reason and subsequent attention never restarts it', async () => {
  for(const type of ['HANDOFF','DONE']) {
    const env=setup();await env.message({type:'START'});const runId=env.data.run.runId;
    await env.message({type:'ACTION',runId,slot:{date:'2026-11-11',time:'08:30'},message:'选择时间'},env.sender());await settleSound();
    assert.equal(plays(env).length,1);assert.equal(plays(env)[0][1],120);
    assert.match(env.data.sound.reason,/2026-11-11.*08:30/);
    await env.message({type:'STOP_SOUND'});
    await env.message({type,runId,message:type==='DONE'?'官网显示预约成功。':'需要手动处理。'},env.sender());await settleSound();
    assert.equal(plays(env).length,1);assert.equal(env.data.sound.active,false);
    assert.equal(env.events.find(event=>event[0]==='notify')[2].silent,true);
  }
});
test('starting a new monitoring run silences an old test alarm and keeps no-slot monitoring quiet', async () => {
  const env=setup();await env.message({type:'TEST_SOUND',duration:0});
  assert.equal(env.data.sound.active,true);assert.match(env.data.sound.reason,/测试铃声/);
  await env.message({type:'START'});await settleSound();
  assert.equal(env.data.sound.active,false);
  assert.equal(env.events.filter(event=>event[0]==='STOP_ALARM').length,1);
  assert.ok(env.events.findIndex(event=>event[0]==='STOP_ALARM')<env.events.findIndex(event=>event[0]==='WAKE'));
  await env.message({type:'WAIT',runId:env.data.run.runId,message:'暂无空位'},env.sender());await settleSound();
  assert.equal(plays(env).length,1);
});
test('pausing from the official-page assistant silences the current appointment alarm', async () => {
  const env=setup();await env.message({type:'START'});
  await env.message({type:'ACTION',runId:env.data.run.runId,slot:{date:'2026-11-11',time:'08:30'},message:'选择时间'},env.sender());await settleSound();
  assert.equal(env.data.sound.active,true);
  await env.message({type:'MANUAL_STOP',runId:env.data.run.runId},env.sender());await settleSound();
  assert.equal(env.data.run.active,false);assert.equal(env.data.sound.active,false);
  assert.equal(env.events.filter(event=>event[0]==='STOP_ALARM').length,1);
});
test('waiting for human input keeps the run active, clears refresh and guard alarms and stays silent without a slot', async () => {
  for(const prior of ['checking','waiting']) {
    const env=setup();await env.message({type:'START'});const runId=env.data.run.runId;
    if(prior==='waiting')await env.message({type:'WAIT',runId,message:'暂无空位'},env.sender());
    assert.ok(env.alarms.has(prior==='waiting'?'termin-poll':'termin-guard'));
    const result=await env.message({type:'HUMAN_WAIT',runId,message:'普通资料已填好，请输入验证码并勾选同意项。',diagnostic:{step:5}},env.sender());await settleSound();
    assert.equal(result.ok,true);assert.equal(result.active,true);
    assert.equal(env.data.run.active,true);assert.equal(env.data.run.phase,'human-wait');assert.equal(env.data.run.nextCheckAt,null);
    assert.equal(env.alarms.has('termin-poll'),false);assert.equal(env.alarms.has('termin-guard'),false);
    assert.equal(env.events.some(event=>event[0]==='STOP'),false);
    assert.equal(env.events.some(event=>event[0]==='reload'),false);
    assertSilentAttention(env);
    assert.equal((await env.message({type:'READY'},env.sender())).active,true);
  }
});
test('a delayed 45-second guard or polling callback cannot stop or refresh a form waiting for human input', async () => {
  const env=setup();await env.message({type:'START'});const runId=env.data.run.runId;
  await env.message({type:'HUMAN_WAIT',runId,message:'等待你完成验证码。'},env.sender());
  const logLength=env.data.run.log.length;
  // Deliver callbacks that were already queued when HUMAN_WAIT cleared their
  // alarms; no real 45-second sleep is needed to exercise this race.
  await env.handlers.alarm({name:'termin-guard',scheduledTime:Date.now()+45000});
  await env.handlers.alarm({name:'termin-poll',scheduledTime:Date.now()+60000});await settleSound();
  assert.equal(env.data.run.active,true);assert.equal(env.data.run.phase,'human-wait');assert.equal(env.data.run.log.length,logLength);
  assert.equal(env.alarms.size,0);assert.equal(plays(env).length,0);
  assert.equal(env.events.some(event=>event[0]==='STOP'||event[0]==='reload'),false);
  assert.equal(env.events.filter(event=>event[0]==='notify').length,1);
});
test('a selected form can continue from human input to an action or directly to its one permitted submission', async () => {
  for(const continueWithAction of [false,true]) {
    const env=setup();await env.message({type:'START'});const runId=env.data.run.runId,slot={date:'2026-11-11',time:'08:30'};
    await env.message({type:'ACTION',runId,slot,message:'选择时间'},env.sender());await settleSound();
    await env.message({type:'STOP_SOUND'});const alarmCount=plays(env).length;
    await env.message({type:'HUMAN_WAIT',runId,message:'请完成验证码。',diagnostic:{step:5}},env.sender());await settleSound();
    assert.equal(env.data.run.active,true);assert.equal(env.data.run.phase,'human-wait');assert.deepEqual(env.data.run.selected,slot);assert.equal(env.alarms.size,0);
    if(continueWithAction) {
      const action=await env.message({type:'ACTION',runId,message:'人工填写完成，核对最终表单。'},env.sender());
      assert.equal(action.active,true);assert.equal(env.data.run.phase,'navigating');assert.ok(env.alarms.has('termin-guard'));
    }
    const result=await env.message({type:'SUBMIT',runId,slot},env.sender());await settleSound();
    assert.equal(result.ok,true);assert.equal(result.active,true);assert.equal(env.data.run.phase,'submitting');assert.equal(env.data.run.submittedAt,result.submittedAt);
    assert.equal((await env.message({type:'SUBMIT',runId,slot},env.sender())).ok,false);
    assert.equal(plays(env).length,alarmCount);assert.equal(env.data.sound.active,false);
    assert.equal(env.events.some(event=>event[0]==='reload'),false);
  }
});
test('the first selected slot arms one post-slot dialog and READY exposes the pending permission', async () => {
  const env=setup();await env.message({type:'START'});const runId=env.data.run.runId,slot={date:'2026-11-11',time:'08:30'};
  await env.message({type:'ACTION',runId,slot,message:'选择时间'},env.sender());
  assert.equal(env.data.run.awaitingSlotDialog,true);assert.equal(env.data.run.slotDialogArmed,true);assert.ok(env.data.run.slotDialogConfirmedAt==null);
  const ready=await env.message({type:'READY'},env.sender());assert.equal(ready.awaitingSlotDialog,true);assert.deepEqual(ready.selected,slot);
});
test('post-slot dialog permission is durably consumed before its click request is acknowledged', async () => {
  let release,signalSave;const saving=new Promise(resolve=>{signalSave=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const env=setup({beforeStorageSet:async value=>{if(value.run?.slotDialogConfirmedAt){signalSave();await gate;}}});
  await env.message({type:'START'});const runId=env.data.run.runId,slot={date:'2026-11-11',time:'08:30'};
  await env.message({type:'ACTION',runId,slot,message:'选择时间'},env.sender());
  let responded=false;
  const confirming=env.message({type:'ACTION',runId,slotDialog:true,dialogSlot:slot,message:'点击选时后右侧按钮',diagnostic:{step:4}},env.sender()).then(result=>{responded=true;return result;});
  let timeout;
  const reachedSave=await Promise.race([saving.then(()=>true),new Promise(resolve=>{timeout=setTimeout(()=>resolve(false),1000);})]);clearTimeout(timeout);
  if(!reachedSave){release();await confirming;assert.fail('dialog confirmation was never persisted');}
  await Promise.resolve();
  const acknowledgedEarly=responded,stillPendingInStorage=env.data.run.awaitingSlotDialog;
  release();const result=await confirming;
  assert.equal(acknowledgedEarly,false);assert.equal(stillPendingInStorage,true);
  assert.equal(result.ok,true);assert.equal(result.active,true);assert.equal(env.data.run.awaitingSlotDialog,false);
  assert.equal(typeof env.data.run.slotDialogConfirmedAt,'number');assert.ok(env.data.run.slotDialogConfirmedAt>0);assert.equal(env.data.run.slotDialogArmed,true);
  assert.equal((await env.message({type:'READY'},env.sender())).awaitingSlotDialog,false);
});
test('an unarmed, mismatched or already-submitted dialog request is rejected without changing run state', async () => {
  const env=setup();await env.message({type:'START'});const runId=env.data.run.runId,slot={date:'2026-11-11',time:'08:30'};
  let before=structuredClone(env.data.run);
  assert.equal((await env.message({type:'ACTION',runId,slotDialog:true,dialogSlot:slot,message:'unexpected dialog'},env.sender())).ok,false);
  assert.deepEqual(env.data.run,before);
  await env.message({type:'ACTION',runId,slot,message:'选择时间'},env.sender());
  for(const dialogSlot of [undefined,{...slot,time:'09:00'},{...slot,date:'2026-11-12'}]) {
    before=structuredClone(env.data.run);
    assert.equal((await env.message({type:'ACTION',runId,slotDialog:true,dialogSlot,message:'wrong dialog slot'},env.sender())).ok,false);
    assert.deepEqual(env.data.run,before);
  }
  // Model a recovered inconsistent pending flag: a durable submission must
  // dominate it even if an older snapshot still marked the dialog pending.
  env.data.run.submittedAt=Date.now();env.data.run.awaitingSlotDialog=true;before=structuredClone(env.data.run);
  assert.equal((await env.message({type:'ACTION',runId,slotDialog:true,dialogSlot:slot,message:'late dialog'},env.sender())).ok,false);
  assert.deepEqual(env.data.run,before);
});
test('a consumed dialog cannot be repeated or rearmed by duplicate slot and slot-next actions', async () => {
  const env=setup();await env.message({type:'START'});const runId=env.data.run.runId,slot={date:'2026-11-11',time:'08:30'};
  await env.message({type:'ACTION',runId,slot,message:'选择时间'},env.sender());
  await env.message({type:'ACTION',runId,slotDialog:true,dialogSlot:slot,message:'继续选时弹窗'},env.sender());
  const confirmedAt=env.data.run.slotDialogConfirmedAt;
  for(const kind of ['slot','slot-next']) {
    const before=structuredClone(env.data.run);
    assert.equal((await env.message({type:'ACTION',runId,slotDialog:true,dialogSlot:slot,message:'repeat dialog'},env.sender())).ok,false);
    assert.deepEqual(env.data.run,before);
    assert.equal((await env.message({type:'ACTION',runId,kind,slot,message:'重复时间控件'},env.sender())).active,true);
    assert.equal(env.data.run.awaitingSlotDialog,false);assert.equal(env.data.run.slotDialogArmed,true);assert.equal(env.data.run.slotDialogConfirmedAt,confirmedAt);
  }
});
test('entering the personal form or submitting clears pending dialog permission without rearming it', async () => {
  for(const next of ['form','submit']) {
    const env=setup();await env.message({type:'START'});const runId=env.data.run.runId,slot={date:'2026-11-11',time:'08:30'};
    await env.message({type:'ACTION',runId,slot,message:'选择时间'},env.sender());assert.equal(env.data.run.awaitingSlotDialog,true);
    const result=next==='form'?await env.message({type:'ACTION',runId,formReady:true,message:'进入资料表单'},env.sender()):await env.message({type:'SUBMIT',runId,slot},env.sender());
    assert.equal(result.ok,true);assert.equal(env.data.run.awaitingSlotDialog,false);assert.equal(env.data.run.slotDialogArmed,true);
    assert.ok(env.data.run.slotDialogConfirmedAt==null);
    if(next==='form') {
      await env.message({type:'ACTION',runId,slot,message:'重复slot-next'},env.sender());assert.equal(env.data.run.awaitingSlotDialog,false);
    }
    assert.equal((await env.message({type:'ACTION',runId,slotDialog:true,dialogSlot:slot,message:'too late dialog'},env.sender())).ok,false);
  }
});
test('resuming the same bound page preserves pending and consumed dialog permissions', async () => {
  for(const consumed of [false,true]) {
    const env=setup();await env.message({type:'START'});let runId=env.data.run.runId;const slot={date:'2026-11-11',time:'08:30'},tabId=env.data.run.tabId;
    await env.message({type:'ACTION',runId,slot,message:'选择时间'},env.sender());
    if(consumed)await env.message({type:'ACTION',runId,slotDialog:true,dialogSlot:slot,message:'继续选时弹窗'},env.sender());
    const confirmedAt=env.data.run.slotDialogConfirmedAt;await env.message({type:'STOP'});
    assert.equal((await env.message({type:'START',resume:true})).ok,true);runId=env.data.run.runId;
    assert.equal(env.data.run.tabId,tabId);assert.equal(env.tabs.size,1);assert.deepEqual(env.data.run.selected,slot);
    assert.equal(env.data.run.awaitingSlotDialog,!consumed);assert.equal(env.data.run.slotDialogArmed,true);assert.equal(env.data.run.slotDialogConfirmedAt,confirmedAt);
    const result=await env.message({type:'ACTION',runId,slotDialog:true,dialogSlot:slot,message:'恢复后的弹窗'},env.sender());
    assert.equal(result.ok,!consumed);
  }
});
test('a fresh monitoring run never inherits pending or consumed dialog permission from an older tab', async () => {
  for(const consumed of [false,true]) {
    const env=setup();await env.message({type:'START'});const runId=env.data.run.runId,slot={date:'2026-11-11',time:'08:30'},oldTab=env.data.run.tabId;
    await env.message({type:'ACTION',runId,slot,message:'选择时间'},env.sender());
    if(consumed)await env.message({type:'ACTION',runId,slotDialog:true,dialogSlot:slot,message:'继续选时弹窗'},env.sender());
    await env.message({type:'STOP'});assert.equal((await env.message({type:'START',resume:false})).ok,true);
    assert.notEqual(env.data.run.tabId,oldTab);assert.equal(env.data.run.selected,null);
    assert.equal(!!env.data.run.awaitingSlotDialog,false);assert.equal(!!env.data.run.slotDialogArmed,false);assert.ok(env.data.run.slotDialogConfirmedAt==null);
  }
});
test('resetting a verified unsuccessful submission clears every dialog marker so a new selection may arm once', async () => {
  const env=setup();await env.message({type:'START'});let runId=env.data.run.runId;const slot={date:'2026-11-11',time:'08:30'};
  await env.message({type:'ACTION',runId,slot,message:'选择时间'},env.sender());
  await env.message({type:'ACTION',runId,slotDialog:true,dialogSlot:slot,message:'继续选时弹窗'},env.sender());
  await env.message({type:'SUBMIT',runId,slot},env.sender());await env.message({type:'STOP'});
  assert.equal((await env.message({type:'RESET_SUBMISSION',confirmedNotBooked:true})).ok,true);
  assert.equal(!!env.data.run.awaitingSlotDialog,false);assert.equal(!!env.data.run.slotDialogArmed,false);assert.ok(env.data.run.slotDialogConfirmedAt==null);assert.equal(env.data.run.selected,null);
  await env.message({type:'START',resume:true});runId=env.data.run.runId;
  await env.message({type:'ACTION',runId,slot,message:'重新选时'},env.sender());
  assert.equal(env.data.run.awaitingSlotDialog,true);assert.equal(env.data.run.slotDialogArmed,true);assert.ok(env.data.run.slotDialogConfirmedAt==null);
});
