const {test} = require('node:test');
const assert = require('node:assert/strict');
const C = require('../extension/core.js');
const config = () => ({...structuredClone(C.DEFAULTS), eligible: true, profile: {...C.DEFAULTS.profile, firstName: 'Test', lastName: 'User', email: 'test@example.org'}});
test('storage readback ignores nested object key order but detects content changes', () => {
  const before = {profile: {firstName: 'Test', email: 'test@example.org'}, weekdays: [1, 2, 3], extraFields: {b: '2', a: '1'}};
  const after = {extraFields: {a: '1', b: '2'}, weekdays: [1, 2, 3], profile: {email: 'test@example.org', firstName: 'Test'}};
  assert.notEqual(JSON.stringify(before), JSON.stringify(after));
  assert.equal(C.sameJSON(before, after), true);
  assert.equal(C.sameJSON(before, {...after, weekdays: [3, 2, 1]}), false);
  assert.equal(C.sameJSON(before, {...after, profile: {...after.profile, firstName: 'Other'}}), false);
  assert.equal(C.sameJSON(before, {...after, extra: 'unexpected'}), false);
  assert.equal(C.sameJSON(before, undefined), false);
  assert.equal(C.sameJSON({value: null}, {value: ''}), false);
});
test('German dates reject invalid and ambiguous values', () => {
  assert.equal(C.parseDate('Montag, 02.11.2026'), '2026-11-02');
  assert.equal(C.parseDate('31.02.2026'), null);
  assert.equal(C.parseDate('02.11.2026 03.11.2026'), null);
  assert.equal(C.parseDate('2026-11-02'), '2026-11-02');
  assert.equal(C.parseTime('8:05 - 8:25 Uhr'), '08:05');
});
test('earliest is by date then time, not DOM order', () => {
  const slots = [{date: '2026-11-04', time: '08:00'}, {date: '2026-11-02', time: '10:00'}, {date: '2026-11-02', time: '08:00'}];
  assert.deepEqual(C.choose(slots, config(), '2026-10-30'), slots[2]);
});
test('date bounds, weekday, exclusions and time bounds apply together', () => {
  const cfg = {...config(), from: '2026-11-02', until: '2026-11-04', after: '09:00', before: '12:00', excludedDates: ['2026-11-03']};
  const slots = [{date: '2026-10-30', time: '10:00'}, {date: '2026-11-02', time: '08:00'}, {date: '2026-11-03', time: '10:00'}, {date: '2026-11-04', time: '10:00'}, {date: '2026-11-07', time: '10:00'}];
  assert.deepEqual(C.choose(slots, cfg, '2026-10-30'), slots[3]);
  assert.equal(C.choose([{date: '2026-11-01', time: '10:00'}], config(), '2026-10-30'), null);
});
test('Berlin calendar date is independent of the host timezone and DST', () => {
  assert.equal(C.berlinToday(new Date('2026-06-01T22:30:00Z')), '2026-06-02');
  assert.equal(C.berlinToday(new Date('2026-10-30T23:30:00Z')), '2026-10-31');
});
test('field matching does not confuse surname, first name, username and email', () => {
  assert.equal(C.fieldKey({name: 'vorname', label: 'Name'}), 'firstName');
  assert.equal(C.fieldKey({name: 'username'}), null);
  assert.equal(C.fieldKey({label: 'E-Mail-Adresse (Wiederholung)'}), 'email');
  assert.equal(C.fieldKey({label: 'Nachname *'}), 'lastName');
  assert.equal(C.fieldKey({label: 'Geburtsdatum'}), 'birthDate');
});
test('incomplete identity, aggressive interval and malformed exclusions cannot start', () => {
  assert.equal(C.validate(config()).length, 0);
  assert.ok(C.validate({...config(), interval: 2}).length);
  assert.ok(C.validate({...config(), weekdays: []}).length);
  assert.ok(C.validate({...config(), eligible: false}).length);
  assert.ok(C.validate({...config(), excludedDates: ['not-a-date']}).length);
  assert.ok(C.validate({...config(), extraFields: {secret: true}}).length);
  assert.ok(C.validate(C.DEFAULTS).length);
});
