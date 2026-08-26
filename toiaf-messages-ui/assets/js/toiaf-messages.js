/*!
 * TOIAF Network — Messages UI behaviour
 *
 * Progressive enhancement only. Every feature here degrades to the plain
 * form-POST page if JS is unavailable:
 *   - the paywall <button> stays inside a real <form> that posts to the
 *     server-rendered unlock handler,
 *   - date chips and message grouping are purely cosmetic,
 *   - the composer submits normally.
 *
 * Config is injected by wp_localize_script as window.TOIAF_MESSAGES:
 *   { restUrl, nonce, currency, topupUrl, balance, locale }
 */
(function () {
  'use strict';

  var CFG = window.TOIAF_MESSAGES || {};
  var CURRENCY = CFG.currency || 'TP';
  var page = document.querySelector('.toiaf-messages-page');
  if (!page) return;

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------------------------------------------------------- utils */

  function fmt(n) {
    var v = Number(n);
    if (!isFinite(v)) return '0';
    // TP is whole-number in the UI; keep decimals only when they exist
    return v % 1 === 0 ? String(v) : v.toFixed(2);
  }

  function on(root, type, selector, handler) {
    root.addEventListener(type, function (e) {
      var el = e.target.closest(selector);
      if (el && root.contains(el)) handler(e, el);
    });
  }

  /* ------------------------------------------------------------- balances */

  var balance = Number(CFG.balance);
  if (!isFinite(balance)) balance = null;

  function paintBalance() {
    if (balance === null) return;

    page.querySelectorAll('.tnm-wallet-chip__amount').forEach(function (el) {
      el.textContent = fmt(balance);
    });

    page.querySelectorAll('.tnm-paywall').forEach(function (card) {
      var state = card.getAttribute('data-state');
      if (state === 'unlocked' || state === 'own' || state === 'unlocking') return;

      card.setAttribute('data-balance', String(balance));

      var price = Number(card.getAttribute('data-price')) || 0;
      var short = balance < price;
      card.setAttribute('data-state', short ? 'insufficient' : 'locked');

      var bal = card.querySelector('.tnm-paywall__balance b');
      if (bal) bal.textContent = fmt(balance) + ' ' + CURRENCY;

      var cta = card.querySelector('.tnm-paywall__cta');
      if (cta) {
        if (short) {
          cta.textContent = 'GET ' + CURRENCY;
          cta.dataset.action = 'topup';
        } else {
          cta.textContent = 'UNLOCK FOR ' + fmt(price) + ' ' + CURRENCY;
          cta.dataset.action = 'unlock';
        }
      }
    });
  }

  /* -------------------------------------------------------------- paywall */

  function setStatus(card, text, isError) {
    var el = card.querySelector('.tnm-paywall__status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-error', !!isError);
  }

  /**
   * Reveal unlocked media in place. `media` comes from the server so the
   * signed URL is never guessable from the locked card.
   */
  function reveal(card, media) {
    card.setAttribute('data-state', 'unlocked');
    setStatus(card, '');

    var frame = card.querySelector('.tnm-paywall__media');
    if (!frame || !media || !media.url) return;

    var node;
    if (media.type === 'video') {
      node = document.createElement('video');
      node.src = media.url;
      node.controls = true;
      node.playsInline = true;
      node.preload = 'metadata';
      if (media.poster) node.poster = media.poster;
    } else {
      node = document.createElement('img');
      node.src = media.url;
      node.alt = media.alt || 'Unlocked content';
      node.decoding = 'async';
    }
    node.className = 'tnm-paywall__blur';

    // Swap only once the real asset is ready, so the blur never flashes empty
    var swap = function () {
      frame.replaceChildren(node);
      if (media.caption) {
        var cap = document.createElement('figcaption');
        cap.textContent = media.caption;
        frame.appendChild(cap);
      }
    };

    if (node.tagName === 'IMG') {
      node.addEventListener('load', swap, { once: true });
      node.addEventListener('error', swap, { once: true });
    } else {
      node.addEventListener('loadedmetadata', swap, { once: true });
      node.addEventListener('error', swap, { once: true });
    }

    // Announce for screen readers
    var live = card.querySelector('.tnm-paywall__status');
    if (live) live.textContent = 'Unlocked.';
  }

  function unlock(card) {
    if (card.getAttribute('data-state') === 'unlocking') return;

    var id = card.getAttribute('data-message-id');
    var price = Number(card.getAttribute('data-price')) || 0;
    if (!id || !CFG.restUrl) return false; // let the <form> post normally

    var cta = card.querySelector('.tnm-paywall__cta');
    var prev = cta ? cta.textContent : '';

    card.setAttribute('data-state', 'unlocking');
    if (cta) { cta.disabled = true; cta.textContent = 'UNLOCKING'; }
    setStatus(card, '');

    fetch(CFG.restUrl.replace(/\/$/, '') + '/unlock', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-WP-Nonce': CFG.nonce || ''
      },
      body: JSON.stringify({ message_id: id })
    })
      .then(function (res) {
        return res.json().then(function (data) {
          return { ok: res.ok, status: res.status, data: data || {} };
        });
      })
      .then(function (r) {
        if (cta) { cta.disabled = false; cta.textContent = prev; }

        if (r.ok && r.data.ok) {
          if (typeof r.data.balance !== 'undefined') balance = Number(r.data.balance);
          reveal(card, r.data.media);
          paintBalance();
          markThreadPaid(card);
          return;
        }

        if (r.data.code === 'insufficient_funds') {
          if (typeof r.data.balance !== 'undefined') balance = Number(r.data.balance);
          card.setAttribute('data-state', 'insufficient');
          paintBalance();
          setStatus(card, 'You need ' + fmt(price - balance) + ' more ' + CURRENCY + '.', true);
          return;
        }

        card.setAttribute('data-state', 'error');
        setStatus(card, r.data.message || 'Could not unlock. Try again.', true);
      })
      .catch(function () {
        if (cta) { cta.disabled = false; cta.textContent = prev; }
        card.setAttribute('data-state', 'error');
        setStatus(card, 'Network error. Try again.', true);
      });

    return true;
  }

  function markThreadPaid(card) {
    var msg = card.closest('.tnm-message');
    if (!msg) return;
    msg.classList.remove('is-locked');

    // The bubble's own badge still reads "locked" until we say otherwise.
    var flag = msg.querySelector('.tnm-message-lock-flag');
    if (flag) {
      flag.textContent = '\uD83D\uDD13 ' + (CFG.unlockedLabel || 'UNLOCKED');
      flag.classList.add('is-unlocked');
    }
  }

  on(page, 'click', '.tnm-paywall__cta', function (e, cta) {
    var card = cta.closest('.tnm-paywall');
    if (!card) return;

    if (cta.dataset.action === 'topup') {
      if (CFG.topupUrl) { window.location.href = CFG.topupUrl; e.preventDefault(); }
      return; // otherwise it is a real <a href> — let it through
    }

    // Only swallow the event if we actually took over the request
    if (unlock(card)) e.preventDefault();
  });

  /* ------------------------------------------- date chips + msg grouping */

  function dayKey(d) { return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }

  function dayLabel(d) {
    var today = new Date();
    var yest = new Date();
    yest.setDate(today.getDate() - 1);
    if (dayKey(d) === dayKey(today)) return 'Today';
    if (dayKey(d) === dayKey(yest)) return 'Yesterday';
    return d.toLocaleDateString(CFG.locale || undefined, {
      month: 'short', day: 'numeric',
      year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric'
    });
  }

  function decorate(list) {
    if (!list) return;

    // Clear anything we added on a previous pass
    list.querySelectorAll('.tnm-date-chip[data-auto]').forEach(function (n) { n.remove(); });

    var msgs = Array.prototype.slice.call(list.querySelectorAll('.tnm-message'));
    var lastDay = null;
    var lastSide = null;

    msgs.forEach(function (msg, i) {
      var side = msg.classList.contains('tnm-outgoing') ? 'out' : 'in';

      // Date separator — needs a machine-readable timestamp on the message
      var ts = msg.getAttribute('data-ts');
      if (ts) {
        var d = new Date(isNaN(ts) ? ts : Number(ts) * 1000);
        if (!isNaN(d.getTime())) {
          var key = dayKey(d);
          if (key !== lastDay) {
            var chip = document.createElement('div');
            chip.className = 'tnm-date-chip';
            chip.setAttribute('data-auto', '1');
            chip.textContent = dayLabel(d);
            list.insertBefore(chip, msg);
            lastDay = key;
            lastSide = null; // a new day always starts a new group
          }
        }
      }

      // Grouping
      var next = msgs[i + 1];
      var nextSide = next ? (next.classList.contains('tnm-outgoing') ? 'out' : 'in') : null;

      msg.classList.toggle('is-group-start', side !== lastSide);
      msg.classList.toggle('is-group-end', side !== nextSide);

      lastSide = side;
    });
  }

  function scrollToLatest(list, smooth) {
    if (!list) return;
    list.scrollTo({ top: list.scrollHeight, behavior: smooth && !reduceMotion ? 'smooth' : 'auto' });
  }

  var msgList = page.querySelector('.tnm-thread-messages');
  decorate(msgList);
  scrollToLatest(msgList, false);

  /* ------------------------------------------------------------- composer */

  var compose = page.querySelector('.tnm-thread-compose');
  if (compose) {
    var ta = compose.querySelector('.tnm-compose-textarea');
    var counter = compose.querySelector('.tnm-char-count');
    var sendBtn = compose.querySelector('.tnm-send-button');
    var tray = compose.querySelector('.tnm-compose-tray');
    var toggle = compose.querySelector('[data-tnm-tool-toggle]');
    var offer = compose.querySelector('.tnm-paid-offer');
    var priceInput = compose.querySelector('.tnm-cost-input input');

    var autosize = function () {
      if (!ta) return;
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 168) + 'px';
    };

    var hasAttachment = function () {
      return Array.prototype.some.call(
        compose.querySelectorAll('input[type="file"]'),
        function (input) { return input.files && input.files.length > 0; }
      );
    };

    var hasPrice = function () {
      return !!priceInput && Number(priceInput.value) > 0;
    };

    var sync = function () {
      if (!ta) return;
      var len = ta.value.trim().length;
      var max = Number(ta.getAttribute('maxlength')) || 1000;
      if (counter) {
        counter.textContent = ta.value.length + '/' + max;
        counter.classList.toggle('is-near', ta.value.length > max * 0.9);
      }
      // Media-only and price-only sends are both legitimate, so only an
      // entirely empty composer disables SEND.
      if (sendBtn) sendBtn.disabled = len === 0 && !hasAttachment() && !hasPrice();
      autosize();
    };

    compose.addEventListener('change', function (e) {
      if (e.target && e.target.type === 'file') sync();
    });

    if (ta) {
      ta.addEventListener('input', sync);
      // Enter sends, Shift+Enter newlines — Telegram's default on desktop
      ta.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(min-width: 900px)').matches) {
          e.preventDefault();
          if (compose.requestSubmit) compose.requestSubmit();
          else compose.submit();
        }
      });
      sync();
    }

    if (toggle && tray) {
      toggle.addEventListener('click', function () {
        var open = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', String(!open));
        tray.hidden = open;
      });
    }

    // Price control: showing the offer strip is what makes the send "paid"
    on(compose, 'click', '.tnm-price-btn', function () {
      if (!offer) return;
      offer.hidden = false;
      compose.classList.toggle('is-paid', !priceInput || Number(priceInput.value) > 0);
      if (priceInput) priceInput.focus();
      sync();
    });

    on(compose, 'click', '.tnm-paid-clear', function () {
      if (!offer) return;
      offer.hidden = true;
      compose.classList.remove('is-paid');
      if (priceInput) priceInput.value = '';
      sync();
    });

    if (priceInput) {
      priceInput.addEventListener('input', function () {
        var v = Number(priceInput.value);
        compose.classList.toggle('is-paid', isFinite(v) && v > 0);
        sync();
      });
    }
  }

  /* --------------------------------------------------------- mobile panes */

  var mq = window.matchMedia('(max-width: 900px)');

  function syncPanes() {
    if (!mq.matches) { page.classList.remove('is-thread-open'); return; }
    // A thread is "open" when the URL names one, matching the ?with= routing
    var hasThread = /[?&]with=\d+/.test(window.location.search);
    page.classList.toggle('is-thread-open', hasThread);
  }
  syncPanes();
  mq.addEventListener('change', syncPanes);

  on(page, 'click', '.tnm-inbox-jump', function (e, el) {
    if (!mq.matches) return;
    // Stay on the page; just swap panes
    if (el.getAttribute('href') && el.getAttribute('href').indexOf('#') !== -1) {
      e.preventDefault();
      page.classList.remove('is-thread-open');
    }
  });

  /* ---------------------------------------------------------- conv search */

  var search = page.querySelector('.tnm-conv-search');
  if (search) {
    search.addEventListener('input', function () {
      var q = search.value.trim().toLowerCase();
      page.querySelectorAll('.tnm-conversation').forEach(function (li) {
        var name = (li.querySelector('.tnm-name') || {}).textContent || '';
        li.hidden = q.length > 0 && name.toLowerCase().indexOf(q) === -1;
      });
    });
  }

  /* ------------------------------------------------------ full-bleed nav */

  /*
   * The left nav is useful but not while you are reading a thread. Inject a
   * toggle rather than touching the template, and remember the choice.
   * Storage can throw outright in some contexts, so every access is guarded
   * and the default (nav visible) survives a failure.
   */
  (function navToggle() {
    var header = page.querySelector('.toiaf-messages-header');
    var shell = document.getElementById('toiaf-app-shell');
    if (!header || !shell || !document.getElementById('toiaf-leftnav')) return;

    var KEY = 'toiaf:messages:nav-collapsed';

    var read = function () {
      try { return window.localStorage.getItem(KEY) === '1'; } catch (e) { return false; }
    };
    var write = function (v) {
      try { window.localStorage.setItem(KEY, v ? '1' : '0'); } catch (e) { /* private mode */ }
    };

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tnm-nav-toggle';
    btn.innerHTML =
      '<svg viewBox="0 0 15 15" aria-hidden="true">' +
      '<rect class="tnm-nav-toggle__rail" x="0" y="1" width="4" height="13" rx="1"></rect>' +
      '<rect x="6" y="1" width="9" height="13" rx="1" opacity=".45"></rect>' +
      '</svg>';

    var apply = function (collapsed) {
      document.body.classList.toggle('tnm-nav-collapsed', collapsed);
      btn.setAttribute('aria-pressed', String(collapsed));
      btn.setAttribute('aria-label', collapsed ? 'Show navigation' : 'Hide navigation');
      btn.title = collapsed ? 'Show navigation' : 'Hide navigation';
    };

    apply(read());
    header.insertBefore(btn, header.firstChild);

    btn.addEventListener('click', function () {
      var next = !document.body.classList.contains('tnm-nav-collapsed');
      apply(next);
      write(next);
    });
  })();

  paintBalance();
})();
