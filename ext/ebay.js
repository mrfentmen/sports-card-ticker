'use strict';
/*
 * Pure helpers for SportsTicker. No DOM, no chrome.* calls — the same module
 * runs in the extension (browser) and in the Node unit tests.
 *
 * Data comes from eBay's Browse API (api.ebay.com/buy/browse/v1), which
 * requires a free developer access token: create an app at developer.ebay.com,
 * then copy an access token from the OAuth token generator and paste it into
 * the popup's ⚙ settings (tokens expire after ~2 hours — re-paste anytime).
 *
 * eBay has no canonical card database, so a watched "card" IS a search query
 * (e.g. "michael jordan rookie card 1986 fleer"). The ticker price for the
 * entry is the MEDIAN of the active fixed-price listings eBay returns, and
 * trend arrows / sparklines come from the client-side history popup.js keeps.
 */
(function (root) {
  var API = 'https://api.ebay.com/buy/browse/v1';
  var UA = 'SportsTicker/1.0 (https://github.com/mrfentmen/sports-card-ticker; contactae2000@gmail.com)';

  function searchUrl(query, limit) {
    return API + '/item_summary/search?q=' + encodeURIComponent(query) +
      '&limit=' + (limit || 40) +
      '&filter=buyingOptions:{FIXED_PRICE}';
  }

  function authHeaders(token) {
    var h = {
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      'Api-User-Agent': UA
    };
    if (token) h.Authorization = 'Bearer ' + token;
    return h;
  }

  // Median of the positive, finite prices (null when there is none).
  function median(nums) {
    var a = (nums || []).filter(function (n) {
      return typeof n === 'number' && isFinite(n) && n > 0;
    }).sort(function (x, y) { return x - y; });
    if (!a.length) return null;
    var mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  // Parse the search endpoint into listing summaries + the market median.
  function parseSearch(json) {
    if (!json || !Array.isArray(json.itemSummaries)) {
      return { items: [], median: null, count: 0 };
    }
    var items = json.itemSummaries.map(function (s) {
      var n = parseFloat(s.price && s.price.value);
      return {
        itemId: s.itemId || '',
        title: s.title || '',
        image: (s.image && s.image.imageUrl) || '',
        price: isNaN(n) ? null : n,
        currency: (s.price && s.price.currency) || 'USD',
        condition: (s.condition && s.condition.conditionDisplayName) || '',
        url: s.itemWebUrl || ''
      };
    }).filter(function (it) { return it.title; });
    return {
      items: items,
      median: median(items.map(function (it) { return it.price; })),
      count: items.length
    };
  }

  // A 401/403 from eBay means the token is missing, invalid, or expired —
  // the fix is in ⚙ settings, not another retry.
  function tokenProblem(err) {
    return !!err && (err.status === 401 || err.status === 403);
  }

  function formatPrice(n, currency) {
    if (n == null || isNaN(n)) return '—';
    var sym = currency === 'EUR' ? '€' : '$';
    return sym + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatTrend(trend) {
    if (!trend) return '';
    var sign = trend.pct >= 0 ? '+' : '';
    return sign + trend.pct.toFixed(1) + '%';
  }

  // Client-side price history trend: latest vs previous quote (latest last).
  function historyTrend(hist) {
    if (!Array.isArray(hist) || hist.length < 2) return null;
    var last = hist[hist.length - 1];
    var prev = hist[hist.length - 2];
    if (!last || !prev || !(prev.p > 0) || last.p == null) return null;
    var pct = ((last.p - prev.p) / prev.p) * 100;
    return { pct: pct, dir: pct >= 0 ? 1 : -1 };
  }

  // Normalized heights (0..1) for the last `n` history points — the sparkline.
  function sparkBars(hist, n) {
    n = n || 8;
    if (!Array.isArray(hist) || !hist.length) return [];
    var pts = hist.slice(-n).map(function (h) { return h.p; });
    var max = Math.max.apply(null, pts);
    if (!(max > 0)) return pts.map(function () { return 0; });
    return pts.map(function (p) { return Math.max(0.04, p / max); });
  }

  // Relative age for "prices from X ago" (ms timestamps).
  function ageLabel(ts) {
    if (!ts) return '';
    var s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return 'just now';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  // Offline status message for cached prices, with their age.
  function offlineMsg(ts) {
    var age = ageLabel(ts);
    return age ? 'Offline — prices from ' + age : 'Offline — showing last prices.';
  }

  // Staleness class for the offline status: green < 1h, amber 1-24h, red 24h+.
  function staleLevel(ts) {
    if (!ts) return '';
    var h = (Date.now() - ts) / 3600000;
    if (h < 1) return 'stale-fresh';
    if (h < 24) return 'stale-warn';
    return 'stale-old';
  }

  // Timeout + quiet retries with a growing backoff (the family resilience
  // pattern): retries only network errors and 5xx/429, never 4xx — and never
  // a 401/403, because a rejected token will not heal itself. The wait before
  // each retry is backoff * attempt-number (800ms, 1600ms, …).
  function fetchJson(url, opts) {
    opts = opts || {};
    var tries = opts.tries != null ? opts.tries : 2;
    var ms = opts.ms || 12000;
    var backoff = opts.backoff || 800;
    var hdrs = authHeaders(opts.token);
    function attempt(left) {
      return fetch(url, {
        headers: hdrs,
        signal: AbortSignal.timeout(ms)
      })
        .then(function (r) {
          if (!r.ok) {
            var e = new Error('HTTP ' + r.status);
            e.status = r.status;
            throw e;
          }
          return r.json();
        })
        .catch(function (err) {
          var retryable = !err.status || err.status === 429 || err.status >= 500;
          if (retryable && left > 1) {
            var wait = backoff * (tries - left + 1);
            return new Promise(function (resolve) { setTimeout(resolve, wait); })
              .then(function () { return attempt(left - 1); });
          }
          throw err;
        });
    }
    return attempt(tries);
  }

  var api = {
    searchUrl: searchUrl,
    authHeaders: authHeaders,
    median: median,
    parseSearch: parseSearch,
    tokenProblem: tokenProblem,
    formatPrice: formatPrice,
    formatTrend: formatTrend,
    historyTrend: historyTrend,
    sparkBars: sparkBars,
    ageLabel: ageLabel,
    offlineMsg: offlineMsg,
    staleLevel: staleLevel,
    fetchJson: fetchJson,
    UA: UA
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.Sport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
