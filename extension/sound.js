(function (root) {
  'use strict';
  let creating, queue = Promise.resolve();
  const serial = task => { const result = queue.then(task); queue = result.catch(() => {}); return result; };
  async function exists() {
    const contexts = await chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL('offscreen.html')]});
    return contexts.length > 0;
  }
  async function ensureDocument() {
    if (await exists()) return;
    if (!creating) creating = chrome.offscreen.createDocument({url: 'offscreen.html', reasons: ['AUDIO_PLAYBACK'], justification: 'Play the user-requested appointment alarm for two minutes or until dismissed.'});
    try { await creating; } finally { creating = null; }
  }
  root.TerminSound = {
    start(runId, duration = 120, reason = '') { return serial(async () => {
      const old = (await chrome.storage.local.get('sound')).sound;
      if (old?.runId === runId) return true; // A later success notification must not restart a dismissed alarm.
      const sound = {runId, active: true, requestedAt: Date.now(), reason: String(reason).slice(0, 200)};
      await chrome.storage.local.set({sound});
      try {
        await ensureDocument();
        const response = await chrome.runtime.sendMessage({target: 'offscreen', type: 'PLAY_ALARM', runId, duration: duration === 0 ? 0 : 120});
        if (!response?.ok) throw new Error('Audio playback failed');
        return true;
      } catch {
        await chrome.storage.local.set({sound: {...sound, active: false, error: '铃声无法播放，请测试声音并检查系统音量。'}});
        return false;
      }
    }); },
    stop() { return serial(async () => {
      const old = (await chrome.storage.local.get('sound')).sound || {};
      if (await exists()) await chrome.runtime.sendMessage({target: 'offscreen', type: 'STOP_ALARM'});
      await chrome.storage.local.set({sound: {...old, active: false}});
    }); },
    ended(runId) { return serial(async () => {
      const old = (await chrome.storage.local.get('sound')).sound;
      if (old?.runId === runId) await chrome.storage.local.set({sound: {...old, active: false}});
    }); }
  };
})(globalThis);
