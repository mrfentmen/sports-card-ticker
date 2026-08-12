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
    zoomToast: document.getElementById('zoom-toast')
  };

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
  }

  function setStale(ts) {
    var lv = Sport.staleLevel(ts);
    if (lv) els.status.classList.add(lv);
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
      entry.price = r.median;
      entry.hist.push({ p: r.median, t: Date.now() });
      if (entry.hist.length > HIST_MAX) entry.hist = entry.hist.slice(-HIST_MAX);
      entry.trend = Sport.historyTrend(entry.hist);
      entry.ts = Date.now();
    }
    save();
    render();
  }

  // ---------- rendering ----------
  function render() {
    els.empty.hidden = state.watch.length > 0;
    els.tapeWrap.hidden = state.watch.length === 0;
    els.clearAll.hidden = state.watch.length === 0;
    renderTape();
    els.list.innerHTML = '';
    state.watch.forEach(function (w) {
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

    var bars = document.createElement('div');
    bars.className = 'card-bars';
    bars.title = 'Median history (latest ' + HIST_MAX + ' refreshes)';
    var heights = Sport.sparkBars(w.hist, 8);
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

    row.appendChild(thumb);
    row.appendChild(info);
    row.appendChild(bars);
    row.appendChild(quote);
    row.appendChild(x);

    row.addEventListener('click', function () {
      chrome.tabs.create({ url: 'https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent(w.query) });
    });
    row.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        chrome.tabs.create({ url: 'https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent(w.query) });
      }
    });
    return row;
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

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  // ---------- refresh button + auto-refresh ----------
  els.refresh.addEventListener('click', refreshAll);
  els.clearAll.addEventListener('click', function () {
    state.watch = [];
    save();
    setStatus('Cleared your ticker');
    render();
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

  // ---------- init ----------
  load(function () {
    if (!state.token) {
      openSettings();
      return;
    }
    render();
    if (state.watch.length) refreshAll();
    setInterval(refreshAll, REFRESH_MS);
  });
})();
