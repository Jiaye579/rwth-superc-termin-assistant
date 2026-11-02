/* Pure selection rules shared by the extension and offline tests. No network. */
(function (root) {
  'use strict';
  const START = 'https://termine.staedteregion-aachen.de/auslaenderamt/select2?md=1';
  const DEFAULTS = {
    interval: 60, from: '', until: '', after: '00:00', before: '23:59', autoSubmit: true, alarmDuration: 120,
    weekdays: [1, 2, 3, 4, 5], excludedDates: [], eligible: false,
    profile: {firstName: '', lastName: '', email: '', birthDate: '', phone: '', street: '', houseNumber: '', postalCode: '', city: ''},
    extraFields: {}
  };
  const norm = s => String(s ?? '').normalize('NFKC').toLowerCase()
    .replace(/ß/g, 'ss').replace(/[ä]/g, 'a').replace(/[ö]/g, 'o').replace(/[ü]/g, 'u')
    .replace(/[^a-z0-9]/g, '');
  function sameJSON(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) || Array.isArray(b)) {
      return Array.isArray(a) && Array.isArray(b) && a.length === b.length
        && a.every((value, index) => sameJSON(value, b[index]));
    }
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length
      && keys.every(key => Object.hasOwn(b, key) && sameJSON(a[key], b[key]));
  }
  function berlinToday(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(now);
    const part = type => parts.find(p => p.type === type).value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  }
  function validDate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(s + 'T12:00:00Z');
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }
  const validTime = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
  function parseDate(text) {
    const dates = new Set();
    for (const m of String(text).matchAll(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g)) {
      const value = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      if (validDate(value)) dates.add(value);
    }
    for (const m of String(text).matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) if (validDate(m[1])) dates.add(m[1]);
    return dates.size === 1 ? [...dates][0] : null;
  }
  function parseTime(text) {
    const times = [...String(text).matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)];
    // A start/end range is fine: the first displayed time is the appointment start.
    return times.length ? `${times[0][1].padStart(2, '0')}:${times[0][2]}` : null;
  }
  function choose(slots, config, today = berlinToday()) {
    return slots.filter(s => validDate(s.date) && validTime(s.time)
      && s.date >= today && (!config.from || s.date >= config.from)
      && (!config.until || s.date <= config.until)
      && s.time >= config.after && s.time <= config.before
      && config.weekdays.includes(new Date(s.date + 'T12:00:00Z').getUTCDay())
      && !config.excludedDates.includes(s.date))
      .sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`))[0] || null;
  }
  function validate(config) {
    const errors = [];
    if (config.autoSubmit !== undefined && typeof config.autoSubmit !== 'boolean') errors.push('自动提交设置无效。');
    if (config.alarmDuration !== undefined && ![0, 120].includes(config.alarmDuration)) errors.push('铃声时长应为 2 分钟或手动关闭。');
    if (!config.eligible) errors.push('请先确认适用 RWTH Studenten / SuperC 分类。');
    if (!Number.isInteger(config.interval) || config.interval < 30 || config.interval > 3600) errors.push('检查间隔需为 30–3600 秒。');
    for (const key of ['from', 'until']) if (config[key] && !validDate(config[key])) errors.push('日期格式应为 YYYY-MM-DD。');
    if (config.from && config.until && config.from > config.until) errors.push('起始日期不能晚于最晚日期。');
    if (!validTime(config.after) || !validTime(config.before) || config.after > config.before) errors.push('请填写有效的当天起止时段。');
    if (!Array.isArray(config.weekdays) || !config.weekdays.length || config.weekdays.some(d => !Number.isInteger(d) || d < 0 || d > 6)) errors.push('至少选择一个有效的星期。');
    if (!Array.isArray(config.excludedDates) || config.excludedDates.some(d => !validDate(d))) errors.push('排除日期格式应为 YYYY-MM-DD。');
    if (!config.profile || !config.profile.firstName?.trim() || !config.profile.lastName?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.profile.email || '')) errors.push('请填写姓名和有效邮箱。');
    if (config.profile?.birthDate && !validDate(config.profile.birthDate)) errors.push('出生日期格式不正确。');
    if (!config.extraFields || Array.isArray(config.extraFields) || typeof config.extraFields !== 'object'
        || Object.entries(config.extraFields).some(([k, v]) => !k || typeof v !== 'string')) errors.push('补充字段必须是 {"表单字段名":"填写内容"} 格式。');
    return [...new Set(errors)];
  }
  function fieldKey(meta) {
    const aliases = {
      firstName: ['vorname', 'firstname', 'givenname'],
      lastName: ['familienname', 'nachname', 'lastname', 'surname', 'familyname'],
      email: ['email', 'emailadresse', 'emailaddress', 'emailwiederholung', 'emailrepeat', 'emailconfirmation', 'email2'],
      birthDate: ['geburtsdatum', 'birthdate', 'dateofbirth', 'birthday', 'bday'],
      phone: ['telefon', 'telefonnummer', 'phone', 'phonenumber', 'mobil', 'mobiltelefon'],
      street: ['strasse', 'street'], houseNumber: ['hausnummer', 'housenumber'],
      postalCode: ['postleitzahl', 'plz', 'postalcode', 'zip'], city: ['wohnort', 'stadt', 'city', 'ort']
    };
    const sources = [meta.name, meta.id, meta.label, meta.autocomplete].map(norm);
    // Exact field identifiers first; avoid confusing Vorname with Name or email with username.
    for (const source of sources) {
      for (const [key, names] of Object.entries(aliases)) if (names.includes(source)) return key;
      if (/^(?:email|mail)(?:adresse|address)?(?:wiederholen|bestatigen|wiederholung|repeat|confirmation|confirm|2)$/.test(source)) return 'email';
      if (/^(?:ihr|ihre|your)?vorname$/.test(source)) return 'firstName';
      if (/^(?:ihr|ihre|your)?(?:nachname|familienname)$/.test(source)) return 'lastName';
    }
    if (sources.includes('name')) return 'lastName';
    return null;
  }
  const api = {START, DEFAULTS, norm, sameJSON, berlinToday, validDate, validTime, parseDate, parseTime, choose, validate, fieldKey};
  root.TerminCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
