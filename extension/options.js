'use strict';
const form = document.getElementById('settings');
const C = globalThis.TerminCore;
const $ = id => document.getElementById(id);
function setForm(config) {
  for (const [key, value] of Object.entries(config.profile)) form.elements[key].value = value;
  for (const key of ['from', 'until', 'after', 'before', 'interval', 'alarmDuration']) form.elements[key].value = config[key] ?? C.DEFAULTS[key];
  form.elements.autoSubmit.checked = config.autoSubmit !== false;
  for (const input of form.querySelectorAll('[name="weekday"]')) input.checked = config.weekdays.includes(Number(input.value));
  form.elements.eligible.checked = config.eligible;
  form.elements.excludedDates.value = config.excludedDates.join(', ');
  form.elements.extraFields.value = Object.keys(config.extraFields).length ? JSON.stringify(config.extraFields, null, 2) : '';
}
function readForm() {
  const data = new FormData(form), profile = {};
  for (const key of Object.keys(C.DEFAULTS.profile)) profile[key] = String(data.get(key) || '').trim();
  return {profile, interval: Number(data.get('interval')), autoSubmit: data.has('autoSubmit'), alarmDuration: Number(data.get('alarmDuration')), from: data.get('from'), until: data.get('until'), after: data.get('after'), before: data.get('before'),
    weekdays: data.getAll('weekday').map(Number), excludedDates: String(data.get('excludedDates')).split(/[,，\s]+/).filter(Boolean),
    eligible: data.has('eligible'), extraFields: JSON.parse(String(data.get('extraFields')).trim() || '{}')};
}
async function request(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({type, ...extra});
  if (!result?.ok) throw new Error(result?.error || '操作未完成，请检查扩展是否重新加载。');
  return result;
}
function showSound(sound = {}) {
  const status = sound.error || (sound.active ? '铃声正在后台播放，可点“关闭铃声”停止。' : '铃声已停止。');
  const at = sound.requestedAt ? new Date(sound.requestedAt).toLocaleString('de-DE', {timeZone: 'Europe/Berlin'}) : '';
  $('sound-result').textContent = status + (sound.reason ? ` ${sound.active ? '本次' : '上次'}触发：${at} · ${sound.reason}` : '');
}
let captureGranted = false;
async function showCapturePermission() {
  const granted = !!chrome.permissions && await chrome.permissions.contains({origins: ['<all_urls>']});
  captureGranted = granted;
  $('capture-permission').textContent = granted ? '自动截图已启用。仅在绑定的官网标签页处于当前窗口活动页时截图。' : '自动截图尚未授权；卡住时仍会保存不含填写值的页面结构。';
  $('enable-capture').textContent = granted ? '关闭自动截图（撤销授权）' : '启用自动截图（浏览器授权）';
}
function showDiagnostics(records = []) {
  $('diagnostics').replaceChildren();
  if (!records.length) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = '尚无诊断记录。'; $('diagnostics').append(p); return; }
  for (const record of [...records].reverse()) {
    const details = document.createElement('details'), summary = document.createElement('summary');
    summary.textContent = `${new Date(record.at).toLocaleString('de-DE', {timeZone: 'Europe/Berlin'})} · ${record.diagnostic?.step ? '第 ' + record.diagnostic.step + ' 步' : record.phase}`;
    const reason = document.createElement('p'); reason.className = 'hint'; reason.textContent = record.message;
    details.append(summary, reason);
    const filename = 'termin-diagnostic-' + record.at;
    if (record.image) {
      const img = document.createElement('img'); img.src = record.image; img.alt = '当时官网页面的截图'; img.loading = 'lazy'; img.style.cssText = 'display:block;max-width:100%;border-radius:6px;margin:10px 0';
      const link = document.createElement('a'); link.href = record.image; link.download = filename + '.jpg'; link.textContent = '下载截图'; details.append(img, link, document.createTextNode(' · '));
    } else { const p = document.createElement('p'); p.className = 'hint'; p.textContent = record.captureError || '本条只有页面结构。'; details.append(p); }
    const json = document.createElement('a'); json.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify({...record, image: undefined}, null, 2)); json.download = filename + '.json'; json.textContent = '下载诊断信息'; details.append(json); $('diagnostics').append(details);
  }
}
function showRun(run = {}) {
  const phases = {idle: '待开始', checking: '检查中', navigating: '自动操作中', submitting: '已提交，等待结果', waiting: '监测中', 'human-wait': '等待你处理，完成后自动继续', paused: '已暂停', handoff: '需要你接手', done: '请核对官网结果'};
  $('phase').textContent = phases[run.phase] || '待开始';
  $('run-message').textContent = run.message || '保存资料后即可开始。';
  $('checks').textContent = `${run.checks || 0} 次`;
  $('next').textContent = run.active && run.nextCheckAt ? new Date(run.nextCheckAt).toLocaleTimeString('de-DE', {timeZone: 'Europe/Berlin'}) : '—';
  $('selected').hidden = !run.selected;
  $('selected').textContent = run.selected ? `${run.selected.date}  ${run.selected.time} · 德国时间` : '';
  $('start').disabled = !!run.active || !!run.submittedAt;
  $('resume').disabled = !!run.active || !run.tabId || !!run.submittedAt;
  $('stop').disabled = !run.active;
  $('reset-submission').hidden = !run.submittedAt || !!run.active;
  for (const control of form.elements) control.disabled = !!run.active;
  $('log').replaceChildren();
  const logs = run.log?.length ? [...run.log].reverse() : [{message: '尚无记录'}];
  for (const entry of logs) {
    const li = document.createElement('li');
    if (entry.at) { const t = document.createElement('time'); t.textContent = new Date(entry.at).toLocaleTimeString('de-DE', {timeZone: 'Europe/Berlin'}); li.append(t); }
    li.append(document.createTextNode(entry.message)); $('log').append(li);
  }
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const config = readForm(), errors = C.validate(config);
    if (errors.length) throw new Error(errors.join('\n'));
    const result = await request('SAVE_CONFIG', {config});
    const savedTime = new Date(result.savedAt || Date.now()).toLocaleTimeString('de-DE', {timeZone: 'Europe/Berlin'});
    $('save-result').textContent = `已保存到本地浏览器（${savedTime}）`;
  } catch (error) { $('save-result').textContent = '保存未成功：' + (error instanceof SyntaxError ? '补充字段 JSON 格式不正确。' : error.message); }
});
form.addEventListener('input', () => { $('save-result').textContent = '有修改，尚未保存'; });
form.addEventListener('change', () => { $('save-result').textContent = '有修改，尚未保存'; });
async function command(type, extra) {
  try { await request(type, extra); return true; }
  catch (error) { $('run-message').textContent = error.message; return false; }
}
$('start').addEventListener('click', () => command('START', {resume: false}));
$('resume').addEventListener('click', () => command('START', {resume: true}));
$('stop').addEventListener('click', () => command('STOP'));
$('open').addEventListener('click', () => command('OPEN_TAB'));
$('reset-submission').addEventListener('click', () => {
  if (confirm('请先检查官网及确认邮件。只有确认没有预约成功时，才应清除提交记录。确定没有预约成功并允许重新监测？')) void command('RESET_SUBMISSION', {confirmedNotBooked: true});
});
$('clear').addEventListener('click', async () => { if (await command('CLEAR_PROFILE')) { setForm(structuredClone(C.DEFAULTS)); $('save-result').textContent = '扩展内资料已清除'; } });
$('sound').addEventListener('click', async () => {
  try { await request('TEST_SOUND', {duration: Number(form.elements.alarmDuration.value)}); showSound((await chrome.storage.local.get('sound')).sound); }
  catch (error) { $('sound-result').textContent = error.message; }
});
$('stop-sound').addEventListener('click', async () => { if (await command('STOP_SOUND')) showSound((await chrome.storage.local.get('sound')).sound); });
$('enable-capture').addEventListener('click', async () => {
  try { if (!chrome.permissions) throw new Error('演示环境不申请浏览器权限。'); if (captureGranted) { await chrome.permissions.remove({origins: ['<all_urls>']}); await showCapturePermission(); return; } const granted = await chrome.permissions.request({origins: ['<all_urls>']}); await showCapturePermission(); if (!granted) $('capture-permission').textContent = '未授予截图权限；继续保留页面结构诊断。'; }
  catch (error) { $('capture-permission').textContent = error.message; }
});
chrome.storage.local.get(['config', 'configSavedAt', 'run', 'sound', 'diagnostics']).then(data => {
  setForm(data.config || structuredClone(C.DEFAULTS)); showRun(data.run);
  if (data.config) $('save-result').textContent = '已加载上次保存的资料';
  if (data.sound) showSound(data.sound);
  showDiagnostics(data.diagnostics);
});
void showCapturePermission();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.run) showRun(changes.run.newValue);
  if (changes.sound) showSound(changes.sound.newValue);
  if (changes.diagnostics) showDiagnostics(changes.diagnostics.newValue);
});
if (globalThis.TERMIN_DEMO) $('preview').hidden = false;
