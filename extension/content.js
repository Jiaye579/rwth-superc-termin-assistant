(function () {
  'use strict';
  if (window.top !== window) return;
  const A = globalThis.TerminAdapter;
  let active = false, busy = false, waiting = false, waking = false, humanWaiting = false, humanReason, config, runId, timer, lastAction, selected, submittedAt, awaitingSlotDialog = false, slotDialogArmed = false;
  const filledForms = new WeakSet();
  const send = async data => chrome.runtime.sendMessage({...data, runId});
  const host = document.createElement('div');
  host.id = 'rwth-termin-assistant';
  const shadow = host.attachShadow({mode: 'closed'});
  const style = document.createElement('style');
  style.textContent = ':host{all:initial;position:fixed;bottom:14px;right:14px;z-index:2147483647}section{font:14px/1.5 system-ui,sans-serif;background:#153f35;color:#fff;max-width:350px;padding:15px 18px;border-radius:12px;box-shadow:0 6px 30px #0003}strong{display:block}p{margin:7px 0}button{font:inherit;background:#fff;color:#153f35;border:0;border-radius:5px;padding:5px 12px;cursor:pointer}';
  const panel = document.createElement('section');
  const title = document.createElement('strong'); title.textContent = 'RWTH SuperC Termin 助手';
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const stop = document.createElement('button'); stop.textContent = '暂停';
  stop.addEventListener('click', async () => { active = false; clearTimeout(timer); await send({type: 'MANUAL_STOP'}); status.textContent = '已暂停；点击浏览器的扩展图标可打开设置。'; });
  panel.append(title, status, stop); shadow.append(style, panel);
  function show(message) { if (!host.isConnected) document.documentElement.append(host); status.textContent = message; }
  function later(ms = 500) { clearTimeout(timer); if (active) timer = setTimeout(tick, ms); }
  async function handoff(message, type = 'HANDOFF') {
    show(message); active = false; clearTimeout(timer);
    await send({type, message, diagnostic: A.diagnostic(document)});
  }
  async function waitForHuman(message) {
    show(message); humanWaiting = true;
    if (humanReason !== message) {
      humanReason = message;
      const result = await send({type: 'HUMAN_WAIT', message, diagnostic: A.diagnostic(document)});
      if (!result?.active) { active = false; return; }
    }
    later(1000);
  }
  async function act(plan) {
    if (!plan.el?.isConnected || !A.visible(plan.el)) return handoff('待点击控件已变化，请手动核对后继续。');
    // A changed DOM can cause the observer to run twice. Never click the same unchanged control twice.
    if (lastAction?.el === plan.el && lastAction.kind === plan.kind) {
      if (Date.now() - lastAction.at < (plan.kind === 'slot' ? 15000 : 2500)) { later(700); return; }
      return handoff('点击后页面没有推进，已保留现场，请手动检查提示。');
    }
    const slotDialog = plan.kind === 'slot-confirm';
    const result = await send({type: 'ACTION', message: plan.message, slot: plan.slot, ...(slotDialog ? {slotDialog: true, dialogSlot: selected, diagnostic: A.diagnostic(document)} : {})});
    if (!active || !result?.active) { active = false; return; }
    if (slotDialog && !result.ok) return handoff(result.error || '选时弹窗自动确认许可已失效，请手动核对。');
    if (slotDialog && A.inspect(document, config, {selected, submittedAt, awaitingSlotDialog: true}).el !== plan.el) return handoff('选时弹窗在点击前发生变化，已保留现场，请手动核对。');
    humanWaiting = false; humanReason = null;
    show(plan.message);
    lastAction = {el: plan.el, kind: plan.kind, at: Date.now()};
    if (plan.slot) { selected = plan.slot; if (!slotDialogArmed) { slotDialogArmed = true; awaitingSlotDialog = true; } }
    if (slotDialog) awaitingSlotDialog = false;
    if (result.awaitingSlotDialog !== undefined) awaitingSlotDialog = result.awaitingSlotDialog;
    if (result.slotDialogArmed !== undefined) slotDialogArmed = result.slotDialogArmed;
    plan.el.click(); later(700);
  }
  async function submit(plan) {
    // The background persists the intent before the DOM click, including across page loads.
    const result = await send({type: 'SUBMIT', slot: plan.slot, message: plan.message});
    if (!active || !result?.ok || !result?.active) return handoff(result?.error || '本轮已发送过提交请求，请核对结果。');
    submittedAt = result.submittedAt;
    humanWaiting = false; humanReason = null;
    show(plan.message); plan.el.click(); later(700);
  }
  async function tick() {
    if (!active || busy || waiting) return;
    busy = true;
    try {
      const plan = A.inspect(document, config, {selected, submittedAt, awaitingSlotDialog});
      show(plan.message);
      if (submittedAt && plan.kind !== 'done') {
        if (Date.now() - submittedAt < 20000) { later(700); return; }
        return await handoff('已发送一次预约，但官网尚未显示明确结果。请核对官网及邮箱，不会重复发送。');
      }
      if (['click', 'slot', 'slot-next', 'slot-confirm'].includes(plan.kind)) await act(plan);
      else if (plan.kind === 'submit') await submit(plan);
      else if (plan.kind === 'watch') { waiting = true; clearTimeout(timer); await send({type: 'WAIT', message: plan.message}); }
      else if (plan.kind === 'restart') { active = false; await send({type: 'RESTART'}); }
      else if (plan.kind === 'manual') await waitForHuman(plan.message);
      else if (plan.kind === 'fill') {
        const next = A.nextButton(document);
        const finalButton = A.finalButton(document);
        const form = A.personalForm(document) || finalButton?.form || next?.form;
        if (!form) return await handoff('无法识别个人资料表单，请手动填写。可在设置中添加精确字段映射。');
        if (!filledForms.has(form)) {
          const permission = await send({type: 'ACTION', formReady: true, message: '正在本地读取资料并填入官网表单。'});
          if (!active || !permission?.active) { active = false; return; }
          awaitingSlotDialog = false;
          const result = A.fill(document, config);
          filledForms.add(form);
          if (!result.filled.length) return await handoff('无法识别个人资料字段，请手动填写。可在设置中添加精确字段映射。');
        }
        const missing = A.missingFields(document), human = A.humanRequirements(document);
        if (missing.length) await waitForHuman(`已填写可识别资料，仍需手动填写：${missing.join('、')}。补齐后将自动继续。`);
        else if (human.missing.length) await waitForHuman(`资料已填写，请完成：${human.missing.join('、')}。完成并移出验证码输入框后将自动继续；不会刷新此页。`);
        else if (human.captchaFields.includes(document.activeElement)) await waitForHuman('正在等待你完成验证码输入。填写完成后请移出输入框，助手会自动核对并继续。');
        else if (A.finalButton(document)) {
          const final = A.submission(document, config, {selected, submittedAt});
          if (final.kind === 'submit') await submit(final); else await handoff(final.message);
        }
        else if (form && form.checkValidity() && !form.querySelector('input[type="file"],input[type="password"]')) await act({kind: 'filled-next', el: next, message: '资料已填写，进入最终核对页。'});
        else await waitForHuman('已填写资料。官网仍有必填项或格式校验未通过，请处理后移出输入框，助手会自动继续。');
      } else await handoff(plan.message, plan.kind === 'done' ? 'DONE' : 'HANDOFF');
    } catch { await handoff('页面处理发生错误，已暂停。请检查当前页面后继续。'); }
    finally { busy = false; }
  }
  async function wake() {
    if (waking || active) return;
    waking = true;
    try {
      const result = await send({type: 'READY'});
      if (!result?.active) return;
      config = result.config; runId = result.runId; selected = result.selected; submittedAt = result.submittedAt; awaitingSlotDialog = !!result.awaitingSlotDialog; slotDialogArmed = !!result.slotDialogArmed; active = true; waiting = false; humanWaiting = false; humanReason = null; lastAction = null;
      await tick();
    } finally { waking = false; }
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message.type === 'GET_DIAGNOSTIC') { reply({ok: true, diagnostic: A.diagnostic(document)}); }
    else if (message.type === 'STOP') { active = false; clearTimeout(timer); show(message.message || '自动操作已暂停。可在设置页继续，或手动完成官网预约。'); reply({ok: true}); }
    else if (message.type === 'WAKE') { wake(); reply({ok: true}); }
    else if (message.type === 'CAN_RELOAD') {
      const plan = config ? A.inspect(document, config) : null;
      reply({safe: active && plan?.kind === 'watch' && A.step(document) === 4});
    }
  });
  for (const event of ['input', 'change', 'focusout']) document.addEventListener(event, () => { if (active && humanWaiting) later(300); }, true);
  const observer = new MutationObserver(() => later(400));
  observer.observe(document.body, {subtree: true, childList: true, attributes: true, attributeFilter: ['aria-hidden', 'disabled', 'aria-disabled', 'hidden', 'open', 'style', 'class']});
  wake().catch(() => {});
})();
