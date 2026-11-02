/* Local diagnostics only. Never activates a tab, requests permission or uploads an image. */
(function (root) {
  'use strict';
  const ORIGIN = 'https://termine.staedteregion-aachen.de';
  const MAX_IMAGE = 1.5 * 1024 * 1024, MAX_IMAGES = 4 * 1024 * 1024, MAX_RECORDS = 6;
  let queue = Promise.resolve();
  const short = (value, length = 240) => typeof value === 'string' ? value.slice(0, length) : '';
  function location(value, base) {
    try { const url = new URL(value, base); return url.origin + url.pathname; } catch { return ''; }
  }
  function official(value) {
    try { const url = new URL(value); return url.origin === ORIGIN && url.pathname.startsWith('/auslaenderamt/'); } catch { return false; }
  }
  function structure(source, url) {
    // Accept structure metadata, never arbitrary payload keys, input values,
    // innerHTML, whole page text, cookies or session-bearing URL parameters.
    const clean = {url: location(url)};
    if (!source || typeof source !== 'object' || Array.isArray(source)) return clean;
    for (const key of ['title', 'heading']) if (typeof source[key] === 'string') clean[key] = short(source[key]);
    if (Number.isInteger(source.step)) clean.step = source.step;
    for (const key of ['hasCaptcha', 'hasAgreement', 'context']) if (typeof source[key] === 'boolean') clean[key] = source[key];
    let remainingNodes = 160;
    function node(item, depth = 0) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || depth > 2 || remainingNodes-- <= 0) return {};
      const result = {};
      for (const key of ['tag', 'tagName', 'type', 'name', 'id', 'role', 'autocomplete', 'method', 'label', 'title', 'heading', 'text']) {
        if (typeof item[key] === 'string') result[key] = short(item[key], key === 'text' ? 400 : 160);
      }
      for (const key of ['required', 'disabled', 'visible', 'checked', 'open']) if (typeof item[key] === 'boolean') result[key] = item[key];
      if (typeof item.action === 'string') result.action = location(item.action, url);
      for (const key of ['fields', 'controls', 'buttons']) if (Array.isArray(item[key])) result[key] = item[key].slice(0, 48).map(child => node(child, depth + 1));
      return result;
    }
    for (const key of ['forms', 'fields', 'controls', 'dialogs', 'buttons']) if (Array.isArray(source[key])) clean[key] = source[key].slice(0, key === 'forms' || key === 'dialogs' ? 8 : 48).map(item => node(item));
    if (source.finalButton && typeof source.finalButton === 'object') clean.finalButton = node(source.finalButton);
    return clean;
  }
  function entryFor(run) {
    const selected = run?.selected;
    return {
      id: crypto.randomUUID(), at: Date.now(), runId: short(run?.runId, 100),
      phase: short(run?.phase, 80), message: short(run?.message, 400),
      selected: selected && /^\d{4}-\d{2}-\d{2}$/.test(selected.date) && /^\d{2}:\d{2}$/.test(selected.time)
        ? {date: selected.date, time: selected.time} : null,
      diagnostic: {}
    };
  }
  function watch(tabId, windowId) {
    let revision = 0;
    const listeners = [];
    function add(event, listener) {
      if (event?.addListener && event?.removeListener) { event.addListener(listener); listeners.push([event, listener]); }
    }
    add(chrome.tabs.onActivated, info => { if (info.windowId === windowId) revision++; });
    add(chrome.tabs.onUpdated, (id, changes) => { if (id === tabId && (changes.url || changes.status === 'loading')) revision++; });
    add(chrome.tabs.onRemoved, id => { if (id === tabId) revision++; });
    return {get revision() { return revision; }, close() { for (const [event, listener] of listeners) event.removeListener(listener); }};
  }
  async function imageFor(tab) {
    const observer = watch(tab.id, tab.windowId);
    try {
      const permission = await chrome.permissions?.contains({origins: ['<all_urls>']});
      if (!permission) throw new Error('未授权自动截图；仅保留可获取的页面结构。');
      async function verify() {
        const active = await chrome.tabs.query({active: true, windowId: tab.windowId});
        const current = await chrome.tabs.get(tab.id);
        if (active.length !== 1 || active[0].id !== tab.id) throw new Error('预约标签页不在其窗口当前显示；未切换窗口或截图。');
        if (current.id !== tab.id || current.windowId !== tab.windowId || !official(current.url) || current.url !== tab.url) throw new Error('预约标签页已改变或离开官网，未保留截图。');
        if (observer.revision !== 0) throw new Error('截图期间标签页或页面发生变化，未保留截图。');
      }
      await verify();
      const image = await chrome.tabs.captureVisibleTab(tab.windowId, {format: 'jpeg', quality: 50});
      await verify();
      if (typeof image !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=\r\n]+$/.test(image)) throw new Error('浏览器未返回有效 JPEG 截图。');
      if (image.length > MAX_IMAGE) throw new Error('截图超过 1.5 MiB 字符上限，未保留图片。');
      return {image};
    } catch (error) {
      // Browser exception text can contain URLs or session data; only our fixed
      // explanations are retained, never the native exception message.
      return {captureError: /^(未授权自动截图|预约标签页|截图期间|浏览器未返回|截图超过)/.test(error?.message || '') ? error.message : '截图失败，页面可能已关闭或浏览器拒绝捕获；已保留诊断。'};
    } finally { observer.close(); }
  }
  async function record(run, diagnostic) {
    const stored = await chrome.storage.local.get('diagnostics');
    let records = Array.isArray(stored.diagnostics) ? stored.diagnostics : [];
    const entry = entryFor(run);
    if (records.some(old => old.runId === entry.runId && old.phase === entry.phase && old.message === entry.message && entry.at >= old.at && entry.at - old.at < 5000)) return null;
    let tab;
    try {
      tab = await chrome.tabs.get(run?.tabId);
      if (tab.id !== run?.tabId || !official(tab.url)) throw new Error('outside');
    } catch {
      entry.captureError = '绑定的预约标签页已关闭或不在外管局官网；未读取页面或截图。';
    }
    if (tab && !entry.captureError) {
      let source = diagnostic;
      if (source === undefined) {
        try { const reply = await chrome.tabs.sendMessage(tab.id, {type: 'GET_DIAGNOSTIC'}); source = reply?.diagnostic || reply; }
        catch { entry.diagnosticError = '无法读取页面结构；官网标签页可能正在跳转。'; }
      }
      entry.diagnostic = structure(source, tab.url);
      Object.assign(entry, await imageFor(tab));
    }
    records = [...records, entry].slice(-MAX_RECORDS);
    const imageSize = () => records.reduce((sum, item) => sum + (typeof item.image === 'string' ? item.image.length : 0), 0);
    while (records.length > 1 && imageSize() > MAX_IMAGES) records.shift();
    await chrome.storage.local.set({diagnostics: records});
    return entry;
  }
  root.TerminDiagnostics = {record(run, diagnostic) {
    // Callers can keep advancing their mutable run while this local queue waits.
    // Preserve the state that actually triggered this diagnostic.
    const snapshot = {tabId: run?.tabId, runId: run?.runId, phase: run?.phase, message: run?.message,
      selected: run?.selected ? {date: run.selected.date, time: run.selected.time} : null};
    const result = queue.then(() => record(snapshot, diagnostic)).catch(() => null);
    queue = result;
    return result;
  }, clear() {
    // Serialize deletion after pending captures so an older screenshot cannot
    // reappear after the user clears their personal data. Unlike recording,
    // deletion errors reach the caller so the UI cannot report false success.
    const result = queue.then(() => chrome.storage.local.remove('diagnostics'));
    queue = result.catch(() => null);
    return result;
  }};
})(globalThis);
