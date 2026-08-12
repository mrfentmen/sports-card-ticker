'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Sport = require('../ext/ebay.js');

const RESULT = {
  itemSummaries: [
    {
      itemId: '1',
      title: '1986-87 Fleer #57 Michael Jordan Rookie Card PSA 8',
      price: { value: '12450.0', currency: 'USD' },
      condition: { conditionDisplayName: 'Used' },
      image: { imageUrl: 'https://i.ebayimg.com/images/1.jpg' },
      itemWebUrl: 'https://www.ebay.com/itm/1'
    },
    {
      itemId: '2',
      title: '1986 Fleer Michael Jordan Rookie Card Ungraded',
      price: { value: '3200.0', currency: 'USD' },
      condition: { conditionDisplayName: 'Used' }
    },
    {
      itemId: '3',
      title: 'Michael Jordan rookie card lot (no pricing)',
      price: { value: '0', currency: 'USD' }
    },
    {
      itemId: '4',
      title: 'Jordan rookie reprint',
      price: { value: '900.0', currency: 'USD' }
    }
  ]
};

test('searchUrl builds the fixed-price search endpoint', () => {
  const u = Sport.searchUrl('michael jordan rookie card');
  assert.ok(u.startsWith('https://api.ebay.com/buy/browse/v1/item_summary/search?q='));
  assert.ok(u.includes(encodeURIComponent('michael jordan rookie card')));
  assert.ok(u.includes('&limit=40'));
  assert.ok(u.includes('filter=buyingOptions:{FIXED_PRICE}'));
  assert.ok(Sport.searchUrl('x', 5).includes('&limit=5'));
});

test('authHeaders sends Bearer token + marketplace id, none without token', () => {
  const h = Sport.authHeaders('tok-123');
  assert.equal(h.Authorization, 'Bearer tok-123');
  assert.equal(h['X-EBAY-C-MARKETPLACE-ID'], 'EBAY_US');
  assert.ok(h['Api-User-Agent'].includes('SportsTicker'));
  const h0 = Sport.authHeaders('');
  assert.equal(h0.Authorization, undefined);
});

test('parseSearch maps listings and computes the median (skips unpriced)', () => {
  const r = Sport.parseSearch(RESULT);
  assert.equal(r.count, 4);
  assert.equal(r.items.length, 4);
  assert.equal(r.items[0].title, '1986-87 Fleer #57 Michael Jordan Rookie Card PSA 8');
  assert.equal(r.items[0].price, 12450);
  assert.equal(r.items[0].currency, 'USD');
  assert.equal(r.items[0].condition, 'Used');
  assert.equal(r.items[0].url, 'https://www.ebay.com/itm/1');
  // priced values 12450, 3200, 900 -> median 3200 (the 0-value is excluded)
  assert.equal(r.median, 3200);
  assert.equal(Sport.parseSearch(null).count, 0);
  assert.equal(Sport.parseSearch({}).count, 0);
  assert.equal(Sport.parseSearch({ itemSummaries: [] }).median, null);
});

test('median handles odd/even lengths and filters non-positive values', () => {
  assert.equal(Sport.median([3, 1, 2]), 2);
  assert.equal(Sport.median([10, 1, 2, 3]), 2.5);
  assert.equal(Sport.median([0, -5, NaN, 100]), 100);
  assert.equal(Sport.median([]), null);
  assert.equal(Sport.median(null), null);
  assert.equal(Sport.median([0, 0]), null);
});

test('tokenProblem is true only for 401/403', () => {
  assert.equal(Sport.tokenProblem({ status: 401 }), true);
  assert.equal(Sport.tokenProblem({ status: 403 }), true);
  assert.equal(Sport.tokenProblem({ status: 400 }), false);
  assert.equal(Sport.tokenProblem({ status: 500 }), false);
  assert.equal(Sport.tokenProblem(null), false);
  assert.equal(Sport.tokenProblem(new Error('boom')), false);
});

test('formatPrice and formatTrend match the family pattern', () => {
  assert.equal(Sport.formatPrice(3200, 'USD'), '$3,200.00');
  assert.equal(Sport.formatPrice(12450.5), '$12,450.50');
  assert.equal(Sport.formatPrice(null), '—');
  assert.equal(Sport.formatPrice(NaN), '—');
  assert.equal(Sport.formatTrend({ pct: 5.67 }), '+5.7%');
  assert.equal(Sport.formatTrend({ pct: -1.2 }), '-1.2%');
  assert.equal(Sport.formatTrend(null), '');
});

test('historyTrend uses latest vs previous client-side quote', () => {
  const hist = [{ p: 100, t: 1 }, { p: 110, t: 2 }];
  const t = Sport.historyTrend(hist);
  assert.ok(t);
  assert.equal(t.dir, 1);
  assert.ok(Math.abs(t.pct - 10) < 0.01);
  assert.equal(Sport.historyTrend([{ p: 5, t: 1 }]), null);
  assert.equal(Sport.historyTrend(null), null);
});

test('sparkBars normalizes the last n points', () => {
  const bars = Sport.sparkBars([{ p: 50, t: 1 }, { p: 100, t: 2 }, { p: 25, t: 3 }], 8);
  assert.equal(bars.length, 3);
  assert.equal(bars[1], 1); // 100/100
  assert.equal(bars[0], 0.5);
  assert.equal(bars[2], 0.25);
  assert.equal(Sport.sparkBars([], 8).length, 0);
  const capped = Sport.sparkBars([{ p: 1, t: 1 }, { p: 2, t: 2 }, { p: 3, t: 3 }, { p: 4, t: 4 }], 2);
  assert.equal(capped.length, 2);
});

test('ageLabel / offlineMsg / staleLevel match the family pattern', () => {
  const now = Date.now();
  assert.equal(Sport.ageLabel(now - 30_000), 'just now');
  assert.equal(Sport.ageLabel(now - 5 * 60_000), '5m ago');
  assert.equal(Sport.ageLabel(now - 3 * 3600_000), '3h ago');
  assert.equal(Sport.ageLabel(now - 2 * 86400_000), '2d ago');
  assert.equal(Sport.ageLabel(null), '');
  assert.equal(Sport.offlineMsg(null), 'Offline — showing last prices.');
  assert.match(Sport.offlineMsg(now - 120_000), /^Offline — prices from 2m ago$/);
  assert.equal(Sport.staleLevel(now - 30_000), 'stale-fresh');
  assert.equal(Sport.staleLevel(now - 2 * 3600_000), 'stale-warn');
  assert.equal(Sport.staleLevel(now - 2 * 86400_000), 'stale-old');
  assert.equal(Sport.staleLevel(null), '');
});

test('fetchJson retries transient 5xx with growing backoff and sends auth headers', async () => {
  const realFetch = global.fetch;
  let calls = 0;
  let captured = null;
  global.fetch = async (url, opts) => {
    calls++;
    captured = opts;
    if (calls < 3) return { ok: false, status: 503 };
    return { ok: true, json: async () => ({ itemSummaries: [{ title: 't', price: { value: '5', currency: 'USD' } }] }) };
  };
  try {
    const out = await Sport.fetchJson('https://api.ebay.com/test', { token: 'tok-9', tries: 3, backoff: 1 });
    assert.equal(calls, 3);
    assert.equal(out.itemSummaries[0].title, 't');
    assert.equal(captured.headers.Authorization, 'Bearer tok-9');
    assert.equal(captured.headers['X-EBAY-C-MARKETPLACE-ID'], 'EBAY_US');
    assert.ok(captured.signal); // AbortSignal.timeout attached
  } finally {
    global.fetch = realFetch;
  }
});

test('fetchJson does not retry 4xx or 401 (token errors are not transient)', async () => {
  const realFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; return { ok: false, status: 401 }; };
  try {
    await assert.rejects(() => Sport.fetchJson('https://api.ebay.com/test', { token: 'bad', tries: 3, backoff: 1 }));
    assert.equal(calls, 1);
  } finally {
    global.fetch = realFetch;
  }
});
