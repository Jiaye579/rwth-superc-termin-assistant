(function () {
  'use strict';
  const audio = new Audio(chrome.runtime.getURL('alert.wav'));
  audio.loop = true;
  let timer, runId;
  function stop() {
    clearTimeout(timer); timer = undefined; audio.pause(); audio.currentTime = 0;
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.target !== 'offscreen' || sender.id !== chrome.runtime.id) return false;
    if (message.type === 'STOP_ALARM') { stop(); respond({ok: true}); return false; }
    if (message.type !== 'PLAY_ALARM') return false;
    stop(); runId = message.runId;
    audio.play().then(() => {
      if (message.duration !== 0) timer = setTimeout(() => {
        stop(); chrome.runtime.sendMessage({type: 'SOUND_ENDED', runId}).catch(() => {});
      }, 120000);
      respond({ok: true});
    }, () => respond({ok: false, error: 'Audio playback failed'}));
    return true;
  });
})();
