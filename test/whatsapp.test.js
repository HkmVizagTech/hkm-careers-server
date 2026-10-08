const test = require('node:test');
const assert = require('node:assert/strict');

// ---- stub the Mongoose model so no database is needed ----
const log = [];
let sentToday = 0;
const fakeApplication = {
  aggregate: async () => (sentToday ? [{ n: sentToday }] : []),
  updateOne: async (filter, update) => {
    log.push({ filter, update });
    return {};
  },
};
require.cache[require.resolve('../src/models/Application')] = { exports: fakeApplication };

const { normalizePhone, cleanParam, sendTemplate } = require('../src/utils/gupshup');
const { notifyApplicationReceived, notifyStatusChange, trackUrl, STATUS_COPY } = require('../src/utils/notifications');
const { nextStatus, tokenMatches } = require('../src/controllers/webhookController');

function configure() {
  process.env.GUPSHUP_API_KEY = 'key';
  process.env.GUPSHUP_SOURCE = '+91 99999 00000';
  process.env.GUPSHUP_APP_NAME = 'AppName';
  process.env.GUPSHUP_TPL_RECEIVED = 'tpl-received';
  process.env.GUPSHUP_TPL_STATUS_UPDATE = 'tpl-status';
  process.env.PUBLIC_SITE_URL = 'https://careers.example.org/';
  delete process.env.GUPSHUP_NOTIFY_STATUSES;
}
function mockFetch(handler) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts, body: Object.fromEntries(opts.body) });
    return handler(calls.length);
  };
  return calls;
}
const jsonRes = (status, data) => ({ ok: status < 400, status, text: async () => JSON.stringify(data) });
const app = { _id: 'abc123', name: 'Radha', phone: '98765 43210' };

test('normalizePhone handles common Indian formats', () => {
  assert.equal(normalizePhone('98765 43210'), '919876543210');
  assert.equal(normalizePhone('+91 98765-43210'), '919876543210');
  assert.equal(normalizePhone('09876543210'), '919876543210');
  assert.equal(normalizePhone('0091 9876543210'), '919876543210');
  assert.equal(normalizePhone('+1 415 555 2671'), '14155552671');
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone(''), null);
});

test('cleanParam strips newlines, collapses spaces, never returns empty', () => {
  assert.equal(cleanParam('a\nb\t c    d'), 'a b c d');
  assert.equal(cleanParam('   '), '-');
  assert.ok(cleanParam('x'.repeat(2000)).length <= 900);
});

test('sendTemplate posts the Gupshup form and returns the message id', async () => {
  configure();
  const calls = mockFetch(() => jsonRes(200, { status: 'submitted', messageId: 'gs-1' }));
  const r = await sendTemplate({ to: '919876543210', templateId: 't1', params: ['A', 'B'] });
  assert.deepEqual(r, { ok: true, messageId: 'gs-1' });
  assert.equal(calls[0].opts.headers.apikey, 'key');
  assert.equal(calls[0].body.source, '919999900000');
  assert.equal(calls[0].body.destination, '919876543210');
  assert.equal(calls[0].body['src.name'], 'AppName');
  assert.deepEqual(JSON.parse(calls[0].body.template), { id: 't1', params: ['A', 'B'] });
});

test('sendTemplate reports API errors and network failures without throwing', async () => {
  configure();
  mockFetch(() => jsonRes(400, { status: 'error', message: 'Template Params does not match' }));
  let r = await sendTemplate({ to: '919876543210', templateId: 't1', params: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /Template Params/);

  global.fetch = async () => { throw new Error('ECONNRESET'); };
  r = await sendTemplate({ to: '919876543210', templateId: 't1', params: [] });
  assert.deepEqual(r, { ok: false, error: 'ECONNRESET' });
});

test('received notification uses the received template and is logged', async () => {
  configure(); log.length = 0; sentToday = 0;
  const calls = mockFetch(() => jsonRes(200, { status: 'submitted', messageId: 'gs-2' }));
  const entry = await notifyApplicationReceived(app, { title: 'Web Developer' });
  assert.equal(entry.status, 'submitted');
  assert.equal(entry.messageId, 'gs-2');
  const tpl = JSON.parse(calls[0].body.template);
  assert.equal(tpl.id, 'tpl-received');
  // body {{1}}-{{3}}, then the button URL variable last
  assert.deepEqual(tpl.params, ['Radha', 'Web Developer', 'abc123', 'abc123']);
  assert.equal(calls[0].body.message, undefined);
  assert.equal(log[0].update.$push.whatsappMessages.messageId, 'gs-2');
});

test('status change uses the status template with label + message', async () => {
  configure(); log.length = 0; sentToday = 0;
  const calls = mockFetch(() => jsonRes(200, { status: 'submitted', messageId: 'gs-3' }));
  await notifyStatusChange(app, { title: 'Web Developer' }, 'rejected');
  const tpl = JSON.parse(calls[0].body.template);
  assert.equal(tpl.id, 'tpl-status');
  assert.equal(tpl.params[2], 'Not Selected');
  assert.deepEqual(tpl.params, ['Radha', 'Web Developer', 'Not Selected', STATUS_COPY.rejected.message, 'abc123']);
  assert.match(STATUS_COPY.interview.message, /HR will get back to you with further details/);
});

test('"received" is not auto-sent as a status change unless forced', async () => {
  configure();
  const calls = mockFetch(() => jsonRes(200, { status: 'submitted', messageId: 'x' }));
  assert.equal(await notifyStatusChange(app, null, 'received'), null);
  assert.equal(calls.length, 0);
  const forced = await notifyStatusChange(app, null, 'received', { force: true });
  assert.equal(JSON.parse(calls[0].body.template).id, 'tpl-received');
  assert.equal(forced.kind, 'received');
});

test('GUPSHUP_NOTIFY_STATUSES limits which statuses send', async () => {
  configure();
  process.env.GUPSHUP_NOTIFY_STATUSES = 'selected,rejected';
  const calls = mockFetch(() => jsonRes(200, { status: 'submitted', messageId: 'x' }));
  assert.equal(await notifyStatusChange(app, null, 'shortlisted'), null);
  assert.equal(calls.length, 0);
  assert.ok(await notifyStatusChange(app, null, 'selected'));
  delete process.env.GUPSHUP_NOTIFY_STATUSES;
});

test('failures are logged as failed; unconfigured/invalid/over-limit are logged as skipped', async () => {
  configure(); log.length = 0; sentToday = 0;
  mockFetch(() => jsonRes(500, { status: 'error', message: 'boom' }));
  assert.equal((await notifyApplicationReceived(app, null)).status, 'failed');

  const bad = await notifyApplicationReceived({ ...app, phone: '123' }, null);
  assert.equal(bad.status, 'skipped');
  assert.match(bad.error, /valid WhatsApp/);

  sentToday = 99;
  const capped = await notifyApplicationReceived(app, null);
  assert.equal(capped.status, 'skipped');
  assert.match(capped.error, /limit/);
  sentToday = 0;

  delete process.env.GUPSHUP_API_KEY;
  const off = await notifyApplicationReceived(app, null);
  assert.equal(off.status, 'skipped');
  assert.match(off.error, /not configured/);
});

test('trackUrl falls back to CLIENT_URL', () => {
  delete process.env.PUBLIC_SITE_URL;
  process.env.CLIENT_URL = 'http://localhost:3000,https://other';
  assert.equal(trackUrl('id1'), 'http://localhost:3000/track?id=id1');
});

test('webhook status only moves forward', () => {
  assert.equal(nextStatus('submitted', 'sent'), 'sent');
  assert.equal(nextStatus('sent', 'delivered'), 'delivered');
  assert.equal(nextStatus('delivered', 'read'), 'read');
  assert.equal(nextStatus('read', 'delivered'), null);   // out-of-order
  assert.equal(nextStatus('delivered', 'sent'), null);
  assert.equal(nextStatus('submitted', 'failed'), 'failed');
  assert.equal(nextStatus('delivered', 'failed'), null);
  assert.equal(nextStatus('failed', 'delivered'), null);
  assert.equal(nextStatus('submitted', 'enqueued'), null);
  assert.equal(nextStatus('submitted', 'unknown'), null);
});

test('webhook token check is strict', () => {
  process.env.GUPSHUP_WEBHOOK_KEY = 's3cret';
  assert.equal(tokenMatches('s3cret'), true);
  assert.equal(tokenMatches('s3cre'), false);
  assert.equal(tokenMatches(undefined), false);
  delete process.env.GUPSHUP_WEBHOOK_KEY;
  assert.equal(tokenMatches('anything'), false);
});
