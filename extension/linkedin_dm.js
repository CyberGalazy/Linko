/*
 * LinkedIn → X invite DMs (v5). Runs as a local Chrome extension (see README) — it then
 * survives page reloads — or can be pasted into the Chrome DevTools Console on:
 *   https://www.linkedin.com/mynetwork/invite-connect/connections/
 * Then press Enter. Edit the CONFIG block first.
 *
 * Controls (type in the console):  DM.stop()   DM.start()   DM.diagnose()   DM.diagnoseChat()
 *                                  DM.exportLog()   DM.resetLog()
 */
(() => {
  // ============================== CONFIG ==================================
  const CONFIG = {
    MESSAGE:
`Hey! Would love to connect on X (Twitter) as well. Always great to connect with like-minded people, share ideas and engage in interesting discussions.

Here's my profile: https://x.com/Gauransh20`,
    START_DATE: '2026-10-28',          // message people connected ON or BEFORE this date
    START_NAME: '',                        // start at this person (exact name; skip those above). '' = no name filter
    BETWEEN: [45, 90],                 // seconds per DM (start to start), random
    BREAK_EVERY: 15,                   // after this many sends, take a short break…
    BREAK_MINUTES: [5, 10],            // …of this many minutes
    VARY_GREETING: true,               // swap the opening 'Hey!' for Hi!/Hey there!/Hi there! at random
    LIMIT: Infinity,                   // max DMs this run (dry run is capped at 3 automatically)
    DRY_RUN: false,                     // true = paste but DON'T send. Set false to go live.
  };
  // ========================================================================

  const LOG_KEY = 'dmXLog';
  const SET_KEY = 'dmXSettings';        // what you type in the panel: { message, startName, startDate, startUrl, after }
  function settings() {
    let v = {};
    try { v = JSON.parse(localStorage.getItem(SET_KEY)) || {}; } catch {}
    return {
      message: typeof v.message === 'string' && v.message.trim() ? v.message : CONFIG.MESSAGE,
      startName: typeof v.startName === 'string' ? v.startName : CONFIG.START_NAME,
      startDate: v.startDate || CONFIG.START_DATE,
      startUrl: v.startUrl || '',     // bookmark: exact profile URL of the start person
      after: !!v.after,               // true = skip the bookmark person, begin with the next one
    };
  }
  const saveSettings = v => localStorage.setItem(SET_KEY, JSON.stringify(v));
  // Text used to recognise "already sent" in a thread: the first link in the message
  // (without https://), else its longest line (max 40 chars).
  function fingerprint(msg = settings().message) {
    const url = (msg.match(/https?:\/\/\S+/) || [])[0];
    if (url) return url.replace(/^https?:\/\//, '').replace(/[).,!?]+$/, '');
    const line = msg.split('\n').map(l => l.trim()).sort((a, b) => b.length - a.length)[0] || '';
    return line.slice(0, 40);
  }
  let START = new Date(settings().startDate + 'T23:59:59');
  const STOP_TEXTS = [/weekly limit/i, /reached the limit/i, /security check/i, /unusual activity/i,
                      /temporarily restricted/i];

  const VERSION = 'v11';
  const MEM_RELOAD_EVERY = 40;          // reload the page after this many sends to free memory
  const heap = () => (performance.memory ? performance.memory : null);
  const heapMB = () => { const m = heap(); return m ? Math.round(m.usedJSHeapSize / 1048576) : 0; };
  const heapHigh = () => { const m = heap(); return !!m && m.usedJSHeapSize > 0.6 * m.jsHeapSizeLimit; };
  // Let Chrome skip layout/paint for cards we've already passed (style only — safe for LinkedIn's React).
  const lighten = el => { if (el && !el.style.contentVisibility) { el.style.contentVisibility = 'auto'; el.style.containIntrinsicSize = 'auto 120px'; } };
  console.log('%c[DM]', 'color:#0a66c2;font-weight:bold', `linkedin_dm.js ${VERSION} loaded${window.__DM_EXT ? ' (extension)' : ' (pasted)'}`);
  if (window.DM && window.DM.running) { console.warn('DM already running. DM.stop() first.'); return; }

  // ----------------------------- utilities --------------------------------
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const say = (...a) => console.log('%c[DM]', 'color:#0a66c2;font-weight:bold', ...a);
  const visible = el => !!el && el.isConnected && el.getClientRects().length > 0 &&
                         (typeof el.checkVisibility !== 'function' || el.checkVisibility());
  const loadLog = () => { try { return JSON.parse(localStorage.getItem(LOG_KEY)) || {}; } catch { return {}; } };
  const saveLog = log => localStorage.setItem(LOG_KEY, JSON.stringify(log));
  const RUN_KEY = 'dmXRun';            // { running, rateBreaks, resumeAt, reloads[] } — survives reloads
  const loadRun = () => { try { return JSON.parse(localStorage.getItem(RUN_KEY)) || {}; } catch { return {}; } };
  const saveRun = r => localStorage.setItem(RUN_KEY, JSON.stringify(r));
  const FROM_EXT = !!window.__DM_EXT;    // set by extension/flag.js
  let breakUnit = 60000;                 // 1 "minute" (DM._fastBreaks() shrinks this for testing)
  const normUrl = href => { try { return new URL(href, location.origin).pathname.replace(/\/$/, '') + '/'; } catch { return href; } };

  async function waitFor(fn, ms = 10000, step = 200) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(step); }
    return null;
  }

  function realClick(el) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window,
                clientX: r.left + r.width * rand(0.3, 0.7), clientY: r.top + r.height * rand(0.3, 0.7) };
    for (const t of ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup'])
      el.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, o));
    el.click();
  }

  // --------------------------- date parsing -------------------------------
  function parseConnected(text) {
    let m = text.match(/Connected\s+on\s+([A-Z][a-z]+\.?\s+\d{1,2},\s+\d{4})/i);
    if (m) { const d = new Date(m[1].replace('.', '')); return isNaN(d) ? null : d; }
    m = text.match(/(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago/i);
    if (m) {
      const mult = { minute: 0, hour: 0, day: 1, week: 7, month: 30, year: 365 }[m[2].toLowerCase()];
      return new Date(Date.now() - (+m[1]) * mult * 864e5);
    }
    if (/today|just now/i.test(text)) return new Date();
    if (/yesterday/i.test(text)) return new Date(Date.now() - 864e5);
    return null;
  }

  // -------------------------- card detection ------------------------------
  const isMsgCtl = b => {
    const t = (b.innerText || '').trim(), a = b.getAttribute('aria-label') || '', h = b.getAttribute('href') || '';
    return /^message\b/i.test(t) || /^message\b/i.test(a) || /^send a message/i.test(a) || /messaging\/compose/.test(h);
  };

  function connectedLabels() {
    const out = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: n => /Connected/i.test(n.textContent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP });
    let n;
    while ((n = w.nextNode())) {
      if (n.parentElement && n.parentElement.closest('#dm-x-panel, .msg-overlay-container, script, style')) continue;
      let el = n.parentElement;
      for (let i = 0; i < 4 && el; i++, el = el.parentElement) {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();   // textContent: no forced layout
        if (/^Connected\b/i.test(t) && parseConnected(t)) { out.push(el); break; }
      }
    }
    return [...new Set(out)];
  }

  // Parsed cards are cached per label element, so we don't re-read hundreds of cards every loop.
  let cardCache = new WeakMap();
  function getCards() {
    const cards = [], seen = new Set();
    for (const label of connectedLabels()) {
      const hit = cardCache.get(label);
      if (hit && hit.el.isConnected && hit.msg.isConnected) {
        if (!seen.has(hit.url)) { seen.add(hit.url); cards.push(hit); }
        continue;
      }
      let el = label.parentElement;
      for (let i = 0; i < 15 && el; i++, el = el.parentElement) {
        const link = el.querySelector('a[href*="/in/"]');
        const msg = [...el.querySelectorAll('button, a')].find(isMsgCtl);
        if (link && msg) {
          const url = normUrl(link.getAttribute('href'));
          if (!seen.has(url)) {
            seen.add(url);
            let name = (link.innerText || '').split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
            if (!name) name = (msg.getAttribute('aria-label') || '').replace(/^(send a )?message( to)?\s*/i, '');
            const text = label.innerText.trim();
            const card = { el, msg, url, name, text, date: parseConnected(text) };
            cardCache.set(label, card);
            cards.push(card);
          }
          break;
        }
      }
    }
    return cards;
  }

  // ------------------------- rate-limit watcher ---------------------------
  // LinkedIn answers "429 Too Many Requests" when you go too fast. We watch for it
  // three ways (resource timing, fetch, XHR) and pause the run when it happens.
  const rl = { hits: [], sends: [], installed: false, po: null, origFetch: null, origOpen: null };
  const note429 = url => { if (/\/voyager\//.test(url || '')) rl.hits.push(Date.now()); };
  // A 2xx POST to LinkedIn's messaging API = proof a message actually went out.
  const noteSend = (method, url, status) => {
    if (/^post$/i.test(method || '') && /\/voyager\//.test(url || '') && /messag/i.test(url || '') &&
        status >= 200 && status < 300) rl.sends.push(Date.now());
  };
  const sentSince = t => rl.sends.some(x => x >= t);
  function installRateWatch() {
    if (rl.installed) return;
    rl.installed = true;
    try {
      rl.po = new PerformanceObserver(list => {
        for (const e of list.getEntries()) if (e.responseStatus === 429) note429(e.name);
      });
      rl.po.observe({ type: 'resource', buffered: false });
    } catch { /* older Chrome */ }
    rl.origFetch = window.fetch;
    window.fetch = function (...args) {
      const url = String((args[0] && args[0].url) || args[0]);
      const method = (args[1] && args[1].method) || (args[0] && args[0].method) || 'GET';
      return rl.origFetch.apply(this, args).then(r => { if (r.status === 429) note429(url); noteSend(method, url, r.status); return r; });
    };
    rl.origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, url, ...rest) {
      this.addEventListener('loadend', () => { if (this.status === 429) note429(String(url)); noteSend(m, String(url), this.status); });
      return rl.origOpen.call(this, m, url, ...rest);
    };
  }
  function removeRateWatch() {
    if (!rl.installed) return;
    try { rl.po && rl.po.disconnect(); } catch {}
    window.fetch = rl.origFetch;
    XMLHttpRequest.prototype.open = rl.origOpen;
    rl.installed = false;
  }
  const rateLimited = () => rl.hits.some(t => Date.now() - t < 60000);

  // ---------------------------- messaging ---------------------------------
  // LinkedIn's redesigned pages render the chat pop-up inside a shadow DOM (and
  // sometimes a same-origin iframe), which plain document.querySelectorAll can't
  // see. These helpers search all of them.
  // Chat pop-ups never live inside the connections list, so skip that (huge) subtree.
  // The list = closest common ancestor of the first and last card (never the page-level scroller,
  // which may also hold the chat pop-ups).
  let _list = null, _listAt = 0;
  function listRoot() {
    if (_list && _list.isConnected && Date.now() - _listAt < 10000) return _list;
    _list = null; _listAt = Date.now();
    const labels = connectedLabels();
    if (labels.length < 2) return null;
    let a = labels[0];
    const z = labels[labels.length - 1];
    while (a && !a.contains(z)) a = a.parentElement;
    if (!a || a === document.body || a === document.documentElement || a.querySelector('[contenteditable], #dm-x-panel')) return null;
    return (_list = a);
  }
  function elementsOf(r) {
    const skip = r === document ? listRoot() : null;
    if (!skip) return r.querySelectorAll('*');
    const out = [], w = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT,
      { acceptNode: n => n === skip ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    let n; while ((n = w.nextNode())) out.push(n);
    return out;
  }
  function scanRoots() {
    const out = [document], stack = [document];
    while (stack.length) {
      const r = stack.pop();
      for (const el of elementsOf(r)) {
        if (el.shadowRoot) { out.push(el.shadowRoot); stack.push(el.shadowRoot); }
        if (el.tagName === 'IFRAME') {
          try { const d = el.contentDocument; if (d && d.body) { out.push(d); stack.push(d); } } catch { /* cross-origin */ }
        }
      }
    }
    return out;
  }
  let _roots = null, _rootsAt = 0;
  function allRoots(fresh) {
    const age = Date.now() - _rootsAt;   // full rescans at most once a second, otherwise every 5 s
    if (!_roots || age > 5000 || (fresh && age > 1000)) { _roots = scanRoots(); _rootsAt = Date.now(); }
    return _roots;
  }
  const deepAll = (sel, fresh) => allRoots(fresh).flatMap(r => [...r.querySelectorAll(sel)]);

  const BOX_SEL = [
    'div.msg-form__contenteditable[contenteditable="true"]',
    'div[role="textbox"][contenteditable="true"]',
    '[contenteditable="true"][aria-label*="message" i]',
    '[contenteditable="true"][aria-placeholder*="message" i]',
    '[contenteditable="true"][data-placeholder*="message" i]',
  ].join(', ');

  const bubbles = () => deepAll('.msg-overlay-conversation-bubble').filter(visible);
  const allBoxes = fresh => deepAll(BOX_SEL, fresh).filter(visible);

  function scopeOf(box) {
    return box.closest('.msg-overlay-conversation-bubble') ||
           box.closest('[class*="conversation-bubble"], [class*="msg-overlay"], [role="dialog"], aside, section') ||
           (() => { let e = box; for (let i = 0; i < 8 && e.parentElement; i++) e = e.parentElement; return e; })();
  }

  function findSend(scope) {
    const btns = [...scope.querySelectorAll('button')]
      .filter(b => visible(b) && (b.classList.contains('msg-form__send-button') ||
        /^send$/i.test((b.innerText || '').trim()) || /^send/i.test(b.getAttribute('aria-label') || '') ||
        (b.type === 'submit' && /send/i.test(b.innerText + ' ' + (b.getAttribute('aria-label') || '')))));
    return btns.find(b => !b.disabled && b.getAttribute('aria-disabled') !== 'true') || null;
  }

  async function closeBubble(scope) {
    if (!scope) return;
    const isClose = b => visible(b) && /close your|close conversation|^close$/i.test(((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '')).trim());
    const btn = [...scope.querySelectorAll('button')].find(isClose) || deepAll('button').find(b => isClose(b) && /conversation/i.test(b.getAttribute('aria-label') || ''));
    if (btn) realClick(btn); else scope.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(rand(300, 700));
    const discard = deepAll('[role="dialog"] button, [role="alertdialog"] button, .artdeco-modal button', true)
      .find(b => visible(b) && /discard/i.test(b.innerText));
    if (discard) { realClick(discard); await sleep(300); }
  }

  async function closeAllBubbles() {
    for (const b of bubbles()) await closeBubble(b);
    for (const box of allBoxes(true)) await closeBubble(scopeOf(box));
  }

  function boxText(box) { return (box.innerText || '').replace(/\u00a0/g, ' '); }

  function selectAllIn(box) {
    box.focus();
    const root = box.getRootNode();
    const doc = box.ownerDocument;
    const sel = (root.getSelection && root.getSelection()) || doc.getSelection();
    const range = doc.createRange();
    range.selectNodeContents(box);
    sel.removeAllRanges(); sel.addRange(range);
  }
  function clearBox(box) { selectAllIn(box); box.ownerDocument.execCommand('delete', false, null); }

  const GREETINGS = ['Hey!', 'Hi!', 'Hey there!', 'Hi there!'];
  function messageText() {
    const msg = settings().message;
    if (!CONFIG.VARY_GREETING) return msg;
    const g = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
    return msg.replace(/^(Hey|Hi)( there)?!/, g);
  }

  const FAIL_RE = /failed to send|couldn['’]t send|could not send|message not sent|not delivered|unable to send/i;
  function sendFailedIn(scope) {
    if (FAIL_RE.test(scope.innerText || '')) return true;
    return [...scope.querySelectorAll('button')].some(b => visible(b) &&
      /^(retry|resend)/i.test(((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')).trim()));
  }

  async function pasteMessage(box) {
    const doc = box.ownerDocument;
    clearBox(box);
    await sleep(rand(100, 250));

    const dt = new DataTransfer();
    const text = messageText();
    dt.setData('text/plain', text);
    box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true }));
    await sleep(400);
    if (boxText(box).includes(fingerprint())) return true;

    // Fallback: insert line by line (Chrome fires real input events for execCommand)
    clearBox(box);
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (line) doc.execCommand('insertText', false, line);
      if (i < lines.length - 1) doc.execCommand('insertParagraph', false, null);
    });
    await sleep(300);
    return boxText(box).includes(fingerprint());
  }

  function checkBlocks() {
    if (/checkpoint|\/login|authwall/.test(location.pathname)) return 'LinkedIn redirected to ' + location.pathname;
    const areas = deepAll('[role="dialog"], [role="alertdialog"], .artdeco-modal, .artdeco-toast-item, .msg-overlay-conversation-bubble');
    const text = areas.map(a => a.innerText).join('\n');
    const hit = STOP_TEXTS.find(r => r.test(text));
    return hit ? 'LinkedIn shows: ' + hit : null;
  }

  let loggedClick = false;
  async function messageCard(card) {
    const path = location.pathname;
    const before = new Set(allBoxes(true));
    if (!loggedClick) {
      loggedClick = true;
      say('   clicking:', card.msg.tagName, JSON.stringify((card.msg.innerText || card.msg.getAttribute('aria-label') || '').trim()), card.msg.getAttribute('href') || '');
    }
    realClick(card.msg);

    const look = () => {
      if (rateLimited()) return { rate: true };
      if (location.pathname !== path) return { nav: true };
      const boxes = allBoxes(true);
      const fresh = boxes.filter(b => !before.has(b));
      const box = fresh[fresh.length - 1] || boxes[boxes.length - 1];
      if (box) return { scope: scopeOf(box), box };
      const dlg = deepAll('[role="dialog"], .artdeco-modal').find(d => visible(d) && /inmail|premium/i.test(d.innerText));
      if (dlg) return { inmail: dlg };
      return null;
    };
    let result = await waitFor(look, 3000, 250);
    if (!result) { realClick(card.msg); result = await waitFor(look, 9000, 250); } // one retry

    if (!result) throw Object.assign(new Error('chat box did not open'), { nobox: true });
    if (result.rate) throw Object.assign(new Error('rate limited'), { rate: true });
    if (result.nav) throw Object.assign(new Error('Message opened a new page instead of the chat pop-up — a console script cannot follow page changes.'), { fatal: true });
    if (result.inmail) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); throw new Error('needs InMail/Premium'); }

    const { scope, box } = result;
    await sleep(rand(400, 900)); // let the thread load
    const threadText = scope.innerText.replace(boxText(box), '');
    if (threadText.includes(fingerprint()) && !sendFailedIn(scope)) { await closeBubble(scope); return 'skipped-existing'; }
    const failedBefore = sendFailedIn(scope);

    if (!(await pasteMessage(box))) throw new Error('could not insert message text');
    await sleep(rand(500, 1500));

    if (CONFIG.DRY_RUN) {
      say('   [dry-run] pasted, NOT sending');
      await sleep(1500);
      clearBox(box);
      await closeBubble(scope);
      return 'dry-run';
    }

    const send = await waitFor(() => findSend(scope), 4000);
    const tSend = Date.now();
    if (send) realClick(send);
    else box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, composed: true }));

    // LinkedIn often swaps the "new message" pop-up for a fresh conversation pop-up after the
    // first send, detaching our box/scope — so check live pop-ups too, and the network.
    const FP = fingerprint();
    const liveScopes = () => scope.isConnected ? [scope] : [...new Set([...bubbles(), ...allBoxes(true).map(scopeOf)])];
    const leftComposer = () => !box.isConnected || !boxText(box).includes(FP);
    const inThread = sc => {
      let t = sc.innerText || '';
      for (const b of sc.querySelectorAll(BOX_SEL)) t = t.replace(b.innerText || '', '');
      return t.includes(FP);
    };
    const confirmed = await waitFor(() => sentSince(tSend) ? 'network'
      : (leftComposer() && liveScopes().some(inThread)) ? 'dom' : null, 15000, 250);
    // A failed message still shows in the thread, so watch a few seconds for LinkedIn's failure marker.
    const failed = await waitFor(() => scope.isConnected ? (!failedBefore && sendFailedIn(scope))
      : liveScopes().some(sendFailedIn), confirmed ? 3500 : 1500, 250);
    const closeLive = async () => { for (const sc of liveScopes()) await closeBubble(sc); };
    if (failed) { await closeLive(); throw Object.assign(new Error('LinkedIn failed to send'), { sendFailed: true }); }
    if (!confirmed && !leftComposer()) throw new Error('could not confirm the message was sent (text still in the box)');
    await sleep(rand(300, 800));
    await closeLive();
    return confirmed ? 'sent' : 'sent (unconfirmed)';
  }

  // ---------------------------- scrolling ---------------------------------
  // LinkedIn's new connections page scrolls inside its own container, not the window.
  let _scroller = null;
  function scroller() {
    if (_scroller && _scroller.isConnected && _scroller.scrollHeight > _scroller.clientHeight + 50) return _scroller;
    const cards = getCards();
    let start = cards.length ? cards[cards.length - 1].el : connectedLabels()[0];
    for (let e = start; e && e !== document.documentElement; e = e.parentElement) {
      const oy = getComputedStyle(e).overflowY;
      if (/(auto|scroll|overlay)/.test(oy) && e.scrollHeight > e.clientHeight + 50) return (_scroller = e);
    }
    return (_scroller = document.scrollingElement || document.documentElement);
  }

  async function loadMore(fast) {
    const sc = scroller();
    const before = sc.scrollHeight, beforeCards = getCards().length;
    for (let i = 0; i < 3; i++) {
      sc.scrollBy({ top: fast ? rand(1000, 1600) : rand(500, 900), behavior: 'smooth' });
      await sleep(fast ? rand(150, 300) : rand(300, 700));
    }
    const cards = getCards();
    if (cards.length) cards[cards.length - 1].el.scrollIntoView({ block: 'end', behavior: 'smooth' });
    await sleep(fast ? rand(300, 500) : rand(500, 900));
    const more = deepAll('button').find(b => visible(b) && /show more results|load more|see more/i.test(b.innerText || ''));
    if (more) { realClick(more); await sleep(fast ? rand(900, 1400) : rand(1500, 2500)); }
    else await sleep(fast ? rand(600, 1000) : rand(1000, 1800));
    return scroller().scrollHeight > before || getCards().length > beforeCards || !!more;
  }

  // ------------------------------ panel -----------------------------------
  // Built with createElement only — LinkedIn sanitizes innerHTML and strips <input>s.
  const ui = {};
  function el(tag, props = {}, kids = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'style') e.style.cssText = v; else e[k] = v;
    }
    for (const k of kids) e.append(k);
    return e;
  }
  function buildPanel() {
    const inp = 'display:block;width:100%;box-sizing:border-box;margin:2px 0 6px;padding:4px 6px;border-radius:4px;border:1px solid #444;background:#222;color:#fff;font:12px system-ui;color-scheme:dark';
    const btn = 'margin-top:6px;margin-right:6px;color:#fff;border:0;border-radius:4px;padding:4px 10px;cursor:pointer';
    ui.msg = el('textarea', { id: 'dm-x-msg', rows: 6, style: inp + ';resize:vertical;white-space:pre-wrap;font:12px/1.35 system-ui' });
    ui.fp = el('div', { style: 'opacity:.5;font-size:10px;margin:-4px 0 6px;word-break:break-all' });
    ui.reset = el('a', { href: '#', textContent: 'reset', style: 'float:right;color:#8ab4f8;font-size:11px' });
    ui.name = el('input', { id: 'dm-x-name', type: 'text', placeholder: 'e.g. Jane Doe (blank = first on/before date)', style: inp });
    ui.date = el('input', { id: 'dm-x-date', type: 'date', style: inp });
    ui.text = el('div', { id: 'dm-x-text' });
    ui.start = el('button', { id: 'dm-x-start', type: 'button', textContent: 'Start', style: btn + ';background:#2e7d32' });
    ui.stop = el('button', { id: 'dm-x-stop', type: 'button', textContent: 'Stop', style: btn + ';background:#c62828' });
    const form = el('div', { id: 'dm-x-form', style: 'margin-bottom:6px;padding-bottom:6px;border-bottom:1px solid #333' }, [
      el('div', { style: 'opacity:.75' }, [ui.reset, 'Message']), ui.msg, ui.fp,
      el('div', { textContent: 'Start from (name)', style: 'opacity:.75' }), ui.name,
      el('div', { textContent: 'Connected on/before', style: 'opacity:.75' }), ui.date,
    ]);
    const ver = el('div', { textContent: VERSION, style: 'position:absolute;top:4px;right:8px;opacity:.4;font-size:10px' });
    ui.panel = el('div', { id: 'dm-x-panel',
      style: 'position:fixed;left:12px;bottom:12px;z-index:99999;background:#111;color:#fff;font:12px/1.4 system-ui;padding:10px 12px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.3);width:300px;max-height:90vh;overflow:auto' },
      [ver, form, ui.text, ui.start, ui.stop]);
    document.body.appendChild(ui.panel);

    const st = settings();
    ui.msg.value = st.message;
    const showFp = () => { ui.fp.textContent = 'already-sent check: ' + (fingerprint(ui.msg.value) || '(empty)'); };
    showFp();
    // Message edits are saved on their own, so they don't reset the start-name bookmark.
    ui.msg.addEventListener('input', () => { saveSettings({ ...settings(), message: ui.msg.value }); showFp(); });
    ui.reset.addEventListener('click', e => {
      e.preventDefault();
      if (ui.msg.disabled) return;
      ui.msg.value = CONFIG.MESSAGE;
      saveSettings({ ...settings(), message: '' });
      showFp();
    });
    ui.name.value = st.startName || '';
    ui.date.value = st.startDate || '';
    // Typing a name by hand means "start AT this person" — drop the auto bookmark.
    const store = () => saveSettings({ ...settings(), startName: ui.name.value.trim(), startDate: ui.date.value || CONFIG.START_DATE, startUrl: '', after: false });
    ui.name.addEventListener('input', store);
    ui.name.addEventListener('change', store);
    ui.date.addEventListener('change', store);
    ui.start.addEventListener('click', () => DM.start());
    ui.stop.addEventListener('click', () => DM.stop());
    // Keep LinkedIn's page handlers from stealing clicks/focus inside the panel.
    for (const t of ['mousedown', 'mouseup', 'click', 'pointerdown', 'focusin'])
      ui.panel.addEventListener(t, e => e.stopPropagation());
  }
  // Keep LinkedIn's global keyboard shortcuts from grabbing keys typed into our boxes.
  if (!window.__dmKeyGuard) {
    window.__dmKeyGuard = true;
    for (const t of ['keydown', 'keypress', 'keyup'])  // (not 'input' — we need that one ourselves)
      window.addEventListener(t, e => {
        const id = e.target && e.target.id;
        if (id === 'dm-x-name' || id === 'dm-x-date' || id === 'dm-x-msg') e.stopImmediatePropagation();
      }, true);
  }
  function panel(text) {
    if (!ui.panel || !ui.panel.isConnected) {
      const old = document.getElementById('dm-x-panel');
      if (old) old.remove();            // left over from an older version
      buildPanel();
    }
    ui.text.replaceChildren();
    String(text).split(/<br\s*\/?>/i).forEach((line, i) => {
      if (i) ui.text.append(document.createElement('br'));
      ui.text.append(document.createTextNode(line.replace(/<[^>]+>/g, '')));
    });
  }
  function lockForm(on) {
    for (const e of [ui.msg, ui.name, ui.date, ui.start]) {
      if (e) { e.disabled = on; e.style.opacity = on ? '.5' : '1'; }
    }
  }

  // ------------------------------- main -----------------------------------
  const DM = window.DM = {
    running: false,
    stop() {
      this.running = false;
      saveRun({ ...loadRun(), running: false, resumeAt: 0 });
      say('Stopping after the current person…'); panel('Stopping…');
    },

    async start() {
      if (this.running) return say('Already running.');
      if (ui.msg && !ui.msg.value.trim()) { panel('Type a message first.'); return say('Type a message first.'); }
      this.running = true;
      const log = loadLog();
      const tried = new Set();
      let count = 0, sent = 0, stale = 0, announced = false, sendFails = 0;
      const norm = x => (x || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const st = settings();
      START = new Date(st.startDate + 'T23:59:59');
      const START_NAME = st.startName;
      // With a name, start at that person whatever their date, and take everyone below them.
      const eligible = c => START_NAME ? true : !!(c.date && c.date <= START);
      const START_URL = START_NAME ? st.startUrl : '';
      const START_AFTER = !!(START_URL || START_NAME) && st.after;
      let startReached = !START_NAME;
      // Move the "Start from" bookmark as we go, so a reload / restart continues from here.
      const bookmark = (c, after) => {
        lighten(c.el);
        saveSettings({ ...settings(), startName: c.name, startUrl: c.url, after });
        if (ui.name) ui.name.value = c.name;
      };
      panel('Starting…'); lockForm(true);
      let sinceBreak = 0, reloading = false, sentThisPage = 0;
      const run = loadRun();
      run.running = true; run.rateBreaks = run.rateBreaks || 0;
      saveRun(run);
      const pauseFor = async (ms, label) => {
        const end = Date.now() + ms;
        while (this.running && Date.now() < end) {
          const left = Math.ceil((end - Date.now()) / 1000);
          panel(`${label}<br>resuming in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} · sent ${sent}${heapMB() ? ' · ' + heapMB() + ' MB' : ''}`);
          await sleep(1000);
        }
      };
      // Returns 'reload' (page is reloading — exit loop), 'stop', or 'continue'.
      const rateBreak = async () => {
        const now = Date.now();
        run.reloads = (run.reloads || []).filter(t => now - t < 3600e3);
        if (FROM_EXT && run.reloads.length >= 15) {
          say('🛑 LinkedIn keeps rate-limiting — stopped. Try again later.');
          panel('🛑 LinkedIn keeps rate-limiting — stopped.<br>Try again later.');
          return 'stop';
        }
        const mins = Math.min(Math.pow(2, run.rateBreaks), 2);   // 1 min, then 2 min max
        run.rateBreaks++;
        run.resumeAt = now + mins * breakUnit;
        saveRun(run);
        say(`⏸ LinkedIn API error / chat didn't open — pausing ${mins} min, then ${FROM_EXT ? 'reloading and continuing' : 'continuing'}.`);
        await closeAllBubbles();
        await pauseFor(run.resumeAt - Date.now(), `⏸ LinkedIn rate limit — pausing ${mins} min`);
        rl.hits = [];
        if (!this.running) return 'stop';
        if (FROM_EXT) {
          run.reloads.push(Date.now());
          run.resumeAt = 0;
          saveRun(run);
          say('↻ Reloading the page…');
          reloading = true;
          setTimeout(() => location.reload(), 300);
          return 'reload';
        }
        return 'continue';
      };
      installRateWatch();
      say(`script ${VERSION}${FROM_EXT ? ' (extension)' : ''} · ${CONFIG.BETWEEN[0]}–${CONFIG.BETWEEN[1]} s pacing · start at ${START_NAME || '(first on/before ' + st.startDate + ')'}`);
      say(`Start. ${START_NAME ? 'From ' + START_NAME : 'Date ≤ ' + st.startDate}. ${CONFIG.DRY_RUN ? 'DRY RUN (not sending).' : 'LIVE — sending.'} Already in log: ${Object.keys(log).length}`);
      await closeAllBubbles();

      try {
        if (run.resumeAt && run.resumeAt > Date.now()) {
          say('Finishing the break that was running before the reload…');
          await pauseFor(run.resumeAt - Date.now(), '⏸ Rate-limit break');
          run.resumeAt = 0; saveRun(run);
        }
        const limit = CONFIG.DRY_RUN ? Math.min(CONFIG.LIMIT, 3) : CONFIG.LIMIT;
        while (this.running && count < limit) {
          const block = checkBlocks();
          if (block) { say('🛑 STOP —', block); break; }
          if (rateLimited()) { const r = await rateBreak(); if (r !== 'continue') break; continue; }
          // Free memory: reload (and resume after the last person) every N sends or when the heap gets big.
          if (FROM_EXT && (sentThisPage >= MEM_RELOAD_EVERY || heapHigh())) {
            say(`🧹 Refreshing the page to free memory (${heapMB()} MB, ${sentThisPage} sent on this page)…`);
            panel('🧹 Refreshing the page to free memory…');
            await closeAllBubbles();
            saveRun({ ...loadRun(), running: true, resumeAt: 0 });
            reloading = true;
            setTimeout(() => location.reload(), 300);
            break;
          }

          const cards = getCards();
          if (!startReached) {
            for (const c of cards) {
              if (START_URL ? c.url === START_URL : norm(c.name) === norm(START_NAME)) {
                startReached = true;
                if (START_AFTER) { tried.add(c.url); say(`Continuing after ${c.name}.`); }
                else say(`Starting at ${c.name}.`);
                break;
              }
              tried.add(c.url);   // above the start person — skip
              lighten(c.el);
            }
          }
          const card = !startReached ? null : cards.find(c => !tried.has(c.url) && !log[c.url] && eligible(c));
          if (!card) {
            if (!announced) {
              const last = cards[cards.length - 1];
              const oldest = last && last.date ? last.date.toDateString() : '?';
              panel(`Scrolling… ${cards.length} cards loaded<br>oldest: ${oldest}`);
              say(`scrolling… ${cards.length} cards loaded, oldest: ${oldest}`);
            }
            const more = await loadMore(!startReached || !announced);
            const cardsAfter = getCards().length;
            stale = (more || cardsAfter > cards.length) ? 0 : stale + 1;
            if (stale >= 4) {
              if (!startReached) say(`🛑 Couldn't find "${START_NAME}" in the list — check the spelling in the "Start from" box.`);
              else say('No more connections to load. Done.');
              break;
            }
            continue;
          }
          if (!announced) { announced = true; say(`Reached ${card.date.toDateString()} — starting with ${card.name}.`); }

          tried.add(card.url);
          const t0 = Date.now();
          panel(`${CONFIG.DRY_RUN ? 'DRY RUN · ' : ''}sent ${sent}<br>→ ${card.name}<br><span style="opacity:.7">${card.text}</span>`);
          say(`→ ${card.name} (${card.text})`);
          try {
            const status = await messageCard(card);
            if (status.startsWith('sent')) { sendFails = 0; sinceBreak++; if (run.rateBreaks) { run.rateBreaks = 0; saveRun(run); } }
            say(`   ✓ ${status}`);
            if (status !== 'dry-run') {
              log[card.url] = { name: card.name, connected: card.date.toISOString().slice(0, 10), status, at: new Date().toISOString() };
              saveLog(log);
            }
            if (status.startsWith('sent') || status === 'dry-run') { count++; if (status.startsWith('sent')) { sent++; sentThisPage++; } }
            if (status !== 'dry-run') bookmark(card, true);
          } catch (e) {
            if (e.rate || e.nobox || rateLimited()) {
              tried.delete(card.url);            // retry this person after the break
              bookmark(card, false);
              say(`   ✗ ${card.name}: ${e.nobox ? 'chat box did not open' : 'LinkedIn rate limit'}`);
              const r = await rateBreak();
              if (r !== 'continue') break;
              continue;
            }
            if (e.sendFailed) {
              tried.delete(card.url);            // retry this person later
              bookmark(card, false);
              sendFails++;
              if (sendFails >= 3) { say('🛑 LinkedIn is rejecting sends — wait a while before running again.'); break; }
              const mins = Math.min(Math.pow(2, sendFails - 1), 2);
              say(`   ✗ LinkedIn failed to send to ${card.name} — backing off ${mins} min`);
              panel(`LinkedIn rejected a send · waiting ${mins} min…<br>sent ${sent}`);
              await closeAllBubbles();
              await pauseFor(mins * breakUnit, `LinkedIn rejected a send · waiting ${mins} min`);
              continue;
            }
            say('   ✗ skipped:', e.message);
            bookmark(card, true);
            await closeAllBubbles();
            if (e.fatal) break;
          }
          if (sinceBreak >= CONFIG.BREAK_EVERY) {
            sinceBreak = 0;
            const mins = rand(CONFIG.BREAK_MINUTES[0], CONFIG.BREAK_MINUTES[1]);
            say(`☕ Short break: ${mins.toFixed(1)} min`);
            await pauseFor(mins * 60000, '☕ Short break');
            continue;
          }
          // keep each DM ~BETWEEN seconds start-to-start
          const wait = rand(CONFIG.BETWEEN[0], CONFIG.BETWEEN[1]) * 1000 - (Date.now() - t0);
          if (wait > 0) await pauseFor(wait, `Next message`);
        }
      } finally {
        this.running = false;
        removeRateWatch();
        lockForm(false);
        if (reloading) return;
        saveRun({ ...loadRun(), running: false, resumeAt: 0 });
        say(`Finished. ${CONFIG.DRY_RUN ? 'Dry-run messages: ' + count : 'Sent this run: ' + sent}. Total in log: ${Object.keys(loadLog()).length}`);
        panel(`Finished · sent ${sent}${CONFIG.DRY_RUN ? ' (dry run ' + count + ')' : ''}`);
      }
    },

    async diagnoseChat() {
      if (this.running) return say('Stop the run first: DM.stop()');
      const card = getCards().find(c => c.date && c.date <= START) || getCards()[0];
      if (!card) return say('No eligible card visible — scroll the list a bit and try again.');
      const urlBefore = location.href;
      say('Clicking Message for', card.name, '→', card.msg.tagName, card.msg.outerHTML.slice(0, 300));
      realClick(card.msg);
      await sleep(4000);
      say('URL before:', urlBefore, '\nURL after: ', location.href);
      const roots = allRoots(true);
      console.table(roots.slice(1).map(r => {
        const h = r.host || (r.defaultView && r.defaultView.frameElement);
        return { kind: r.host ? 'shadow' : 'iframe', host: h ? h.tagName + '#' + h.id + '.' + String(h.className).slice(0, 60) : '?' };
      }));
      const eds = deepAll('[contenteditable]', true);
      console.table(eds.map(e => ({ tag: e.tagName, visible: visible(e), ce: e.getAttribute('contenteditable'),
        role: e.getAttribute('role'), aria: e.getAttribute('aria-label'), class: String(e.className).slice(0, 80),
        inShadow: e.getRootNode() !== document })));
      const msgEls = deepAll('[class*="msg-"]');
      say(`Elements with "msg-" classes: ${msgEls.length}`,
          [...new Set(msgEls.map(e => String(e.className).split(' ').find(c => c.startsWith('msg-'))))].slice(0, 25));
      say('Copy everything above and send it over.');
    },

    diagnose() {
      const labels = connectedLabels();
      const cards = getCards();
      say(`"Connected" labels found: ${labels.length}, full cards detected: ${cards.length}`);
      console.table(cards.slice(0, 10).map(c => ({ name: c.name, connected: c.text, url: c.url, msgTag: c.msg.tagName })));
      const sample = labels[0];
      if (!sample) { say('No "Connected on …" text found. Is the connections list visible?'); return; }
      let el = sample, chain = [];
      for (let i = 0; i < 15 && el; i++, el = el.parentElement) {
        chain.push({ level: i, tag: el.tagName, class: (el.className || '').toString().slice(0, 80),
          inLinks: el.querySelectorAll('a[href*="/in/"]').length,
          buttons: [...el.querySelectorAll('button, a')].slice(0, 4).map(b => (b.innerText || b.getAttribute('aria-label') || '').trim().slice(0, 30)).join(' | ') });
      }
      console.table(chain);
      say('Copy both tables above and send them over if 0 cards were detected.');
    },

    exportLog() {
      const s = JSON.stringify(loadLog(), null, 2);
      try { copy(s); say('Log copied to clipboard.'); } catch { console.log(s); }
      return loadLog();
    },
    resetLog() { localStorage.removeItem(LOG_KEY); say('Log cleared.'); },
    resetRun() { localStorage.removeItem(RUN_KEY); say('Run state cleared (backoff + reload history).'); },
    _simulate429() { rl.hits.push(Date.now()); say('(test) fake 429 recorded'); },
    _fastBreaks() { breakUnit = 2000; say('(test) breaks shortened: 1 min → 2 s'); },
  };

  if (!/mynetwork\/invite-connect\/connections/.test(location.pathname)) {
    say('Open https://www.linkedin.com/mynetwork/invite-connect/connections/ first, then paste again.');
    return;
  }
  if (FROM_EXT) {
    const run = loadRun();
    if (run.running) {
      panel('Resuming after reload…');
      say('Resuming after reload…');
      setTimeout(() => DM.start(), rand(3000, 6000));
    } else {
      panel('Ready — check the name/date above, then click Start.');
    }
  } else {
    DM.start();
  }
})();
