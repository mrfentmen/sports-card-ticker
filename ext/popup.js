'use strict';
/* global Sport, chrome */

(function () {
  var REFRESH_MS = 60 * 1000; // auto-refresh prices while the popup is open
  var HIST_MAX = 40;          // client-side price history points per entry

  var state = {
    watch: [],   // {id (query key), name (listing title), query, image, price (median), count, currency, trend, hist:[{p,t}], ts}
    token: ''    // eBay access token, stored via chrome.storage.local
  };

  var els = {
    mainView: document.getElementById('mainView'),
    setupView: document.getElementById('setupView'),
    settings: document.getElementById('settings'),
    setupClose: document.getElementById('setup-close'),
    token: document.getElementById('token'),
    testToken: document.getElementById('test-token'),
    saveToken: document.getElementById('save-token'),
    tokenStatus: document.getElementById('token-status'),
    search: document.getElementById('search'),
    go: document.getElementById('go'),
    results: document.getElementById('results'),
    list: document.getElementById('list'),
    empty: document.getElementById('empty'),
    status: document.getElementById('status'),
    refresh: document.getElementById('refresh'),
    tapeWrap: document.getElementById('tape-wrap'),
    tape: document.getElementById('tape'),
    clearAll: document.getElementById('clear-all'),
    zoomToast: document.getElementById('zoom-toast'),
    retry: document.getElementById('retry'),
    alertLogBtn: document.getElementById('alertLogBtn'),
    alertLogPanel: document.getElementById('alertLogPanel'),
    portfolio: document.getElementById('portfolio'),
    sortBy: document.getElementById('sortBy'),
    exportCsv: document.getElementById('exportCsv'),
    copyClip: document.getElementById('copyClip'),
    compactToggle: document.getElementById('compactToggle'),
    themeToggle: document.getElementById('themeToggle'),
    ctxMenu: document.getElementById('ctxMenu')
  };

  var ctxTarget = null;

  var dragIdx = -1;
  var compact = false;

  var chimeCtx = null;
  function chime() {
    try {
      if (!chimeCtx) chimeCtx = new (window.AudioContext || window.webkitAudioContext)();
      var o = chimeCtx.createOscillator();
      var g = chimeCtx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(880, chimeCtx.currentTime);
      o.frequency.setValueAtTime(1100, chimeCtx.currentTime + 0.08);
      g.gain.setValueAtTime(0.12, chimeCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, chimeCtx.currentTime + 0.3);
      o.connect(g); g.connect(chimeCtx.destination);
      o.start(chimeCtx.currentTime); o.stop(chimeCtx.currentTime + 0.3);
    } catch (_) { /* audio not available */ }
  }

  var hintTimer = null;
  var pageZoom = 1;
  var debounce = null;
  var searchId = 0;
  var refreshId = 0;

  function setStatus(msg, isError) {
    if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; }
    els.status.textContent = msg || '';
    els.status.classList.toggle('error', !!isError);
    els.status.classList.remove('stale-fresh', 'stale-warn', 'stale-old');
    els.retry.hidden = true;
  }

  function setStale(ts) {
    var lv = Sport.staleLevel(ts);
    if (lv) els.status.classList.add(lv);
    if (lv) els.retry.hidden = false;
  }

  function flashAlert(entry, dir) {
    if (!Array.isArray(entry.alertLog)) entry.alertLog = [];
    var threshold = dir === 'above' ? entry.alertAbove : entry.alertBelow;
    var verb = dir === 'above' ? 'hit' : 'dropped below';
    // percentage alert fallback
    if (threshold == null && entry.alertPct) { threshold = entry.alertPct; verb = 'moved ±' + entry.alertPct + '% from'; }
    entry.alertLog.push({ ts: Date.now(), dir: dir, threshold: threshold, price: entry.price, name: entry.name });
    if (entry.alertLog.length > 50) entry.alertLog = entry.alertLog.slice(-50);
    save();
    renderAlertLog();
    if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; }
    var thStr = entry.alertPct && threshold === entry.alertPct ? '±' + threshold + '%' : '$' + threshold.toLocaleString();
    els.status.textContent = '🔔 ' + entry.name + ' ' + verb + ' ' + thStr + ' — now ' + Sport.formatPrice(entry.price) + '!';
    els.status.classList.remove('error', 'stale-fresh', 'stale-warn', 'stale-old');
    els.status.classList.add('alert');
    els.retry.hidden = true;
    hintTimer = setTimeout(function () {
      els.status.classList.remove('alert');
      els.status.textContent = '';
    }, 5000);
  }

  function setTokenStatus(msg, isError) {
    els.tokenStatus.textContent = msg || '';
    els.tokenStatus.classList.toggle('error', !!isError);
  }

  // ---------- persistence ----------
  function save() {
    chrome.storage.local.set({ sptWatchlist: state.watch });
  }

  function load(cb) {
    chrome.storage.local.get(['sptWatchlist', 'sptToken'], function (d) {
      state.token = (d && typeof d.sptToken === 'string') ? d.sptToken : '';
      var w = d && d.sptWatchlist;
      if (Array.isArray(w)) {
        state.watch = w.filter(function (c) { return c && c.id && c.query && c.name; }).map(function (c) {
          if (!Array.isArray(c.hist)) c.hist = [];
          c.hist = c.hist.filter(function (h) { return h && typeof h.p === 'number' && typeof h.t === 'number'; });
          if (!Array.isArray(c.daily)) c.daily = [];
          if (!Array.isArray(c.alertLog)) c.alertLog = [];
          else c.alertLog = c.alertLog.filter(function (a) { return a && typeof a.ts === 'number' && typeof a.price === 'number'; }).slice(-50);
          return c;
        });
      }
      if (cb) cb();
    });
  }

  // ---------- token setup view ----------
  function openSettings() {
    els.mainView.hidden = true;
    els.setupView.hidden = false;
    els.token.value = state.token;
    setTokenStatus('');
    els.token.focus();
  }

  function closeSettings() {
    els.setupView.hidden = true;
    els.mainView.hidden = false;
    setStatus('');
  }

  function saveToken() {
    var t = els.token.value.trim();
    if (!t) {
      setTokenStatus('Paste your token first.', true);
      return;
    }
    state.token = t;
    chrome.storage.local.set({ sptToken: t }, function () {
      closeSettings();
      setStatus('Token saved.');
      if (state.watch.length) refreshAll();
    });
  }

  function testToken() {
    var t = els.token.value.trim();
    if (!t) {
      setTokenStatus('Paste your token first.', true);
      return;
    }
    setTokenStatus('Checking with eBay…');
    // The token only lives in this request — nothing is stored until Save.
    // Shorter timeout: this is a quick auth probe, not a full feed fetch.
    Sport.fetchJson(Sport.searchUrl('lebron james card', 5), { token: t, tries: 2, backoff: 400, ms: 8000 })
      .then(function (json) {
        var r = Sport.parseSearch(json);
        setTokenStatus('✓ Token works — eBay returned ' + r.count + ' listings.');
      })
      .catch(function (err) {
        if (Sport.tokenProblem(err)) {
          setTokenStatus('Token rejected (' + err.status + ') — make sure it is the access token, not your client secret.', true);
        } else {
          setTokenStatus('Could not reach eBay — check your connection and try again.', true);
        }
      });
  }

  els.settings.addEventListener('click', openSettings);
  els.setupClose.addEventListener('click', closeSettings);
  els.saveToken.addEventListener('click', saveToken);
  els.testToken.addEventListener('click', testToken);
  els.token.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') saveToken();
  });

  // ---------- search ----------
  function doSearch(query) {
    var q = query.trim();
    if (q.length < 2) {
      els.results.hidden = true;
      return;
    }
    var myId = ++searchId;
    els.results.innerHTML = '<div class="res-note">Searching eBay…</div>';
    els.results.hidden = false;
    // Three tries with a growing backoff: the feed can flap. A rejected
    // token is never retried — it needs the ⚙ settings, not a retry.
    Sport.fetchJson(Sport.searchUrl(q, 40), { token: state.token, tries: 3, backoff: 700 })
      .then(function (json) {
        if (myId !== searchId) return;
        renderResults(Sport.parseSearch(json), q);
      })
      .catch(function (err) {
        if (myId !== searchId) return;
        if (Sport.tokenProblem(err)) {
          els.results.innerHTML = '<div class="res-note">eBay rejected your token — open ⚙ settings to fix it.</div>';
        } else {
          var feedProblem = !err || !err.status || err.status === 429 || err.status >= 500;
          els.results.innerHTML = feedProblem
            ? '<div class="res-note">eBay is hiccuping — try again in a moment.</div>'
            : '<div class="res-note">No luck — check the search and try again.</div>';
        }
      });
  }

  function renderResults(parsed, q) {
    els.results.innerHTML = '';
    if (!parsed.count) {
      els.results.innerHTML = '<div class="res-note">No listings found for "' + esc(q) + '".</div>';
      return;
    }
    var firstImage = parsed.items[0].image || '';
    var firstTitle = parsed.items[0].title || '';
    // Median header row: one click tracks the whole query.
    if (parsed.median != null) {
      var head = document.createElement('button');
      head.type = 'button';
      head.className = 'res-head';
      head.title = 'Track "' + q + '" — median of ' + parsed.count + ' fixed-price listings';
      var hb = document.createElement('span');
      hb.className = 'res-head-median';
      hb.textContent = 'Median ' + Sport.formatPrice(parsed.median);
      var hc = document.createElement('span');
      hc.className = 'res-head-count';
      hc.textContent = parsed.count + ' listings';
      var ha = document.createElement('span');
      ha.className = 'res-head-add';
      ha.textContent = 'Track →';
      head.appendChild(hb);
      head.appendChild(hc);
      head.appendChild(ha);
      head.addEventListener('click', function () {
        addEntry(q, firstTitle, parsed.median, firstImage);
        els.results.hidden = true;
        els.search.value = '';
      });
      els.results.appendChild(head);
    }
    // A few representative listings below.
    parsed.items.slice(0, 6).forEach(function (it) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'res-row';
      var thumb = document.createElement('img');
      thumb.className = 'res-thumb';
      thumb.alt = '';
      thumb.src = it.image;
      thumb.addEventListener('error', function () { thumb.remove(); });
      var body = document.createElement('span');
      body.className = 'res-body';
      var name = document.createElement('span');
      name.className = 'res-name';
      name.textContent = it.title;
      var set = document.createElement('span');
      set.className = 'res-set';
      set.textContent = it.condition || '';
      body.appendChild(name);
      body.appendChild(set);
      var price = document.createElement('span');
      price.className = 'res-price';
      price.textContent = it.price != null ? Sport.formatPrice(it.price, it.currency) : '—';
      row.appendChild(thumb);
      row.appendChild(body);
      row.appendChild(price);
      row.addEventListener('click', function () {
        addEntry(q, it.title, parsed.median, it.image);
        els.results.hidden = true;
        els.search.value = '';
      });
      els.results.appendChild(row);
    });
  }

  els.search.addEventListener('input', function () {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(function () { doSearch(els.search.value); }, 250);
  });
  els.search.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { doSearch(els.search.value); }
    if (ev.key === 'Escape') { els.results.hidden = true; }
  });
  els.go.addEventListener('click', function () { doSearch(els.search.value); });
  document.addEventListener('click', function (ev) {
    if (!ev.target.closest('.search-wrap')) els.results.hidden = true;
  });

  // ---------- watchlist ----------
  function addEntry(q, name, price, image) {
    var id = q.toLowerCase();
    var existing = state.watch.some(function (w) { return w.id === id; });
    if (existing) {
      setStatus('Already on your ticker.');
      return;
    }
    state.watch.unshift({
      id: id, name: name, query: q, image: image,
      price: price, count: 0, currency: 'USD', trend: null,
      hist: price != null ? [{ p: price, t: Date.now() }] : [],
      // ts seeded from the search result: the median shown is real and fresh,
      // so a failed refresh degrades to the staleness path, not a red error.
      ts: Date.now()
    });
    save();
    render();
    refreshEntry(state.watch[0]);
  }

  function removeCard(id) {
    state.watch = state.watch.filter(function (w) { return w.id !== id; });
    save();
    render();
  }

  // Refresh one entry: re-run its query, recompute the median, record history.
  function refreshEntry(entry) {
    var myId = ++refreshId;
    Sport.fetchJson(Sport.searchUrl(entry.query, 40), { token: state.token, tries: 3, backoff: 700 })
      .then(function (json) {
        if (myId !== refreshId) return;
        var r = Sport.parseSearch(json);
        if (!r.count) throw new Error('empty result');
        applyQuote(entry.id, r);
        setStatus('');
      })
      .catch(function () {
        if (myId !== refreshId) return;
        // keep the cached median; say so honestly
        if (entry.ts) {
          setStatus(Sport.offlineMsg(entry.ts));
          setStale(entry.ts);
        } else {
          setStatus('Could not fetch prices for ' + entry.name + '.', true);
        }
      });
  }

  function refreshAll() {
    if (!state.watch.length) return;
    var myId = ++refreshId;
    els.refresh.classList.add('spinning');
    var pending = state.watch.length;
    var succeeded = 0;
    var tokenBad = false;
    state.watch.forEach(function (entry) {
      Sport.fetchJson(Sport.searchUrl(entry.query, 40), { token: state.token, tries: 3, backoff: 700 })
        .then(function (json) {
          if (myId !== refreshId) return;
          var r = Sport.parseSearch(json);
          if (r.count) { applyQuote(entry.id, r); succeeded++; }
        })
        .catch(function (err) {
          if (Sport.tokenProblem(err)) tokenBad = true;
        })
        .finally(function () {
          if (myId !== refreshId) return;
          pending--;
          if (pending > 0) return;
          els.refresh.classList.remove('spinning');
          if (succeeded > 0) {
            setStatus('');
          } else if (tokenBad) {
            setStatus('eBay rejected your token — open ⚙ settings to fix it.', true);
          } else {
            // everything failed: fall back to cached medians with their age
            var oldest = null;
            state.watch.forEach(function (w) {
              if (w.ts && (oldest === null || w.ts < oldest)) oldest = w.ts;
            });
            if (oldest) {
              setStatus(Sport.offlineMsg(oldest));
              setStale(oldest);
            } else {
              setStatus('Could not reach eBay. Check your connection.', true);
            }
          }
        });
    });
  }

  function applyQuote(id, r) {
    var entry = state.watch.find(function (w) { return w.id === id; });
    if (!entry) return;
    entry.count = r.count;
    if (r.items.length && r.items[0].image) entry.image = r.items[0].image;
    if (r.median != null) {
      // Only a real median advances the price, the history, and the freshness
      // clock — a refresh with no priced listings keeps the last good price
      // and its honest staleness instead of flipping the row to "—".
      var crossedAbove = entry.alertAbove != null && entry.price != null &&
        entry.price < entry.alertAbove && r.median >= entry.alertAbove;
      var crossedBelow = entry.alertBelow != null && entry.price != null &&
        entry.price > entry.alertBelow && r.median <= entry.alertBelow;
      entry.price = r.median;
      entry.hist.push({ p: r.median, t: Date.now() });
      if (entry.hist.length > HIST_MAX) entry.hist = entry.hist.slice(-HIST_MAX);
      entry.trend = Sport.historyTrend(entry.hist);
      entry.ts = Date.now();
      if (crossedAbove) { flashAlert(entry, 'above'); chime(); updateBadge(); }
      if (crossedBelow) { flashAlert(entry, 'below'); chime(); updateBadge(); }
      // percentage-based alert crossing
      if (entry.alertPct && entry.alertPctBase != null && entry.price != null) {
        var pctChange = Math.abs(r.median - entry.alertPctBase) / entry.alertPctBase * 100;
        var prevPct = Math.abs(entry.price - entry.alertPctBase) / entry.alertPctBase * 100;
        if (prevPct < entry.alertPct && pctChange >= entry.alertPct) {
          flashAlert(entry, r.median >= entry.alertPctBase ? 'above' : 'below'); chime();
        }
      }
      // daily price snapshot (30-day sparkline — update today's entry or push a new day)
      if (!entry.daily) entry.daily = [];
      var today = new Date().toISOString().slice(0, 10);
      var last = entry.daily.length ? entry.daily[entry.daily.length - 1] : null;
      if (last && last.d === today) { last.p = r.median; }
      else { entry.daily.push({ d: today, p: r.median }); if (entry.daily.length > 30) entry.daily = entry.daily.slice(-30); }
    }
    save();
    render();
  }

  // ---------- rendering ----------
  function render() {
    els.empty.hidden = state.watch.length > 0;
    els.tapeWrap.hidden = state.watch.length === 0;
    els.clearAll.hidden = state.watch.length === 0;
    els.exportCsv.hidden = state.watch.length === 0;
    els.copyClip.hidden = state.watch.length === 0;
    renderTape();
    // portfolio total
    var sum = 0; var priced = 0;
    state.watch.forEach(function (w) { if (w.price != null) { sum += w.price; priced++; } });
    els.portfolio.textContent = priced ? 'Total: $' + sum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' (' + priced + ' cards)' : '';
    // sort — favorites always on top, then sort within each group
    var sort = els.sortBy.value;
    var sorted = state.watch.slice();
    sorted.sort(function (a, b) { return (b.fav ? 1 : 0) - (a.fav ? 1 : 0); });
    var favs = sorted.filter(function (w) { return w.fav; });
    var rest = sorted.filter(function (w) { return !w.fav; });
    if (sort === 'name') rest.sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
    else if (sort === 'price-desc') rest.sort(function (a, b) { return (b.price || 0) - (a.price || 0); });
    else if (sort === 'price-asc') rest.sort(function (a, b) { return (a.price || 0) - (b.price || 0); });
    else if (sort === 'trend-desc') rest.sort(function (a, b) { var ta = a.trend ? a.trend.pct : 0; var tb = b.trend ? b.trend.pct : 0; return tb - ta; });
    else if (sort === 'trend-asc') rest.sort(function (a, b) { var ta = a.trend ? a.trend.pct : 0; var tb = b.trend ? b.trend.pct : 0; return ta - tb; });
    sorted = favs.concat(rest);
    els.list.innerHTML = '';
    sorted.forEach(function (w) {
      els.list.appendChild(rowFor(w));
    });
  }

  function rowFor(w) {
    var row = document.createElement('article');
    row.className = 'card-row';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.title = 'Open this search on eBay';

    var thumb = document.createElement('img');
    thumb.className = 'card-thumb';
    thumb.alt = '';
    thumb.loading = 'lazy';
    thumb.src = w.image;
    thumb.addEventListener('error', function () {
      thumb.remove();
      row.insertBefore(thumbPlaceholder(), row.querySelector('.card-info') || row.firstChild);
    });

    var info = document.createElement('div');
    info.className = 'card-info';
    var name = document.createElement('div');
    name.className = 'card-name';
    name.textContent = w.name;
    var set = document.createElement('div');
    set.className = 'card-set';
    set.textContent = '“' + w.query + '” · ' + (w.count ? w.count + ' listings' : 'eBay');
    info.appendChild(name);
    info.appendChild(set);

    var quote = document.createElement('div');
    quote.className = 'card-quote';
    var price = document.createElement('div');
    price.className = 'card-price';
    price.textContent = Sport.formatPrice(w.price);
    if (w.count) {
      var v = document.createElement('span');
      v.className = 'card-variant';
      v.textContent = w.count + ' LISTINGS';
      price.appendChild(v);
    }
    var trend = document.createElement('div');
    trend.className = 'card-trend' + (w.trend ? (w.trend.dir === 1 ? ' up' : ' down') : ' flat');
    trend.textContent = w.trend ? '▲ ' + Sport.formatTrend(w.trend) : '—';
    quote.appendChild(price);
    quote.appendChild(trend);

    // ---- 24h change ----
    var dayChg = dayChange(w);
    if (dayChg != null) {
      var chg = document.createElement('div');
      chg.className = 'card-daychg' + (dayChg > 0 ? ' up' : dayChg < 0 ? ' down' : '');
      chg.textContent = (dayChg >= 0 ? '+' : '') + Sport.formatPrice(dayChg) + ' 24h';
      quote.appendChild(chg);
    }

    // ---- ATH / ATL ----
    var ath = allTimeHigh(w);
    var atl = allTimeLow(w);
    if (ath != null && atl != null) {
      var range = document.createElement('div');
      range.className = 'card-range';
      range.textContent = 'H ' + Sport.formatPrice(ath) + '  L ' + Sport.formatPrice(atl);
      quote.appendChild(range);
    }

    // ---- price position bar ----
    if (ath != null && atl != null && ath !== atl && w.price != null) {
      var pct = Math.max(0, Math.min(100, (w.price - atl) / (ath - atl) * 100));
      var posBar = document.createElement('div');
      posBar.className = 'card-posbar';
      var fill = document.createElement('div');
      fill.className = 'card-posfill';
      fill.style.width = pct + '%';
      posBar.appendChild(fill);
      quote.appendChild(posBar);
    }

    var bars = document.createElement('div');
    bars.className = 'card-bars';
    bars.title = '30-day price sparkline';
    var heights = Sport.sparkBars(w.daily, 30);
    if (heights.length) {
      heights.forEach(function (v) {
        var b = document.createElement('span');
        b.className = 'bar';
        b.style.height = Math.round(v * 16) + 'px';
        bars.appendChild(b);
      });
    } else {
      bars.title = '';
    }

    var x = document.createElement('button');
    x.className = 'row-x';
    x.type = 'button';
    x.title = 'Remove from ticker';
    x.setAttribute('aria-label', 'Remove ' + w.name + ' from ticker');
    x.textContent = '✕';
    x.addEventListener('click', function (ev) {
      ev.stopPropagation();
      removeCard(w.id);
    });

    // ---- drag handle ----
    var grip = document.createElement('span');
    grip.className = 'drag-grip';
    grip.textContent = '⋮⋮';
    grip.title = 'Drag to reorder';
    row.appendChild(grip);

    row.appendChild(thumb);
    row.appendChild(info);
    row.appendChild(bars);
    row.appendChild(quote);
    row.appendChild(x);

    // ---- alert affordance ----
    var alertBtn = document.createElement('button');
    alertBtn.className = 'alert-btn';
    alertBtn.type = 'button';
    function updateAlertBtn() {
      var has = w.alertAbove || w.alertBelow || w.alertPct;
      if (has) {
        var p = [];
        if (w.alertAbove) p.push('above $' + w.alertAbove.toLocaleString());
        if (w.alertBelow) p.push('below $' + w.alertBelow.toLocaleString());
        if (w.alertPct) p.push('±' + w.alertPct + '%');
        alertBtn.title = 'Alert: ' + p.join(' · ') + ' (click to change)';
        alertBtn.classList.remove('alert-off');
      } else {
        alertBtn.title = 'Set a price alert';
        alertBtn.classList.add('alert-off');
      }
    }
    updateAlertBtn();
    alertBtn.textContent = '🔔';
    row.appendChild(alertBtn);

    // ---- ⭐ favorite toggle ----
    var favBtn = document.createElement('button');
    favBtn.className = 'fav-btn' + (w.fav ? ' fav-on' : '');
    favBtn.type = 'button';
    favBtn.title = w.fav ? 'Unpin from top' : 'Pin to top';
    favBtn.textContent = w.fav ? '⭐' : '☆';
    favBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      w.fav = !w.fav;
      favBtn.textContent = w.fav ? '⭐' : '☆';
      favBtn.classList.toggle('fav-on', w.fav);
      favBtn.title = w.fav ? 'Unpin from top' : 'Pin to top';
      save();
      render();
    });
    row.appendChild(favBtn);

    row.appendChild(alertBtn);

    var panel = document.createElement('div');
    panel.className = 'alert-panel';
    panel.hidden = true;

    function mkAlertRow(label, key) {
      var r = document.createElement('div');
      r.className = 'alert-row';
      var al = document.createElement('span');
      al.className = 'alert-label'; al.textContent = label;
      var inp = document.createElement('input');
      inp.className = 'alert-input'; inp.type = 'number'; inp.min = '0.01'; inp.step = 'any';
      inp.value = w[key] || '';
      inp.placeholder = key === 'alertPct' ? '10' : (w.price != null ? w.price.toFixed(2) : '0.00');
      if (key === 'alertPct') inp.title = 'Current base: ' + (w.alertPctBase != null ? Sport.formatPrice(w.alertPctBase) : 'not set') + ' — alert fires when price moves ± this % from the base';
      var set = document.createElement('button');
      set.className = 'alert-set'; set.type = 'button'; set.textContent = 'Set';
      var clr = document.createElement('button');
      clr.className = 'alert-clear'; clr.type = 'button'; clr.textContent = 'Clear';
      r.appendChild(al); r.appendChild(inp); r.appendChild(set); r.appendChild(clr);
      set.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var v = parseFloat(inp.value);
        if (isNaN(v) || v <= 0) { panel.hidden = true; return; }
        w[key] = v;
        if (key === 'alertPct') w.alertPctBase = w.price;
        updateAlertBtn();
        panel.hidden = true;
        save();
      });
      clr.addEventListener('click', function (ev) {
        ev.stopPropagation();
        w[key] = null;
        if (key === 'alertPct') w.alertPctBase = null;
        updateAlertBtn();
        inp.value = '';
        panel.hidden = true;
        save();
      });
      return r;
    }

    panel.appendChild(mkAlertRow('Alert above $', 'alertAbove'));
    panel.appendChild(mkAlertRow('Alert below $', 'alertBelow'));
    panel.appendChild(mkAlertRow('Alert if ±%', 'alertPct'));

    alertBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      panel.hidden = !panel.hidden;
    });

    var wrap = document.createElement('div');
    wrap.appendChild(row);
    wrap.appendChild(panel);

    row.addEventListener('contextmenu', function (ev) {
      ev.preventDefault();
      ctxTarget = w;
      els.ctxMenu.style.top = Math.min(ev.clientY, window.innerHeight - 120) + 'px';
      els.ctxMenu.style.left = Math.min(ev.clientX, window.innerWidth - 130) + 'px';
      els.ctxMenu.hidden = false;
    });
    row.addEventListener('click', function (ev) {
      if (ev.target.closest('.drag-grip') || ev.target.closest('.alert-btn') || ev.target.closest('.row-x') || ev.target.closest('.fav-btn')) return;
      chrome.windows.create({ type: 'popup', url: 'https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent(w.query), width: 900, height: 700 });
    });
    row.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        chrome.windows.create({ type: 'popup', url: 'https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent(w.query), width: 900, height: 700 });
      }
    });

    // ---- drag-to-reorder ----
    row.draggable = true;
    row.addEventListener('dragstart', function (ev) {
      dragIdx = Array.prototype.indexOf.call(els.list.children, wrap);
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', '');
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', function () {
      row.classList.remove('dragging');
      els.list.querySelectorAll('.drag-over').forEach(function (el) { el.classList.remove('drag-over'); });
      dragIdx = -1;
    });
    wrap.addEventListener('dragover', function (ev) {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      if (dragIdx >= 0 && !wrap.classList.contains('drag-over')) {
        els.list.querySelectorAll('.drag-over').forEach(function (el) { el.classList.remove('drag-over'); });
        wrap.classList.add('drag-over');
      }
    });
    wrap.addEventListener('drop', function (ev) {
      ev.preventDefault();
      wrap.classList.remove('drag-over');
      if (dragIdx < 0) return;
      var dropIdx = Array.prototype.indexOf.call(els.list.children, wrap);
      if (dropIdx === dragIdx) return;
      var item = state.watch.splice(dragIdx, 1)[0];
      state.watch.splice(dropIdx, 0, item);
      save();
      render();
    });
    return wrap;
  }

  function thumbPlaceholder() {
    var d = document.createElement('div');
    d.className = 'card-thumb ph';
    d.textContent = '⚾';
    return d;
  }

  function renderTape() {
    if (!state.watch.length) {
      els.tape.innerHTML = '';
      return;
    }
    var parts = state.watch.map(function (w) {
      var cls = w.trend ? (w.trend.dir === 1 ? 'up' : 'down') : 'flat';
      var chg = w.trend ? Sport.formatTrend(w.trend) : '—';
      return '<span class="tape-item"><span class="tape-name">' + esc(w.name) + '</span>' +
        '<span class="tape-price">' + esc(Sport.formatPrice(w.price)) + '</span>' +
        '<span class="tape-chg ' + cls + '">' + esc(chg) + '</span></span>';
    });
    // duplicate for a seamless loop
    els.tape.innerHTML = parts.join('') + parts.join('');
    els.tape.style.animation = 'none';
    void els.tape.offsetWidth;
    els.tape.style.animation = '';
  }

  // ---------- helpers ----------
  function dayChange(w) {
    if (!Array.isArray(w.daily) || w.daily.length < 2) return null;
    var now = Date.now(); var day = 24 * 60 * 60 * 1000;
    var best = null;
    for (var i = w.daily.length - 1; i >= 0; i--) {
      var d = w.daily[i];
      var dt = new Date(d.d + 'T12:00:00Z').getTime();
      var ago = now - dt;
      if (ago >= day * 0.8 && ago <= day * 1.3) { best = d.p; break; }
      if (ago > day * 1.3 && best == null) { best = d.p; }
    }
    if (best == null && w.daily.length) best = w.daily[0].p;
    if (best == null || w.price == null) return null;
    return +(w.price - best).toFixed(2);
  }

  function allTimeHigh(w) {
    if (!Array.isArray(w.daily) || !w.daily.length) return w.price;
    var max = w.price || 0;
    w.daily.forEach(function (d) { if (d.p > max) max = d.p; });
    return max;
  }

  function allTimeLow(w) {
    if (!Array.isArray(w.daily) || !w.daily.length) return w.price;
    var min = w.price || Infinity;
    w.daily.forEach(function (d) { if (d.p < min) min = d.p; });
    return min === Infinity ? w.price : min;
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  // ---------- alert log ----------
  function renderAlertLog() {
    var now = Date.now();
    var day = 24 * 60 * 60 * 1000;
    var items = [];
    state.watch.forEach(function (w) {
      if (!Array.isArray(w.alertLog)) return;
      w.alertLog.forEach(function (a) {
        if (now - a.ts <= day) items.push(a);
      });
    });
    items.sort(function (a, b) { return b.ts - a.ts; });
    if (!items.length) {
      els.alertLogBtn.classList.remove('has-log');
      els.alertLogBtn.removeAttribute('data-count');
      if (!els.alertLogPanel.hidden) els.alertLogPanel.hidden = true;
      return;
    }
    els.alertLogBtn.classList.add('has-log');
    els.alertLogBtn.setAttribute('data-count', items.length);
    var html = '';
    items.forEach(function (a) {
      var time = new Date(a.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      var dir = a.dir === 'above' ? '↑ hit' : '↓ below';
      html += '<div class="alert-log-item"><span class="alert-log-name">' + esc(a.name) + '</span> <span class="alert-log-dir">' + dir + ' $' + (a.threshold || 0).toLocaleString() + '</span> <span class="alert-log-price">→ ' + Sport.formatPrice(a.price) + '</span> <span class="alert-log-time">' + time + '</span></div>';
    });
    els.alertLogPanel.innerHTML = html;
    if (!els.alertLogPanel.hidden) els.alertLogPanel.scrollTop = 0;
  }

  els.alertLogBtn.addEventListener('click', function () {
    renderAlertLog();
    els.alertLogPanel.hidden = !els.alertLogPanel.hidden;
  });

  // ---------- refresh button + auto-refresh ----------
  els.sortBy.addEventListener('change', function () { render(); });
  els.exportCsv.addEventListener('click', exportCsv);
  els.copyClip.addEventListener('click', function () {
    var lines = state.watch.map(function (w) {
      var trendStr = w.trend ? (w.trend.dir === 1 ? '+' : '') + w.trend.pct.toFixed(1) + '%' : '—';
      return [w.name, w.price != null ? '$' + w.price.toFixed(2) : '', trendStr].join('\t');
    });
    navigator.clipboard.writeText(lines.join('\n')).then(function () {
      setStatus('📋 Copied ' + state.watch.length + ' cards to clipboard');
    }).catch(function () {
      setStatus('Could not copy — click 📥 CSV instead', true);
    });
  });
  els.themeToggle.addEventListener('click', function () {
    document.body.classList.toggle('light');
    var isLight = document.body.classList.contains('light');
    chrome.storage.local.set({ sptLight: isLight });
    els.themeToggle.textContent = isLight ? '🌙' : '☀️';
  });
  function applyTheme() {
    chrome.storage.local.get('sptLight', function (d) {
      var isLight = !!(d && d.sptLight);
      document.body.classList.toggle('light', isLight);
      els.themeToggle.textContent = isLight ? '🌙' : '☀️';
    });
  }

  els.compactToggle.addEventListener('click', function () {
    compact = !compact;
    document.body.classList.toggle('compact', compact);
    chrome.storage.local.set({ sptCompact: compact });
    els.compactToggle.textContent = compact ? '📐' : '📏';
  });
  function applyCompact() {
    chrome.storage.local.get('sptCompact', function (d) {
      compact = !!(d && d.sptCompact);
      document.body.classList.toggle('compact', compact);
      els.compactToggle.textContent = compact ? '📐' : '📏';
    });
  }
  els.refresh.addEventListener('click', refreshAll);
  els.retry.addEventListener('click', refreshAll);
  els.clearAll.addEventListener('click', function () {
    state.watch = [];
    save();
    setStatus('Cleared your ticker');
    render();
  });

  // ---------- right-click context menu ----------
  document.addEventListener('click', function () { els.ctxMenu.hidden = true; });
  els.ctxMenu.addEventListener('click', function (ev) {
    ev.stopPropagation();
    var action = (ev.target.closest('[data-action]') || {}).dataset && ev.target.closest('[data-action]').dataset.action;
    if (!action || !ctxTarget) return;
    var w = ctxTarget;
    if (action === 'copy-price') navigator.clipboard.writeText(Sport.formatPrice(w.price));
    else if (action === 'copy-name') navigator.clipboard.writeText(w.name);
    else if (action === 'remove') removeCard(w.id);
    els.ctxMenu.hidden = true;
    ctxTarget = null;
  });

  // ---------- keyboard page zoom (family pattern, on-canvas toast) ----------
  function applyPageZoom(z) {
    pageZoom = Math.round(z * 10) / 10;
    document.body.style.zoom = pageZoom === 1 ? '' : String(pageZoom);
  }
  function flashZoomHint() {
    els.zoomToast.textContent = 'Zoom ' + Math.round(pageZoom * 100) + '%';
    els.zoomToast.hidden = false;
    if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; }
    hintTimer = setTimeout(function () { els.zoomToast.hidden = true; }, 1200);
  }
  document.addEventListener('keydown', function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'k' || ev.key === 'K')) {
      ev.preventDefault();
      els.search.focus();
      els.search.select();
      return;
    }
    if (!(ev.ctrlKey || ev.metaKey)) return;
    var k = ev.key;
    if (k === '+' || k === '=' || k === '-' || k === '_') {
      ev.preventDefault();
      var dz = (k === '+' || k === '=') ? 0.1 : -0.1;
      applyPageZoom(Math.max(0.5, Math.min(2, pageZoom + dz)));
      flashZoomHint();
    } else if (k === '0') {
      ev.preventDefault();
      applyPageZoom(1);
      flashZoomHint();
    }
  });

  // ---------- CSV export ----------
  function exportCsv() {
    var rows = [['Name','Price','Trend','Alert Above','Alert Below','Alert ±%','24h Alerts']];
    state.watch.forEach(function (w) {
      var trendStr = w.trend ? (w.trend.dir === 1 ? '+' : '') + w.trend.pct.toFixed(1) + '%' : '—';
      var alertCount = 0;
      if (Array.isArray(w.alertLog)) {
        var day = 24 * 60 * 60 * 1000;
        alertCount = w.alertLog.filter(function (a) { return Date.now() - a.ts <= day; }).length;
      }
      rows.push([
        w.name,
        w.price != null ? w.price.toFixed(2) : '',
        trendStr,
        w.alertAbove != null ? w.alertAbove.toFixed(2) : '',
        w.alertBelow != null ? w.alertBelow.toFixed(2) : '',
        w.alertPct != null ? w.alertPct + '%' : '',
        String(alertCount)
      ]);
    });
    var csv = rows.map(function (r) { return r.map(function (c) { return '"' + c + '"'; }).join(','); }).join('\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = 'sportsticker-watchlist.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  function updateBadge() {
    var day = 24 * 60 * 60 * 1000; var total = 0;
    state.watch.forEach(function (w) {
      if (!Array.isArray(w.alertLog)) return;
      w.alertLog.forEach(function (a) { if (Date.now() - a.ts <= day) total++; });
    });
    chrome.action.setBadgeText({ text: total ? String(Math.min(total, 99)) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#4ade80' });
  }

  // ---------- init ----------
  chrome.action.setBadgeText({ text: '' });
  applyTheme();
  applyCompact();
  load(function () {
    if (!state.token) {
      openSettings();
      return;
    }
    render();
    if (state.watch.length) refreshAll();
    setInterval(refreshAll, REFRESH_MS);
    setTimeout(function () { updateBadge(); }, 500);
  });
})();
