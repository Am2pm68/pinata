/*!
 * TOIAF Network — Concierge dock
 *
 * Mounts one floating surface carrying Messages, Activity and the existing
 * AI concierge. Self-mounting, so it needs no template change: drop the file
 * in and localize window.TOIAF_DOCK.
 *
 *   {
 *     restUrl, nonce, currency, isCreator, messagesUrl,
 *     pollSeconds,          // 0 disables polling
 *     labels: { ... }
 *   }
 *
 * REST it expects (see class-toiaf-dock.php):
 *   GET  {restUrl}/feed      -> { notifications: [...], conversations: [...], unread: {...} }
 *   POST {restUrl}/seen      -> { ok: true, unread: {...} }
 */
(function () {
  'use strict';

  var CFG = window.TOIAF_DOCK || {};
  if (!CFG.restUrl) return;

  var REST = CFG.restUrl.replace(/\/$/, '');
  var CURRENCY = CFG.currency || 'TP';
  var STORE_TAB = 'toiaf:dock:tab';

  /* ---------------------------------------------------------------- utils */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function store(key, val) {
    try {
      if (val === undefined) return window.localStorage.getItem(key);
      window.localStorage.setItem(key, val);
    } catch (e) { /* private mode, or storage blocked outright */ }
    return null;
  }

  function ago(ts) {
    var s = Math.max(0, Math.floor(Date.now() / 1000 - Number(ts)));
    if (s < 60) return 'now';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    if (s < 604800) return Math.floor(s / 86400) + 'd';
    return Math.floor(s / 604800) + 'w';
  }

  function dayBucket(ts) {
    var d = new Date(Number(ts) * 1000);
    var now = new Date();
    var yest = new Date();
    yest.setDate(now.getDate() - 1);
    var k = function (x) { return x.getFullYear() + '-' + x.getMonth() + '-' + x.getDate(); };
    if (k(d) === k(now)) return 'Today';
    if (k(d) === k(yest)) return 'Yesterday';
    return d.toLocaleDateString(CFG.locale || undefined, { month: 'short', day: 'numeric' });
  }

  /* Notification presentation. Server sends `kind`; everything visual is
     decided here so the API stays about data. */
  var KINDS = {
    tip:        { icon: '💰', money: true },
    unlock:     { icon: '🔓', money: true },
    subscriber: { icon: '⭐',       money: true },
    payout:     { icon: '🏦', money: true },
    booking:    { icon: '📅' },
    custom:     { icon: '📦' },
    follower:   { icon: '👤' },
    approved:   { icon: '✅' },
    message:    { icon: '💬' },
    system:     { icon: '⚡' }
  };

  /* ----------------------------------------------------------------- mount */

  var dock = el('div', 'toiaf-dock');
  dock.setAttribute('role', 'complementary');
  dock.setAttribute('aria-label', 'Messages and activity');

  dock.innerHTML =
    '<div class="toiaf-dock__panel" role="dialog" aria-label="Messages and activity">' +
      '<div class="toiaf-dock__head">' +
        '<button type="button" class="toiaf-dock__back">‹ Inbox</button>' +
        '<h2 class="toiaf-dock__title">TOIAF</h2>' +
        '<div class="toiaf-dock__head-actions">' +
          '<a class="toiaf-dock__icon-btn" data-dock-expand title="Open full messages" aria-label="Open full messages">↗</a>' +
          '<button type="button" class="toiaf-dock__icon-btn" data-dock-close title="Close" aria-label="Close">×</button>' +
        '</div>' +
      '</div>' +
      '<div class="toiaf-dock__tabs" role="tablist">' +
        '<button type="button" class="toiaf-dock__tab" data-tab="messages" role="tab" aria-selected="false">' +
          'Messages <span class="toiaf-dock__tab-count" hidden></span></button>' +
        '<button type="button" class="toiaf-dock__tab" data-tab="activity" role="tab" aria-selected="true">' +
          'Activity <span class="toiaf-dock__tab-count" hidden></span></button>' +
        '<button type="button" class="toiaf-dock__tab" data-tab="concierge" role="tab" aria-selected="false" hidden>' +
          'Concierge</button>' +
      '</div>' +
      '<div class="toiaf-dock__body">' +
        '<div class="toiaf-dock__pane" data-pane="messages"><div class="toiaf-dock__scroll"></div></div>' +
        '<div class="toiaf-dock__pane" data-pane="activity" data-active><div class="toiaf-dock__scroll">' +
          '<div class="toiaf-dock__skeleton"><i></i><i></i><i></i></div></div></div>' +
        '<div class="toiaf-dock__pane" data-pane="concierge"></div>' +
      '</div>' +
    '</div>' +
    '<button type="button" class="toiaf-dock__launcher" aria-expanded="false">' +
      '<span class="toiaf-dock__mark">◉</span>' +
      '<span class="toiaf-dock__launcher-label">Inbox</span>' +
      '<span class="toiaf-dock__count" hidden></span>' +
    '</button>';

  document.body.appendChild(dock);
  document.body.classList.add('toiaf-has-dock');

  var panel     = dock.querySelector('.toiaf-dock__panel');
  var launcher  = dock.querySelector('.toiaf-dock__launcher');
  var totalCount= dock.querySelector('.toiaf-dock__count');
  var backBtn   = dock.querySelector('.toiaf-dock__back');
  var expandBtn = dock.querySelector('[data-dock-expand]');
  var tabs      = Array.prototype.slice.call(dock.querySelectorAll('.toiaf-dock__tab'));

  if (CFG.messagesUrl) expandBtn.href = CFG.messagesUrl;
  else expandBtn.remove();

  /* ------------------------------------------------------------ concierge */

  /*
   * The site already ships a floating AI concierge (.toiaf-mcc--floating from
   * toiaf-model-concierge-chat). Rather than reimplement it, move that exact
   * node into the concierge tab and switch it to the plugin's own inline
   * variant. If the plugin is absent the tab simply stays hidden.
   */
  (function adoptConcierge() {
    var mcc = document.querySelector('.toiaf-mcc');
    if (!mcc) return;
    mcc.classList.remove('toiaf-mcc--floating');
    mcc.classList.add('toiaf-mcc--inline');
    dock.querySelector('[data-pane="concierge"]').appendChild(mcc);
    dock.querySelector('[data-tab="concierge"]').hidden = false;
  })();

  /* ----------------------------------------------------------------- tabs */

  function selectTab(name) {
    tabs.forEach(function (t) {
      t.setAttribute('aria-selected', String(t.dataset.tab === name));
    });
    dock.querySelectorAll('.toiaf-dock__pane').forEach(function (p) {
      if (p.dataset.pane === name) p.setAttribute('data-active', '');
      else p.removeAttribute('data-active');
    });
    dock.classList.remove('is-thread');
    store(STORE_TAB, name);
    if (name === 'activity' || name === 'messages') markSeen(name);
  }

  tabs.forEach(function (t) {
    t.addEventListener('click', function () { selectTab(t.dataset.tab); });
  });

  backBtn.addEventListener('click', function () { selectTab('messages'); });

  /* ------------------------------------------------------------ open/close */

  function setOpen(open) {
    dock.classList.toggle('is-open', open);
    launcher.setAttribute('aria-expanded', String(open));
    if (!open) return;

    // Prefer the tab that actually has something waiting.
    var stored = store(STORE_TAB);
    var want = stored;
    if (unread.messages > 0) want = 'messages';
    else if (unread.activity > 0) want = 'activity';
    if (!want) want = 'activity';

    var target = dock.querySelector('.toiaf-dock__tab[data-tab="' + want + '"]');
    if (!target || target.hidden || target.offsetParent === null) want = 'activity';
    selectTab(want);
    load();
  }

  launcher.addEventListener('click', function () { setOpen(true); });
  dock.querySelector('[data-dock-close]').addEventListener('click', function () { setOpen(false); });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dock.classList.contains('is-open')) setOpen(false);
  });

  /* ---------------------------------------------------------------- counts */

  var unread = { messages: 0, activity: 0 };

  function paintCounts() {
    var total = (unread.messages || 0) + (unread.activity || 0);

    totalCount.textContent = total > 99 ? '99+' : String(total || '');
    totalCount.hidden = total === 0;
    dock.classList.toggle('has-unread', total > 0);

    tabs.forEach(function (t) {
      var badge = t.querySelector('.toiaf-dock__tab-count');
      if (!badge) return;
      var n = unread[t.dataset.tab] || 0;
      badge.textContent = n > 99 ? '99+' : String(n || '');
      badge.hidden = n === 0;
    });

    // Keep the browser tab in sync — a creator usually has TOIAF in a
    // background tab, which is exactly when this matters.
    if (CFG.syncTitle !== false) {
      var base = document.title.replace(/^\(\d+\+?\)\s*/, '');
      document.title = total > 0 ? '(' + (total > 99 ? '99+' : total) + ') ' + base : base;
    }
  }

  function markSeen(scope) {
    if (!unread[scope]) return;
    unread[scope] = 0;
    paintCounts();
    fetch(REST + '/seen', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': CFG.nonce || '' },
      body: JSON.stringify({ scope: scope })
    }).catch(function () { /* a failed ack just means it reappears next poll */ });
  }

  /* ----------------------------------------------------------------- render */

  function emptyState(icon, title, body) {
    var wrap = el('div', 'toiaf-dock__empty');
    wrap.appendChild(el('div', 'toiaf-dock__empty-icon', icon));
    wrap.appendChild(el('div', 'toiaf-dock__empty-title', title));
    wrap.appendChild(el('p', 'toiaf-dock__empty-body', body));
    return wrap;
  }

  function renderActivity(items) {
    var scroll = dock.querySelector('[data-pane="activity"] .toiaf-dock__scroll');
    scroll.replaceChildren();

    if (!items || !items.length) {
      scroll.appendChild(emptyState('✨', 'All caught up',
        'Tips, unlocks, subscribers and bookings land here.'));
      return;
    }

    var bucket = null;
    items.forEach(function (n) {
      var b = dayBucket(n.ts);
      if (b !== bucket) {
        bucket = b;
        scroll.appendChild(el('div', 'toiaf-dock__group', b));
      }

      var meta = KINDS[n.kind] || KINDS.system;
      var row = el(n.url ? 'a' : 'div', 'toiaf-dock__note' + (n.unread ? ' is-unread' : ''));
      if (n.url) row.href = n.url;
      row.setAttribute('data-kind', n.kind || 'system');
      if (n.priority) row.setAttribute('data-priority', n.priority);

      row.appendChild(el('span', 'toiaf-dock__note-icon', meta.icon));

      var text = el('span', 'toiaf-dock__note-text');
      text.appendChild(el('span', 'toiaf-dock__note-title', n.title || ''));
      if (n.body) text.appendChild(el('span', 'toiaf-dock__note-body', n.body));
      row.appendChild(text);

      var side = el('span');
      if (meta.money && n.amount != null) {
        side.className = 'toiaf-dock__note-amount';
        side.textContent = '+' + n.amount + ' ' + CURRENCY;
      } else {
        side.className = 'toiaf-dock__note-time';
        side.textContent = ago(n.ts);
      }
      row.appendChild(side);

      scroll.appendChild(row);
    });
  }

  function renderConversations(items) {
    var scroll = dock.querySelector('[data-pane="messages"] .toiaf-dock__scroll');
    scroll.replaceChildren();

    if (!items || !items.length) {
      scroll.appendChild(emptyState('💬', 'No messages yet',
        'New conversations show up here as they arrive.'));
      return;
    }

    items.forEach(function (c) {
      var row = el('a', 'toiaf-dock__conv' + (c.unread ? ' is-unread' : ''));
      row.href = c.url || (CFG.messagesUrl || '#');
      if (c.presence) row.setAttribute('data-presence', c.presence);

      var av = el('span', 'toiaf-dock__avatar');
      if (c.avatar) {
        var img = new Image();
        img.src = c.avatar;
        img.alt = '';
        img.loading = 'lazy';
        av.appendChild(img);
      }
      row.appendChild(av);

      var text = el('span', 'toiaf-dock__conv-text');
      text.appendChild(el('span', 'toiaf-dock__conv-name', c.name || ''));
      text.appendChild(el('span', 'toiaf-dock__conv-preview', c.preview || ''));
      row.appendChild(text);

      row.appendChild(el('span', 'toiaf-dock__note-time', c.ts ? ago(c.ts) : ''));
      scroll.appendChild(row);
    });
  }

  /* ------------------------------------------------------------------ load */

  var loading = false;

  function load() {
    if (loading) return;
    loading = true;

    fetch(REST + '/feed', {
      credentials: 'same-origin',
      headers: { 'X-WP-Nonce': CFG.nonce || '' }
    })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (data) {
        loading = false;
        if (data.unread) {
          unread.messages = Number(data.unread.messages) || 0;
          unread.activity = Number(data.unread.activity) || 0;
          paintCounts();
        }
        renderActivity(data.notifications);
        renderConversations(data.conversations);
      })
      .catch(function () {
        loading = false;
        var scroll = dock.querySelector('[data-pane="activity"] .toiaf-dock__scroll');
        if (scroll && !scroll.querySelector('.toiaf-dock__note')) {
          scroll.replaceChildren(emptyState('⚠', 'Could not load',
            'Check back in a moment.'));
        }
      });
  }

  /* ------------------------------------------------- live toast adoption */

  /*
   * toiaf-ux-notification-center fires transient toasts into a fixed stack
   * and they vanish. Watching that stack means a toast also bumps the dock,
   * so nothing is missed just because someone looked away — which is the
   * whole point of giving notifications a durable home.
   */
  (function watchToasts() {
    var stack = document.getElementById('toiaf-ux-notify-stack');
    if (!stack || !window.MutationObserver) return;

    new MutationObserver(function (records) {
      var added = records.some(function (r) {
        return Array.prototype.some.call(r.addedNodes, function (n) {
          return n.nodeType === 1 && n.classList.contains('toiaf-ux-toast');
        });
      });
      if (!added) return;

      unread.activity += 1;
      paintCounts();
      if (dock.classList.contains('is-open')) load();
    }).observe(stack, { childList: true });
  })();

  /* ----------------------------------------------------------------- poll */

  var every = Number(CFG.pollSeconds);
  if (!isFinite(every)) every = 60;

  if (every > 0) {
    setInterval(function () {
      // Don't poll a tab nobody is looking at.
      if (document.hidden) return;
      load();
    }, Math.max(20, every) * 1000);
  }

  // Prime the counts without opening anything.
  load();
})();
