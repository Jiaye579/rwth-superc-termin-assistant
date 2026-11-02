/* DOM adapter. All actions use the official form controls and the existing session. */
(function (root) {
  'use strict';
  const C = root.TerminCore;
  const all = (doc, q) => [...doc.querySelectorAll(q)];
  const visible = el => !!el && !el.disabled && !el.closest('[hidden], [aria-hidden="true"]')
    && (!el.closest('details:not([open])') || [...el.closest('details:not([open])').children].some(child => child.tagName === 'SUMMARY' && (child === el || child.contains(el))))
    && el.getAttribute('aria-disabled') !== 'true'
    && el.ownerDocument.defaultView.getComputedStyle(el).display !== 'none'
    && el.ownerDocument.defaultView.getComputedStyle(el).visibility !== 'hidden'
    && !!el.getClientRects().length;
  const text = el => (el?.innerText || el?.textContent || el?.value || '').trim();
  function label(el) {
    return [...(el.labels || [])].map(text).join(' ') || el.getAttribute('aria-label') || el.placeholder || '';
  }
  function step(doc) { return Number(all(doc, 'h1').filter(visible).map(text).join(' ').match(/Schritt\s*(\d)/i)?.[1] || 0); }
  function nextButton(doc) {
    const candidates = all(doc, 'input[type="submit"], button, a[role="button"]')
      .filter(el => visible(el) && /^(Weiter|Fortfahren)$/i.test(text(el)));
    return candidates.length === 1 ? candidates[0] : null;
  }
  function context(doc) {
    const box = doc.querySelector('#details_infobox, #info_box_cnc_list')?.closest('#details_infobox') || doc.querySelector('#details_infobox');
    const value = text(box);
    return /RWTH Studenten/.test(value) && /Außenstelle RWTH|Aussenstelle RWTH|Super\s*C/i.test(value)
      && !/FH Studenten|RWTH Familienangehörige|RWTH Mitarbeitende/.test(value);
  }
  function setValue(el, value) {
    const win = el.ownerDocument.defaultView;
    const proto = el.tagName === 'SELECT' ? win.HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new win.Event('input', {bubbles: true}));
    el.dispatchEvent(new win.Event('change', {bubbles: true}));
  }
  function slots(doc) {
    const found = [];
    // suggest_details_summary is only the date heading. The actual buttons live in
    // its sibling panel inside details_suggest_times, not inside the summary.
    const areas = all(doc, '#sugg_accordion, #suggest_details, #details_suggest_times, .suggest_details_panel, .sugg_table');
    const areasToRead = areas.length ? areas : [doc.querySelector('#inhalt') || doc.body];
    const selector = 'input[type="radio"],button,input[type="submit"],input[type="button"],a[href],[role="button"]';
    const controls = [...new Set(areasToRead.flatMap(area => all(area, selector)))];
    for (const control of controls) {
      if (control.disabled || control.getAttribute('aria-disabled') === 'true' || control.closest('[hidden]')) continue;
      if (control.id === 'WeiterButton' || control.id === 'zurueck') continue;
      const el = visible(control) ? control : control.type === 'radio' ? [...(control.labels || [])].find(visible) || control : control;
      const collapsed = control.closest('details:not([open])');
      const expand = collapsed ? [...collapsed.children].find(child => child.tagName === 'SUMMARY') : null;
      if (!visible(el) && !(expand && visible(expand))) continue;
      const ownText = [label(control), text(control), control.getAttribute('title') || ''].join(' ');
      let time = C.parseTime(ownText), date = C.parseDate(ownText);
      let node = control.parentElement;
      // A time button inherits its date from the closest date group, never from the whole page.
      const dateGroup = control.closest('details');
      if (!date && dateGroup) date = C.parseDate(text([...dateGroup.children].find(child => child.tagName === 'SUMMARY')));
      for (let depth = 0; node && depth < 12 && node.id !== 'inhalt' && node !== doc.body; depth++, node = node.parentElement) {
        if (!date) {
          const headings = all(node, 'h2,h3,h4,summary,legend');
          const dates = [...new Set(headings.map(h => C.parseDate(text(h))).filter(Boolean))];
          if (dates.length === 1) date = dates[0];
          if (!date) date = C.parseDate(text(node));
        }
        if (!time && node.querySelectorAll(selector).length === 1) time = C.parseTime(text(node));
        if (date && time) break;
      }
      if (date && time) found.push({date, time, el, control, expand, label: `${date} ${time}`});
    }
    return found;
  }
  function isChallengeField(el) {
    return /captcha|sicherheitsfrage|security.?code/i.test([el.id, el.name, label(el)].join(' '));
  }
  function personalForm(doc) {
    const form = doc.querySelector('form#cal-reservation');
    if (!form || form.method.toLowerCase() !== 'post') return null;
    try { return new URL(form.action).pathname.replace(/\/$/, '') === '/auslaenderamt/personaldata' ? form : null; } catch { return null; }
  }
  function birthPart(meta) {
    const sources = [meta.id, meta.name, meta.autocomplete].map(C.norm);
    for (const part of ['day', 'month', 'year']) if (sources.some(value => value === 'geburtsdatum' + part || value === 'bday' + part)) return part;
    return null;
  }
  function fields(doc) {
    return all(doc, 'input,select,textarea').filter(el => visible(el) && !isChallengeField(el) && !['hidden', 'submit', 'button', 'reset', 'radio', 'checkbox', 'password', 'file'].includes(el.type))
      .map(el => ({el, name: el.name, id: el.id, type: el.type, label: label(el), autocomplete: el.autocomplete, required: el.required || el.getAttribute('aria-required') === 'true'}));
  }
  function missingFields(doc) {
    return fields(doc).filter(meta => meta.required && (!meta.el.value.trim() || !meta.el.checkValidity())).map(meta => meta.label || meta.name || meta.id);
  }
  function humanRequirements(doc) {
    const captchaFields = all(doc, 'input,textarea').filter(el => visible(el) && isChallengeField(el));
    const missing = [];
    if (captchaFields.some(el => !el.value.trim() || !el.checkValidity())) missing.push('官网验证码');
    if (all(doc, 'input[type="checkbox"]').some(el => visible(el) && (el.required || el.getAttribute('aria-required') === 'true') && !el.checked)) missing.push('官网必选同意项');
    return {missing, captchaFields};
  }
  function fill(doc, config) {
    const filled = [], missing = [];
    for (const meta of fields(doc)) {
      const key = C.fieldKey(meta), part = birthPart(meta);
      let value = Object.hasOwn(config.extraFields, meta.name) ? config.extraFields[meta.name] : key ? config.profile[key] : undefined;
      if (!Object.hasOwn(config.extraFields, meta.name) && part && C.validDate(config.profile.birthDate)) {
        const [year, month, day] = config.profile.birthDate.split('-');
        value = String(Number({year, month, day}[part]));
      }
      if (value) {
        if (!part && key === 'birthDate' && meta.type !== 'date') {
          const [y, m, d] = value.split('-'); value = `${d}.${m}.${y}`;
        }
        if (meta.el.tagName === 'SELECT') {
          const option = [...meta.el.options].find(o => o.value === value || C.norm(o.text) === C.norm(value));
          if (option) setValue(meta.el, option.value);
        } else if (meta.el.value !== value) setValue(meta.el, value);
        filled.push(meta.label || meta.name || meta.id);
      }
      if (meta.required && (!meta.el.value.trim() || !meta.el.checkValidity())) missing.push(meta.label || meta.name || meta.id);
    }
    return {filled, missing};
  }
  function diagnostic(doc) {
    const main = doc.querySelector('#inhalt') || doc.body;
    const path = value => { try { return new URL(value).pathname; } catch { return ''; } };
    return {
      step: step(doc), heading: all(doc, 'h1').filter(visible).map(text).find(value => /Schritt\s*\d/i.test(value)) || '',
      forms: all(main, 'form').map(el => ({id: el.id, method: el.method, action: path(el.action)})),
      controls: all(main, 'input,textarea,select,button,a[role="button"]').filter(visible).map(el => ({tag: el.tagName, id: el.id, name: el.name || '', type: el.type || '', required: !!el.required, disabled: !!el.disabled, autocomplete: el.autocomplete || '', label: (['submit','button'].includes(el.type) || el.tagName === 'BUTTON' ? text(el) : label(el)).slice(0, 160)})),
      dialogs: all(doc, '#TevisDialog,[role="dialog"],dialog[open]').filter(visible).map(el => ({id: el.id, text: (typeof el.innerText === 'string' ? el.innerText : '').trim().slice(0, 1600), buttons: all(el, 'button,input[type="button"],input[type="submit"],a[role="button"]').filter(visible).map(button => ({id: button.id, text: text(button).slice(0, 160), type: button.type || ''}))}))
    };
  }
  function appointment(doc) {
    const box = doc.querySelector('#details_infobox');
    const dt = box ? all(box, 'dt').find(el => C.norm(text(el)) === 'termin') : null;
    const value = dt?.nextElementSibling?.tagName === 'DD' ? text(dt.nextElementSibling) : '';
    return {date: C.parseDate(value), time: C.parseTime(value)};
  }
  function finalButton(doc) {
    const pattern = /^(?:Termin(?:\s+(?:jetzt|verbindlich))?\s+(?:buchen|vereinbaren|reservieren|anfragen|bestätigen)|(?:jetzt\s+)?(?:buchen|reservieren|absenden|bestätigen)|Anfrage\s+(?:senden|absenden))$/i;
    const buttons = all(doc, 'button,input[type="submit"]')
      .filter(el => visible(el) && el.form && pattern.test(text(el).replace(/\s+/g, ' ')));
    return buttons.length === 1 ? buttons[0] : null;
  }
  function dialogs(doc) {
    const selector = '#TevisDialog,[role="dialog"],dialog[open],.modal,.ui-dialog';
    const roots = [...new Set(all(doc, selector).filter(visible).map(el => {
      const outer = el.parentElement?.closest('[role="dialog"],dialog[open],.modal,.ui-dialog');
      return outer && visible(outer) ? outer : el;
    }))];
    return roots.filter(el => !roots.some(other => other !== el && other.contains(el)));
  }
  function slotDialogButton(dialog, doc, config, session, currentStep) {
    // User-authorized spatial fallback, limited to the first dialog after this
    // run selects a time. The background consumes its one-use permit first.
    const selected = session.selected;
    if (session.awaitingSlotDialog !== true || session.submittedAt || ![4, 5].includes(currentStep)
        || !selected || !C.choose([selected], config) || !context(doc) || dialogs(doc).length !== 1) return null;
    const panel = dialog.querySelector('.modal-content') || dialog;
    const body = typeof panel.innerText === 'string' ? panel.innerText : text(panel);
    if (/captcha|Sicherheits(?:frage|abfrage)|Datenschutz|DS.?GVO|\bAGB\b|Einwillig|zustimm|akzeptier|einverstanden|verbindlich|kostenpflicht|Gebühr|Zahlung|Vertrag|Fehler|fehlgeschlagen|\berror\b|abgelaufen|nicht (?:mehr )?verfügbar|bereits (?:vergeben|belegt)|access denied|too many|zu viele Anfragen/i.test(body)) return null;
    if (all(panel, 'input,textarea,select,iframe').some(el => visible(el) && !['hidden','button','submit','reset'].includes(el.type))) return null;
    const blue = el => {
      const color = el.ownerDocument.defaultView.getComputedStyle(el).backgroundColor;
      const rgb = color.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
      return rgb && Number(rgb[3]) >= 70 && Number(rgb[3]) > Number(rgb[1]) * 1.2 && Number(rgb[3]) > Number(rgb[2]) * 1.1;
    };
    // Bootstrap and jQuery place their footer in different nodes. Search only
    // inside the visible dialog, so the page's own Weiter cannot be selected.
    const footer = dialog.querySelector('.modal-footer,.ui-dialog-buttonpane,.dialog-buttons') || panel;
    const bounds = panel.getBoundingClientRect();
    const buttons = all(footer, 'button,input[type="button"],input[type="submit"],a[href],[role="button"]')
      .filter(el => visible(el) && blue(el) && el.ownerDocument.defaultView.getComputedStyle(el).pointerEvents !== 'none')
      .map(el => ({el, rect: el.getBoundingClientRect()}))
      .filter(({rect}) => rect.width >= 30 && rect.height >= 18 && rect.left >= bounds.left - 2 && rect.right <= bounds.right + 2 && rect.top >= bounds.top + bounds.height * 0.5 && rect.bottom <= bounds.bottom + 2);
    if (buttons.length < 2) return null;
    const bottom = Math.max(...buttons.map(item => item.rect.bottom));
    const row = buttons.filter(({rect}) => Math.abs(rect.bottom - bottom) <= Math.max(8, rect.height * 0.25)).sort((a, b) => a.rect.left - b.rect.left);
    if (row.length !== 2) return null;
    const [left, right] = row, center = bounds.left + bounds.width / 2;
    if (left.rect.right > right.rect.left + 2 || Math.abs(left.rect.top - right.rect.top) > Math.max(8, right.rect.height * 0.25)
        || left.rect.left + left.rect.width / 2 >= center || right.rect.left + right.rect.width / 2 <= center) return null;
    const button = right.el, name = C.norm(text(button) || label(button));
    if (/abbrechen|zuruck|nein|cancel|schliess|close|reservier|buchen|absenden|anfragen|anfragesenden|bestatig/.test(name)
        || ((button.type || '').toLowerCase() === 'submit' && button.form)) return null;
    return button;
  }
  function submission(doc, config, session = {}) {
    if (config.autoSubmit === false) return {kind: 'review', message: '资料已填写，请在官网核对并完成提交。'};
    if (session.submittedAt) return {kind: 'pause', message: '本轮已经发送过一次预约，请核对官网及邮箱结果；不会再次提交。'};
    if (!context(doc)) return {kind: 'pause', message: '提交前无法确认 RWTH 学生及 SuperC 分类。'};
    const slot = appointment(doc), selected = session.selected;
    if (!selected || slot.date !== selected.date || slot.time !== selected.time || !C.choose([slot], config)) return {kind: 'pause', message: '提交前无法核实官网摘要中的日期和时间与已选时间一致，请手动核对。'};
    const button = finalButton(doc);
    if (!button) return {kind: 'pause', message: '无法唯一识别最终预约按钮，请手动核对官网。'};
    if (!button.form.checkValidity()) return {kind: 'pause', message: '官网仍有必填项、同意项或格式错误，请处理后继续。'};
    const normalize = value => String(value).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
    const summary = normalize(text(doc.querySelector('#details_infobox')));
    const meta = fields(doc);
    for (const key of ['firstName', 'lastName', 'email']) {
      const expected = normalize(config.profile[key]);
      const matchingFields = meta.filter(field => C.fieldKey(field) === key);
      if (!expected || (matchingFields.length ? matchingFields.some(field => normalize(field.el.value) !== expected) : !summary.includes(expected))) return {kind: 'pause', message: '提交前无法核实姓名或邮箱与保存的资料一致，请手动核对。'};
    }
    return {kind: 'submit', el: button, slot, message: `正在自动提交 ${slot.date} ${slot.time} 的预约；本轮仅发送一次。`};
  }
  function inspect(doc, config, session = {}) {
    const main = doc.querySelector('#inhalt') || doc.body;
    const body = typeof main.innerText === 'string' ? main.innerText.trim() : text(main);
    const currentStep = step(doc);
    const heading = text(doc.querySelector('h1'));
    const dialog = dialogs(doc)[0];
    if (dialog) {
      const ok = dialog.querySelector('#OKButton');
      if (currentStep === 2 && /Anliegen:\s*RWTH Studenten/.test(text(dialog)) && visible(ok)) return {kind: 'click', el: ok, message: '确认 RWTH 学生服务说明。'};
      const next = slotDialogButton(dialog, doc, config, session, currentStep);
      if (next) return {kind: 'slot-confirm', el: next, message: '按选时后弹窗内右下角蓝色按钮的位置自动确认，进入资料填写。'};
      return {kind: 'manual', message: '官网弹出尚未核实的提示，已保留现场并记录诊断。请阅读并处理弹窗，关闭后助手会自动继续。'};
    }
    const captcha = all(doc, 'iframe[src*="recaptcha"],iframe[src*="hcaptcha"],img[src*="captcha"],#captcha_image,input[name*="captcha"],input[id*="captcha"]').filter(visible);
    const knownForm = currentStep === 5 ? personalForm(doc) : null;
    const inlineCaptcha = knownForm && captcha.every(el => el.tagName !== 'IFRAME' && knownForm.contains(el));
    if ((captcha.length && !inlineCaptcha) || /verify you are human|unusual traffic|zu viele Anfragen|access denied|too many requests|überprüfen Sie.*Mensch/i.test(body)) return {kind: 'pause', message: '网站要求验证或限制了访问，请在官网手动处理后继续。'};
    if (currentStep !== 5 && !personalForm(doc)) {
      if (/Termin.*(?:erfolgreich gebucht|erfolgreich vereinbart)|(?:erfolgreich gebucht|erfolgreich vereinbart).*Termin/i.test(body)) return {kind: 'done', message: '官网显示预约成功。请保存确认邮件／凭证，核对是否还需邮箱确认。'};
      if (/bestätigen Sie.*E-Mail|E-Mail.*Bestätigungslink|Link.*E-Mail.*bestätigen/i.test(body)) return {kind: 'done', message: '官网提示需要邮箱确认。请立即查收邮件并完成确认；当前不应视为最终预约成功。'};
    }
    if (/Sitzung.*(?:abgelaufen|beendet)|Session.*expired/i.test(body)) return {kind: 'restart', message: '会话已过期，将重建预约流程。'};
    if (currentStep === 1) {
      const button = all(doc, 'button,input[type="submit"],a').find(el => visible(el) && C.norm(text(el)) === C.norm('Ausländer- und Staatsangehörigkeitsbehörde'));
      return button ? {kind: 'click', el: button, message: '进入外管局预约。'} : {kind: 'pause', message: '无法识别功能分类，请手动选择外管局。'};
    }
    if (currentStep === 2) {
      const inputs = all(doc, 'input.cnc-number');
      const target = inputs.filter(el => C.norm(el.dataset.tevisCncname || label(el)) === C.norm('RWTH Studenten'));
      if (target.length !== 1) return {kind: 'pause', message: '无法唯一识别 RWTH Studenten，停止以免选错服务。'};
      if (inputs.some(el => el !== target[0] && Number(el.value) > 0) || Number(target[0].value) > 1) return {kind: 'pause', message: '已选事项或人数不符合单人 RWTH 学生预约，请手动核对。'};
      const panel = target[0].closest('[role="tabpanel"]');
      if (panel && panel.getAttribute('aria-hidden') === 'true') {
        const header = doc.getElementById(panel.getAttribute('aria-labelledby'));
        if (visible(header)) return {kind: 'click', el: header, message: '展开 SuperC 分类。'};
      }
      if (Number(target[0].value) === 0) {
        const plus = all(doc, 'button[data-type="plus"]').find(el => el.dataset.field === target[0].name);
        return plus && visible(plus) ? {kind: 'click', el: plus, message: '选择 1 位 RWTH 学生。'} : {kind: 'pause', message: '学生人数控件发生变化，请手动核对。'};
      }
      const next = nextButton(doc);
      return next ? {kind: 'click', el: next, message: '前往地点选择。'} : {kind: 'pause', message: '请手动核对所选事项。'};
    }
    if (currentStep === 3) {
      if (!/RWTH Studenten/.test(text(doc.querySelector('#info_box_cnc_list')))) return {kind: 'pause', message: '当前事项不是 RWTH Studenten。'};
      if (!/Außenstelle RWTH|Aussenstelle RWTH/i.test(body)) return {kind: 'pause', message: '无法核实 SuperC 地点。'};
      const next = nextButton(doc);
      return next ? {kind: 'click', el: next, message: '查询 SuperC 可预约时间。'} : {kind: 'pause', message: '地点页需要手动选择 SuperC。'};
    }
    if ([4, 5, 6].includes(currentStep) && !context(doc)) return {kind: 'pause', message: '预约摘要未能确认是 RWTH 学生及 SuperC，请手动核对。'};
    if (currentStep === 4) {
      if (/Kein freier Termin verfügbar/.test(body)) return {kind: 'watch', message: '暂无空位，等待下次检查。'};
      const available = slots(doc);
      const calendarButtons = all(doc, '.sugg_table .suggest_btn');
      if (!available.length && calendarButtons.length && calendarButtons.every(el => el.disabled || el.getAttribute('aria-disabled') === 'true')) return {kind: 'watch', message: '本页时间已全部失效，继续检查新空位。'};
      if (!available.length) return {kind: 'pause', message: '时间页面结构无法识别，请手动选择；不会把未知页面当成无号。'};
      const best = C.choose(available, config);
      if (!best) return {kind: 'watch', message: '有时间但不符合你的日期／时段条件，继续监测。'};
      if (!visible(best.el) && best.expand) return {kind: 'click', el: best.expand, message: `展开 ${best.date} 的可预约时间。`};
      if (best.control.type === 'radio' && best.control.checked) {
        const next = nextButton(doc);
        return next ? {kind: 'slot-next', el: next, slot: {date: best.date, time: best.time}, message: `进入 ${best.label} 的资料填写。`} : {kind: 'pause', message: '时间已选定，请手动继续。'};
      }
      return {kind: 'slot', el: best.el, slot: {date: best.date, time: best.time}, message: `选择最早符合条件的时间：${best.label}（德国当地时间）。`};
    }
    if (currentStep === 5) return {kind: 'fill', message: '发现资料表单，准备填写。'};
    if (currentStep === 6) return submission(doc, config, session);
    return {kind: 'pause', message: `无法识别当前页面${heading ? '：' + heading : ''}。请手动检查后继续。`};
  }
  root.TerminAdapter = {visible, text, label, step, nextButton, context, setValue, slots, fields, missingFields, isChallengeField, personalForm, birthPart, humanRequirements, fill, diagnostic, appointment, finalButton, dialogs, slotDialogButton, submission, inspect};
})(globalThis);
