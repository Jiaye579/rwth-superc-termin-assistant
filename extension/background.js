'use strict';
importScripts('core.js');
importScripts('sound.js');
importScripts('diagnostics.js');
const C = globalThis.TerminCore;
const POLL = 'termin-poll', GUARD = 'termin-guard';
let queue = Promise.resolve();
const serial = job => { const result = queue.then(job); queue = result.catch(() => {}); return result; };
const state = async () => (await chrome.storage.local.get('run')).run || {active: false, phase: 'idle', message: '尚未开始。', log: []};
async function save(run, message = run.message) {
  run.message = message;
  run.updatedAt = Date.now();
  run.log = [...(run.log || []), {at: run.updatedAt, message}].slice(-60);
  await chrome.storage.local.set({run});
  await chrome.action.setBadgeText({text: run.active ? 'ON' : run.phase === 'handoff' ? '!' : ''});
  await chrome.action.setBadgeBackgroundColor({color: run.active ? '#166b50' : '#b36215'});
  return run;
}
async function clearAlarms() { await chrome.alarms.clear(POLL); await chrome.alarms.clear(GUARD); }
async function focusAppointment(tabId) {
  try {
    const tab = await chrome.tabs.update(tabId, {active: true});
    const window = await chrome.windows.get(tab.windowId);
    await chrome.windows.update(tab.windowId, window.state === 'minimized' ? {state: 'normal', focused: true} : {focused: true});
  } catch { /* The tab may have been closed or the OS may decline foreground focus. */ }
}
async function alertUser(run, diagnostic) {
  // A handoff can be caused by a timeout, changed page or network failure, even
  // before any appointment is found. Only the slot ACTION starts the long alarm.
  try {
    const title = run.selected ? 'RWTH SuperC · 请核对预约进度' : run.phase === 'done' ? 'RWTH SuperC · 请核对官网结果' : 'RWTH SuperC · 监测已暂停';
    await chrome.notifications.create('termin-attention', {type: 'basic', iconUrl: 'icon.png', title, message: run.message, priority: 2, silent: true, buttons: [{title: '关闭铃声'}, {title: '打开助手'}]});
  } catch { /* OS notifications can be disabled. The options page and badge still show the result. */ }
  if (run.selected) await focusAppointment(run.tabId);
  void TerminDiagnostics.record(run, diagnostic);
}
async function stop(run, message, phase = 'paused', notify = false, diagnostic) {
  await clearAlarms(); run.active = false; run.phase = phase; run.nextCheckAt = null;
  await save(run, message);
  try { await chrome.tabs.sendMessage(run.tabId, {type: 'STOP', message}); } catch {}
  if (notify) await alertUser(run, diagnostic);
  return run;
}
function official(url) {
  try { const u = new URL(url); return u.origin === 'https://termine.staedteregion-aachen.de' && u.pathname.startsWith('/auslaenderamt/'); } catch { return false; }
}
function isOptions(sender) {
  // An options page opened in its own browser tab also has sender.tab.
  if (sender.id !== chrome.runtime.id || (sender.frameId !== undefined && sender.frameId !== 0)) return false;
  try {
    const actual = new URL(sender.url), expected = new URL(chrome.runtime.getURL('options.html'));
    return actual.protocol === expected.protocol && actual.host === expected.host && actual.pathname === expected.pathname;
  } catch { return false; }
}
async function handle(message, sender) {
  let run = await state();
  if (message.type === 'SOUND_ENDED') {
    if (sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('offscreen.html')) await TerminSound.ended(message.runId);
    return {ok: true};
  }
  if (['START', 'STOP', 'OPEN_TAB', 'SAVE_CONFIG', 'CLEAR_PROFILE', 'TEST_SOUND', 'STOP_SOUND', 'RESET_SUBMISSION'].includes(message.type) && !isOptions(sender)) throw new Error('请从浏览器工具栏的扩展图标重新打开设置页，再重试。');
  if (message.type === 'TEST_SOUND') { const config = (await chrome.storage.local.get('config')).config; if (!await TerminSound.start('test-' + crypto.randomUUID(), message.duration ?? config?.alarmDuration ?? 120, '测试铃声（手动点击）')) throw new Error('铃声无法播放，请检查浏览器和系统音量。'); return {ok: true}; }
  if (message.type === 'STOP_SOUND') { await TerminSound.stop(); return {ok: true}; }
  if (message.type === 'RESET_SUBMISSION') {
    if (run.active || message.confirmedNotBooked !== true) throw new Error('请先暂停，并确认官网及邮箱中没有成功预约。');
    run.submittedAt = null; run.selected = null;
    run.awaitingSlotDialog = false; run.slotDialogArmed = false; run.slotDialogConfirmedAt = null;
    await save(run, '你已确认没有预约成功，可以重新开始监测。'); return {ok: true};
  }
  if (message.type === 'SAVE_CONFIG') {
    if (run.active) throw new Error('请先暂停，再修改资料和日期条件。');
    const config = message.config;
    const errors = C.validate(config);
    if (errors.length) throw new Error(errors.join('\n'));
    const savedAt = Date.now();
    await chrome.storage.local.set({config, configSavedAt: savedAt});
    const stored = await chrome.storage.local.get('config');
    if (!C.sameJSON(stored.config, config)) throw new Error('未能确认资料已保存，请重试。');
    return {ok: true, savedAt};
  }
  if (message.type === 'CLEAR_PROFILE') {
    await TerminSound.stop();
    if (run.active) await stop(run, '资料已清除，监测已停止。');
    await TerminDiagnostics.clear();
    await chrome.storage.local.remove(['config', 'configSavedAt']); return {ok: true};
  }
  if (message.type === 'STOP') { await TerminSound.stop(); return {ok: true, run: await stop(run, '已暂停，官网页面保留。')}; }
  if (message.type === 'OPEN_TAB') {
    if (run.tabId) { try { await chrome.tabs.update(run.tabId, {active: true}); return {ok: true}; } catch {} }
    await chrome.tabs.create({url: C.START}); return {ok: true};
  }
  if (message.type === 'START') {
    if (run.active) return {ok: true, run};
    if (run.submittedAt) throw new Error('本轮已经发送过预约，请先核实官网和邮箱结果；不会再次提交。');
    const config = (await chrome.storage.local.get('config')).config;
    const errors = config ? C.validate(config) : ['请先保存资料。'];
    if (errors.length) throw new Error(errors.join('\n'));
    await TerminSound.stop();
    await clearAlarms();
    let tab;
    if (run.tabId && message.resume) {
      try { tab = await chrome.tabs.get(run.tabId); if (!official(tab.url)) tab = null; } catch {}
    }
    // A resume keeps the form/session. A fresh run is always an explicit user action.
    if (!tab) tab = await chrome.tabs.create({url: C.START, active: false});
    const resume = tab.id === run.tabId && message.resume;
    run = {active: true, phase: 'checking', tabId: tab.id, runId: crypto.randomUUID(), selected: resume ? run.selected : null,
      awaitingSlotDialog: resume && !!run.awaitingSlotDialog, slotDialogArmed: resume && !!run.slotDialogArmed, slotDialogConfirmedAt: resume ? run.slotDialogConfirmedAt : null,
      checks: 0, startedAt: Date.now(), log: []};
    await save(run, '已开始：只操作这一张官网标签页。');
    await chrome.alarms.create(GUARD, {when: Date.now() + 45000});
    try { await chrome.tabs.sendMessage(run.tabId, {type: 'WAKE'}); } catch { /* READY follows navigation. */ }
    return {ok: true, run};
  }
  // Only a top-level content script in the one bound official tab can receive profile data.
  if (sender.frameId !== 0 || sender.tab?.id !== run.tabId || !official(sender.url)) return {ok: false, active: false};
  if (message.type === 'READY') return {ok: true, active: run.active, config: run.active ? (await chrome.storage.local.get('config')).config : undefined, runId: run.runId, selected: run.selected, submittedAt: run.submittedAt, awaitingSlotDialog: !!run.awaitingSlotDialog, slotDialogArmed: !!run.slotDialogArmed};
  if (message.type === 'MANUAL_STOP') { await TerminSound.stop(); return {ok: true, run: await stop(run, '已在官网助手栏暂停。')}; }
  if (!run.active || message.runId !== run.runId) return {ok: false, active: false};
  if (message.type === 'ACTION') {
    if (message.slotDialog && (!run.awaitingSlotDialog || !run.selected || run.submittedAt || !C.sameJSON(message.dialogSlot, run.selected))) return {ok: false, active: true, error: '本轮没有待确认的选时弹窗，或该弹窗已经处理过一次。'};
    await clearAlarms(); run.phase = 'navigating'; run.nextCheckAt = null;
    if (message.slot) {
      if (!C.validDate(message.slot.date) || !C.validTime(message.slot.time)) throw new Error('时间识别无效。');
      run.selected = {date: message.slot.date, time: message.slot.time};
      if (!run.slotDialogArmed) { run.slotDialogArmed = true; run.awaitingSlotDialog = true; }
    }
    if (message.slotDialog) { run.awaitingSlotDialog = false; run.slotDialogConfirmedAt = Date.now(); }
    if (message.formReady) run.awaitingSlotDialog = false;
    await save(run, String(message.message).slice(0, 240));
    if (message.slotDialog) void TerminDiagnostics.record({...run, phase: 'slot-confirmation'}, message.diagnostic);
    if (message.slot) {
      const config = (await chrome.storage.local.get('config')).config;
      void TerminSound.start(run.runId, config?.alarmDuration ?? 120, `发现符合条件的时间：${run.selected.date} ${run.selected.time}（德国时间）`);
      void focusAppointment(run.tabId);
    }
    await chrome.alarms.create(GUARD, {when: Date.now() + 45000});
    return {ok: true, active: true, awaitingSlotDialog: !!run.awaitingSlotDialog, slotDialogArmed: !!run.slotDialogArmed};
  }
  if (message.type === 'SUBMIT') {
    if (run.submittedAt) return {ok: false, active: false, error: '本轮已经发送过一次预约，不会再次提交。'};
    const config = (await chrome.storage.local.get('config')).config;
    if (config?.autoSubmit === false || !run.selected || !C.sameJSON(message.slot, run.selected)) return {ok: false, active: false, error: '自动提交条件或所选时间不符合要求。'};
    await clearAlarms(); run.phase = 'submitting'; run.submittedAt = Date.now(); run.awaitingSlotDialog = false;
    await save(run, '已记录本轮唯一一次提交请求，正在等待官网结果。');
    await chrome.alarms.create(GUARD, {when: Date.now() + 45000});
    return {ok: true, active: true, submittedAt: run.submittedAt};
  }
  if (message.type === 'WAIT') {
    if (run.selected) return {ok: true, run: await stop(run, '已选择过时间，但官网返回了可选时间页。请核对是否失效后再开始，避免重复预约。', 'handoff', true)};
    const config = (await chrome.storage.local.get('config')).config;
    await clearAlarms(); run.phase = 'waiting'; run.checks++;
    run.nextCheckAt = Date.now() + config.interval * 1000 + Math.floor(Math.random() * config.interval * 150);
    await save(run, String(message.message).slice(0, 240));
    await chrome.alarms.create(POLL, {when: run.nextCheckAt});
    return {ok: true, active: true};
  }
  if (message.type === 'RESTART') {
    if (run.selected) return {ok: true, run: await stop(run, '选过时间后会话失效，请手动核对官网结果。', 'handoff', true)};
    await clearAlarms(); run.phase = 'checking';
    await save(run, '会话已过期，重新选择 RWTH 学生服务。');
    await chrome.tabs.update(run.tabId, {url: C.START});
    await chrome.alarms.create(GUARD, {when: Date.now() + 45000});
    return {ok: true};
  }
  if (message.type === 'HUMAN_WAIT') {
    await clearAlarms(); run.phase = 'human-wait'; run.nextCheckAt = null;
    await save(run, String(message.message).slice(0, 400));
    await alertUser(run, message.diagnostic);
    return {ok: true, active: true};
  }
  if (message.type === 'HANDOFF' || message.type === 'DONE') {
    return {ok: true, run: await stop(run, String(message.message).slice(0, 400), message.type === 'DONE' ? 'done' : 'handoff', true, message.diagnostic)};
  }
  return {ok: false};
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.target === 'offscreen') return false;
  serial(() => handle(message, sender)).then(respond, error => respond({ok: false, error: error.message}));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => serial(async () => {
  const run = await state();
  if (!run.active || run.phase === 'human-wait') return;
  if (alarm.name === GUARD) { await stop(run, run.submittedAt ? '已发送一次预约但官网响应未确认，请核对官网及邮箱；不会重复提交。' : '页面 45 秒未推进，请检查网络、提示窗或验证码后继续。', 'handoff', true); return; }
  if (alarm.name !== POLL || run.phase !== 'waiting') return;
  try {
    const tab = await chrome.tabs.get(run.tabId);
    if (!official(tab.url)) { await stop(run, '预约标签页已离开官网，已暂停。'); return; }
    // Never refresh a personal-data/review page, including one the user opened manually.
    const status = await chrome.tabs.sendMessage(run.tabId, {type: 'CAN_RELOAD'});
    if (!status?.safe) { await stop(run, '官网页面已改变，保留当前页面，等待你核对。', 'handoff', true); return; }
    run.phase = 'checking'; run.nextCheckAt = null;
    await save(run, '正在重新检查空位。');
    await chrome.tabs.reload(run.tabId);
    await chrome.alarms.create(GUARD, {when: Date.now() + 45000});
  } catch { await stop(run, '预约标签页已关闭或无法读取，请打开设置页重新开始。', 'handoff', true); }
}).catch(() => {}));
chrome.tabs.onRemoved.addListener(tabId => serial(async () => {
  const run = await state(); if (run.tabId === tabId && run.active) await stop(run, '预约标签页已关闭，监测停止。');
}));
chrome.runtime.onStartup.addListener(() => serial(async () => {
  await TerminSound.stop();
  const run = await state(); if (run.active) await stop(run, '浏览器已重启，请在设置页检查后手动继续。');
}));
chrome.runtime.onInstalled.addListener(() => serial(async () => {
  await TerminSound.stop();
  const run = await state(); if (run.active) await stop(run, '扩展已更新／重新加载，请检查后手动继续。');
}));
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.notifications.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.notifications.onButtonClicked.addListener((id, index) => { if (id === 'termin-attention' && index === 0) void TerminSound.stop(); else void chrome.runtime.openOptionsPage(); });
// Recover an alarm if the service worker was suspended after persisting state.
serial(async () => {
  const run = await state();
  if (!run.active || run.phase === 'human-wait') return;
  const name = run.phase === 'waiting' ? POLL : GUARD;
  if (!await chrome.alarms.get(name)) await chrome.alarms.create(name, {when: Math.max(Date.now() + 1000, run.phase === 'waiting' ? run.nextCheckAt || 0 : (run.updatedAt || Date.now()) + 45000)});
}).catch(() => {});
