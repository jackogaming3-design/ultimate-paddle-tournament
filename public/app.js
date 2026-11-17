/* Ultimate Paddle Tournament — front end (no build step, plain JS). */
(() => {
  'use strict';

  // ---------- tiny utils ----------
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LS = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
  const app = $('#app');
  const modalRoot = $('#modal-root');
  const splashRoot = $('#splash-root');

  function setHTML(el, html) {
    if (!el || el.__html === html) return false;
    // Don't yank an input out from under someone who's typing in it.
    const a = document.activeElement;
    if (a && a !== document.body && el.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName) && a.type !== 'file') return false;
    el.innerHTML = html;
    el.__html = html;
    return true;
  }

  let toastTimer;
  function toast(msg, bad = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = bad ? 'bad' : ''; }, 2800);
  }

  // ---------- routing ----------
  function parseRoute() {
    const m = location.pathname.match(/^\/t\/([a-z0-9]+)(?:\/(tv|admin))?\/?$/);
    if (m) return { view: m[2] === 'tv' ? 'tv' : 'event', id: m[1], wantAdmin: m[2] === 'admin' };
    return { view: 'home' };
  }
  let route = parseRoute();
  function go(path) { history.pushState({}, '', path); boot(); }
  window.addEventListener('popstate', boot);

  // ---------- identity ----------
  const adminKey = (id) => 'upt:admin:' + id;
  const meKey = (id) => 'upt:me:' + id;
  const adminTok = () => route.id && LS.get(adminKey(route.id));
  const me = () => route.id && LS.get(meKey(route.id));
  const isAdmin = () => !!adminTok();

  async function api(method, url, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (adminTok()) headers['x-admin-token'] = adminTok();
    if (me()?.token) headers['x-player-token'] = me().token;
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 204) return null;
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) {
      if (res.status === 401 && /PIN/.test(data.error || '') && route.id) LS.del(adminKey(route.id));
      throw new Error(data.error || 'Something went wrong');
    }
    return data;
  }

  // ---------- formatting ----------
  const photo = (p) => (p ? `/api/photo/${p.id}?v=${p.photoV || 0}` : '');
  function fmtDate(d) {
    if (!d) return '';
    const dt = new Date(d + 'T00:00:00');
    return dt.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
  }
  function fmtTime(t) {
    if (!t) return '';
    const [h, m] = t.split(':').map(Number);
    const ap = h >= 12 ? 'pm' : 'am';
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${ap}`;
  }
  const fmtLabel = (t) => (t.format === 'mexicano' ? 'Mexicano' : 'Americano');
  const ptsLabel = (t) => (t.scoring === 'time' ? 'Timed' : `${t.points} pts`);

  // ---------- state ----------
  let S = null; // latest state payload
  let pollTimer = null;
  let lastStatus = null;
  let seenRounds = null;
  const ui = {
    tab: null,
    viewRound: null, // index being viewed on courts tab (null = latest)
    draft: { name: '', photo: null },
    other: { name: '', photo: null },
    setup: null, // admin start settings
    joining: false,
  };

  const P = () => Object.fromEntries((S?.t.players || []).map((p) => [p.id, p]));
  const ST = () => Object.fromEntries((S?.standings || []).map((s) => [s.id, s]));

  // ---------- boot ----------
  function boot() {
    route = parseRoute();
    clearInterval(pollTimer);
    S = null; lastStatus = null; seenRounds = null; ui.tab = null; ui.viewRound = null; ui.setup = null;
    closeModal();
    app.__html = null; app.__shell = false; app.__tv = false;
    if (route.view === 'home') return renderHome();
    app.innerHTML = '<div class="spin"></div>';
    app.__html = null;
    poll(true);
    pollTimer = setInterval(() => { if (!document.hidden) poll(); }, 2500);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && route.id) poll(); });

  async function poll(first = false) {
    try {
      const data = await api('GET', `/api/t/${route.id}/state?v=${S && !first ? S.version : ''}`);
      if (!data) return;
      const prev = S;
      S = data;
      onState(prev);
    } catch (e) {
      if (first) {
        app.innerHTML = `<div class="wrap">${topBar()}<div class="card center" style="margin-top:40px"><h2>Couldn't find that tournament</h2><p class="muted">${esc(e.message)}</p><a class="btn primary" href="/">Start a new one</a></div></div>`;
        clearInterval(pollTimer);
      }
    }
  }

  function onState(prev) {
    const t = S.t;
    // remember for "your tournaments"
    if (isAdmin()) {
      const mine = (LS.get('upt:mine') || []).filter((x) => x.id !== t.id);
      mine.unshift({ id: t.id, name: t.name, date: t.date });
      LS.set('upt:mine', mine.slice(0, 12));
    }
    if (route.wantAdmin && !isAdmin()) { route.wantAdmin = false; openPin(); }
    // if my player record was removed, forget it
    if (me() && !t.players.some((p) => p.id === me().id)) LS.del(meKey(t.id));

    if (!ui.tab || lastStatus !== t.status) ui.tab = t.status === 'live' ? 'courts' : t.status === 'finished' ? 'podium' : 'squad';

    // new round splash
    if (seenRounds !== null && t.rounds.length > seenRounds && t.status === 'live') {
      ui.viewRound = null;
      ui.tab = 'courts';
      showSplash(t.rounds[t.rounds.length - 1]);
    }
    // just finished
    if (lastStatus === 'live' && t.status === 'finished') setTimeout(() => confetti(260), 300);
    seenRounds = t.rounds.length;
    lastStatus = t.status;
    render(prev);
  }

  // ---------- shared bits ----------
  function topBar(extra = '') {
    return `<header class="top">
      <a class="brand" href="/"><img src="/icon.svg" alt=""><span>Ultimate <em>Paddle</em><br>Tournament</span></a>
      <div class="top-actions">${extra}</div>
    </header>`;
  }

  function img(p, cls = 'av') {
    if (!p) return `<span class="${cls}"></span>`;
    return `<img class="${cls}" src="${photo(p)}" alt="${esc(p.name)}" loading="lazy">`;
  }

  function streakTag(s) {
    if (!s) return '';
    if (s.streak >= 3) return `<span class="tag hot" title="${s.streak} wins in a row">🔥 ${s.streak}</span>`;
    if (s.streak <= -3) return `<span class="tag cold" title="${-s.streak} losses in a row">🥶</span>`;
    return '';
  }

  function formDots(s) {
    const f = (s?.form || []).slice(-5);
    if (!f.length) return '';
    return `<span class="form-dots">${f.map((o) => `<i class="${o}"></i>`).join('')}</span>`;
  }

  // ---------- HOME ----------
  function renderHome() {
    const mine = LS.get('upt:mine') || [];
    const today = new Date();
    const d = new Date(today.getTime() + 2 * 864e5);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const f = ui.create || (ui.create = { name: '', date: iso, time: '18:00', durationMins: 120, venue: '', courts: 2, points: 24, scoring: 'points', format: 'americano', pin: '' });
    app.innerHTML = `<div class="wrap">
      ${topBar()}
      <section class="home-hero">
        <span class="kicker">🎾 Americano · Mexicano</span>
        <h1 class="mega">Ultimate<br><span class="ball">Paddle</span><br>Tournament</h1>
        <p class="lede">Send one link. Everyone taps <b>I'm in</b> with their name and a photo. Hit begin and the app does the draw, the ladder and the bragging rights.</p>
        <div class="feature-row"><span>📸 Photo cards</span><span>🔀 Smart rotation</span><span>📈 Live ladder</span><span>🔥 Hot streaks</span><span>🏆 Awards</span><span>📺 TV mode</span><span>📅 Add to calendar</span></div>
      </section>
      <form class="card form" id="create">
        <div class="section-h" style="margin:0 0 4px"><h2>New tournament</h2></div>
        <div class="field"><label>Name</label><input class="input" name="name" maxlength="60" placeholder="Sunday Smash" value="${esc(f.name)}"></div>
        <div class="grid2">
          <div class="field"><label>Date</label><input class="input" type="date" name="date" value="${esc(f.date)}" required></div>
          <div class="field"><label>Start time</label><input class="input" type="time" name="time" value="${esc(f.time)}" required></div>
        </div>
        <div class="grid2">
          <div class="field"><label>Venue</label><input class="input" name="venue" maxlength="120" placeholder="e.g. Padel Adelaide" value="${esc(f.venue)}"></div>
          <div class="field"><label>How long</label>
            <div class="seg" data-seg="durationMins">${[[90, '1.5h'], [120, '2h'], [150, '2.5h'], [180, '3h']].map(([v, l]) => `<button type="button" data-v="${v}" class="${f.durationMins === v ? 'on' : ''}">${l}</button>`).join('')}</div>
          </div>
        </div>
        <div class="grid2">
          <div class="field"><label>Format</label>
            <div class="seg" data-seg="format"><button type="button" data-v="americano" class="${f.format === 'americano' ? 'on' : ''}">Americano</button><button type="button" data-v="mexicano" class="${f.format === 'mexicano' ? 'on' : ''}">Mexicano</button></div>
            <p class="hint">${f.format === 'mexicano' ? 'Round 1 random, then teams are made from the ladder: 1st + 4th vs 2nd + 3rd.' : 'New partner every round, as fair a mix as possible.'}</p>
          </div>
          <div class="field"><label>Points per match</label>
            <div class="seg" data-seg="points">${[16, 21, 24, 32].map((v) => `<button type="button" data-v="${v}" class="${f.scoring === 'points' && f.points === v ? 'on' : ''}">${v}</button>`).join('')}<button type="button" data-v="time" class="${f.scoring === 'time' ? 'on' : ''}">⏱</button></div>
          </div>
        </div>
        <div class="grid2">
          <div class="field"><label>Courts</label>
            <div class="stepper"><button type="button" data-step="-1">−</button><output>${f.courts}</output><button type="button" data-step="1">+</button></div>
          </div>
          <div class="field"><label>Organiser PIN</label><input class="input" name="pin" inputmode="numeric" pattern="\\d{4,8}" maxlength="8" placeholder="4+ digits" value="${esc(f.pin)}" required>
            <p class="hint">Only the PIN holder can start it and enter scores.</p></div>
        </div>
        <button class="btn primary huge" type="submit">Create tournament</button>
        <p class="err" id="create-err"></p>
      </form>
      ${mine.length ? `<div class="section-h"><h2>Your tournaments</h2></div>
        <div class="card" style="padding:8px">${mine.map((m) => `<a class="row" style="padding:12px;text-decoration:none" href="/t/${esc(m.id)}"><b class="grow">${esc(m.name)}</b><span class="muted">${esc(fmtDate(m.date))}</span><span>→</span></a>`).join('')}</div>` : ''}
    </div>`;
    const form = $('#create');
    form.addEventListener('input', (e) => { if (e.target.name) f[e.target.name] = e.target.value; });
    form.addEventListener('click', (e) => {
      const segBtn = e.target.closest('.seg button');
      if (segBtn) {
        const key = segBtn.parentElement.dataset.seg;
        const v = segBtn.dataset.v;
        if (key === 'points') { if (v === 'time') f.scoring = 'time'; else { f.scoring = 'points'; f.points = +v; } }
        else if (key === 'durationMins') f.durationMins = +v;
        else f[key] = v;
        return renderHome();
      }
      const st = e.target.closest('[data-step]');
      if (st) { f.courts = Math.max(1, Math.min(12, f.courts + +st.dataset.step)); return renderHome(); }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true;
      try {
        const startUtc = f.date && f.time ? new Date(`${f.date}T${f.time}`).toISOString() : null;
        const body = { ...f, name: f.name || 'Ultimate Paddle Tournament', startUtc, createCode: LS.get('upt:create') || '' };
        let out;
        try { out = await api('POST', '/api/t', body); } catch (err) {
          if (!/create code/i.test(err.message)) throw err;
          const c = prompt('Enter the create code to make a tournament');
          if (!c) throw err;
          LS.set('upt:create', c);
          out = await api('POST', '/api/t', { ...body, createCode: c });
        }
        LS.set(adminKey(out.id), out.adminToken);
        ui.create = null;
        go(`/t/${out.id}`);
      } catch (err) {
        $('#create-err').textContent = err.message;
        btn.disabled = false;
      }
    });
  }

  // ---------- EVENT PAGE ----------
  function render(prev) {
    if (route.view === 'tv') return renderTV(prev);
    const t = S.t;
    if (!app.__shell) {
      app.innerHTML = `<div class="wrap">
        <div id="r-top"></div>
        <div id="r-hero"></div>
        <div id="r-tabs"></div>
        <div id="r-main"></div>
      </div>`;
      app.__shell = true;
      app.__html = null;
    }
    setHTML($('#r-top'), topBar(`
      <a class="chip-btn" href="/t/${t.id}/tv" target="_blank" rel="noopener">📺 TV</a>
      ${isAdmin() ? '<button class="chip-btn on" data-act="lock">🔓 Organiser</button>' : '<button class="chip-btn" data-act="unlock">🔒 Organiser</button>'}`));
    setHTML($('#r-hero'), heroHTML());
    setHTML($('#r-tabs'), tabsHTML());
    renderMain(prev);
  }

  function heroHTML() {
    const t = S.t;
    const active = t.players.filter((p) => p.active);
    const lastRound = t.rounds[t.rounds.length - 1];
    const status = t.status === 'live'
      ? `<span class="badge live"><i></i>Live · Round ${lastRound ? lastRound.n : 1}</span>`
      : t.status === 'finished' ? '<span class="badge done">🏆 Final</span>' : '<span class="badge">Taking names</span>';
    const venue = t.venue ? `<a href="https://maps.google.com/?q=${encodeURIComponent(t.venue)}" target="_blank" rel="noopener">📍 ${esc(t.venue)}</a>` : '';
    const stack = active.slice(0, 7).map((p) => `<img src="${photo(p)}" alt="">`).join('') + (active.length > 7 ? `<span class="more">+${active.length - 7}</span>` : '');
    return `<section class="hero">
      <div class="badges">${status}<span class="badge">${fmtLabel(t)}</span><span class="badge">${ptsLabel(t)}</span></div>
      <h1>${esc(t.name)}</h1>
      <div class="meta">${t.date ? `<span>📅 ${esc(fmtDate(t.date))}</span>` : ''}${t.time ? `<span>⏰ ${esc(fmtTime(t.time))}</span>` : ''}${venue}</div>
      <div class="hero-foot">
        <div class="count"><b>${active.length}</b><span>player${active.length === 1 ? '' : 's'}<br>in</span><div class="avstack" style="margin-left:14px">${stack}</div></div>
        ${t.startUtc && t.status !== 'finished' ? calendarButtons() : ''}
      </div>
    </section>`;
  }

  function gcalLink() {
    const t = S.t;
    const s = new Date(t.startUtc);
    const e = new Date(s.getTime() + (t.durationMins || 120) * 60000);
    const f = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const q = new URLSearchParams({
      action: 'TEMPLATE', text: `🎾 ${t.name}`, dates: `${f(s)}/${f(e)}`,
      details: `${fmtLabel(t)} padel, ${ptsLabel(t)}. Live ladder: ${location.origin}/t/${t.id}`, location: t.venue || '',
    });
    return `https://calendar.google.com/calendar/render?${q}`;
  }
  function calendarButtons() {
    return `<div class="row">
      <a class="btn small" href="/t/${S.t.id}/event.ics">📅 Apple / Outlook</a>
      <a class="btn small" href="${esc(gcalLink())}" target="_blank" rel="noopener">📅 Google</a>
    </div>`;
  }

  function tabsHTML() {
    const t = S.t;
    let tabs;
    if (t.status === 'lobby') return '';
    if (t.status === 'live') tabs = [['courts', '🎾 Courts'], ['ladder', '📈 Ladder'], ['stats', '🏆 Stats'], ['squad', '👥 Squad']];
    else tabs = [['podium', '🏆 Podium'], ['ladder', '📈 Ladder'], ['stats', '📊 Stats'], ['courts', '🎾 Results']];
    return `<nav class="tabs"><div class="seg" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-tab="${k}" class="${ui.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div></nav>`;
  }

  function renderMain(prev) {
    const main = $('#r-main');
    const t = S.t;
    if (t.status === 'lobby') return renderLobby(main);
    if (main.dataset.tab !== ui.tab || main.dataset.status !== t.status) {
      main.dataset.tab = ui.tab; main.dataset.status = t.status;
      main.innerHTML = ''; main.__html = null;
    }
    let html = '';
    if (ui.tab === 'courts') html = courtsHTML();
    else if (ui.tab === 'ladder') html = `<div class="section-h"><h2>Live ladder</h2><span class="aside">${S.stats.matchesPlayed} matches played</span></div>${ladderHTML()}`;
    else if (ui.tab === 'stats') html = statsHTML();
    else if (ui.tab === 'squad') html = squadHTML(true) + (t.status === 'live' && !me() ? `<div class="section-h"><h2>Late arrival?</h2></div>${joinHTML('Jump in from the next round')}` : '');
    else if (ui.tab === 'podium') html = podiumHTML() + `<div class="section-h"><h2>Awards</h2></div>${awardsHTML()}`;
    flip(main, () => setHTML(main, html));
    void prev;
  }

  // ---------- Lobby ----------
  function renderLobby(main) {
    if (main.dataset.status !== 'lobby') {
      main.dataset.status = 'lobby'; main.dataset.tab = '';
      main.innerHTML = '<div id="r-join"></div><div id="r-admin"></div><div id="r-squad"></div>';
      main.__html = null;
    }
    setHTML($('#r-join'), me() ? youreInHTML() : joinHTML());
    setHTML($('#r-admin'), isAdmin() ? adminLobbyHTML() : '');
    setHTML($('#r-squad'), squadHTML(false));
  }

  function joinHTML(sub = 'Add your name and a photo, then tap the big button.') {
    const d = ui.draft;
    return `<section class="card join" style="margin-top:16px">
      <h2>You keen?</h2>
      <p class="muted" style="margin:0">${esc(sub)}</p>
      <label class="photo-pick ${d.photo ? 'has' : ''}" id="pick">
        ${d.photo ? `<img src="${d.photo}" alt="Your photo"><span class="swap">Change</span>` : '<span class="ph"><b>📸</b>Add your photo</span>'}
        <input type="file" accept="image/*" hidden data-photo="draft">
      </label>
      <input class="input" id="join-name" maxlength="24" placeholder="Your name" autocomplete="given-name" value="${esc(d.name)}" data-draft="name">
      <button class="imin" data-act="join" ${d.name.trim() && d.photo && !ui.joining ? '' : 'disabled'}>${ui.joining ? 'Adding…' : "I'm in 🎾"}</button>
    </section>`;
  }

  function youreInHTML() {
    const mine = P()[me().id];
    if (!mine) return '';
    const t = S.t;
    return `<section class="card" style="margin-top:16px">
      <div class="youre-in">
        <span class="av-ring"><img class="av xl" src="${photo(mine)}" alt=""></span>
        <div><h3>You're in,<br><em>${esc(mine.name)}</em> ✅</h3>
          <p class="muted" style="margin:6px 0 0">${t.status === 'lobby' ? "We'll pop the draw up here when it starts." : 'Check the courts tab for your next match.'}</p></div>
      </div>
      <div class="row" style="margin-top:16px">
        <label class="btn small">📸 New photo<input type="file" accept="image/*" hidden data-photo="mine"></label>
        <button class="btn small ghost" data-act="not-me">Not ${esc(mine.name)}?</button>
      </div>
    </section>`;
  }

  function squadHTML(withStats) {
    const t = S.t;
    const st = ST();
    const mid = me()?.id;
    const now = Date.now();
    const list = t.players.slice().sort((a, b) => (b.active - a.active) || (withStats ? (st[a.id]?.rank || 99) - (st[b.id]?.rank || 99) : a.joinedAt - b.joinedAt));
    return `<div class="section-h"><h2>The squad</h2><span class="aside">${t.players.filter((p) => p.active).length} in</span></div>
      ${list.length ? `<div class="squad">${list.map((p) => {
        const s = st[p.id];
        const sub = withStats && s ? `${s.points} pts · ${s.w}W ${s.l}L` : (p.id === mid ? "That's you" : 'In');
        return `<div class="pcard ${p.id === mid ? 'me' : ''} ${p.active ? '' : 'out'} ${now - p.joinedAt < 8000 ? 'new' : ''}">
          ${isAdmin() && (t.status === 'lobby' || p.active) ? `<button class="x" data-act="remove" data-pid="${p.id}" aria-label="Remove ${esc(p.name)}">×</button>` : ''}
          <img class="photo" src="${photo(p)}" alt="" loading="lazy">
          <div class="nm">${esc(p.name)} ${streakTag(s)}</div>
          <div class="sub">${p.active ? esc(sub) : 'Left'}</div>
        </div>`;
      }).join('')}</div>` : '<div class="empty">No one yet. Send the link around 👀</div>'}`;
  }

  function adminLobbyHTML() {
    const t = S.t;
    const n = t.players.filter((p) => p.active).length;
    const s = ui.setup || (ui.setup = { courts: t.courts, points: t.points, scoring: t.scoring, format: t.format, byePoints: t.byePoints });
    const usable = Math.min(s.courts, Math.floor(n / 4));
    const sitting = n - usable * 4;
    const link = `${location.origin}/t/${t.id}`;
    let hint;
    if (n < 4) hint = `Need ${4 - n} more to start.`;
    else hint = `${n} players → ${usable} court${usable === 1 ? '' : 's'} in play${sitting ? `, ${sitting} sit${sitting === 1 ? 's' : ''} out each round (rotates fairly)` : ', nobody sits out'}.`;
    return `<section class="card admin" style="margin-top:16px">
      <div class="admin-h"><h3>Organiser</h3><button class="btn small ghost" data-act="edit">✏️ Edit details</button></div>
      <div class="field"><label>Invite link</label>
        <div class="share"><input class="input" readonly value="${esc(link)}"><button class="btn" data-act="copy">Copy</button>${navigator.share ? '<button class="btn" data-act="share">Share</button>' : ''}<button class="btn" data-act="qr">QR</button></div>
      </div>
      <div class="settings">
        <div class="grid2">
          <div class="field"><label>Courts</label><div class="stepper"><button data-act="courts" data-d="-1">−</button><output>${s.courts}</output><button data-act="courts" data-d="1">+</button></div></div>
          <div class="field"><label>Format</label><div class="seg"><button data-act="fmt" data-v="americano" class="${s.format === 'americano' ? 'on' : ''}">Americano</button><button data-act="fmt" data-v="mexicano" class="${s.format === 'mexicano' ? 'on' : ''}">Mexicano</button></div></div>
        </div>
        <div class="field"><label>Points per match</label><div class="seg">${[16, 21, 24, 32].map((v) => `<button data-act="pts" data-v="${v}" class="${s.scoring === 'points' && s.points === v ? 'on' : ''}">${v}</button>`).join('')}<button data-act="pts" data-v="time" class="${s.scoring === 'time' ? 'on' : ''}">⏱ Timed</button></div></div>
        <div class="toggle"><div><b>Sit-out points</b><div class="hint" style="margin:2px 0 0">Anyone sitting out gets ${s.scoring === 'time' ? 'the round average' : Math.floor(s.points / 2) + ' pts'} so the ladder stays fair.</div></div><button class="sw ${s.byePoints ? 'on' : ''}" data-act="bye" aria-label="Toggle sit-out points"></button></div>
        <p class="hint" style="margin:0">${esc(hint)}</p>
      </div>
      <button class="btn primary huge block" data-act="start" ${n >= 4 ? '' : 'disabled'}>Begin tournament</button>
      <div class="row" style="margin-top:12px;justify-content:center"><button class="btn small ghost" data-act="add-other">＋ Add a player without a phone</button></div>
    </section>`;
  }

  // ---------- Courts ----------
  function teamHTML(ids, side, m) {
    const pl = P(), st = ST();
    const done = m.done;
    const mine = side === 'a' ? m.sa : m.sb;
    const theirs = side === 'a' ? m.sb : m.sa;
    const cls = done ? (mine > theirs ? 'win' : mine < theirs ? 'lose' : '') : '';
    return `<div class="team ${side} ${cls}">
      <div class="duo">${ids.map((id) => `<span class="pw">${img(pl[id], '')}${st[id]?.streak >= 3 ? '<span class="fire">🔥</span>' : ''}</span>`).join('')}</div>
      <div class="names">${ids.map((id) => `<div>${esc(pl[id]?.name || '?')}</div>`).join('')}</div>
    </div>`;
  }

  function courtHTML(m, admin, i = 0) {
    const mid = me()?.id;
    const mineMatch = mid && [...m.a, ...m.b].includes(mid);
    const score = m.done
      ? `<div class="score"><span class="${m.sa >= m.sb ? 'w' : 'l'}">${m.sa}</span><span class="sep">:</span><span class="${m.sb >= m.sa ? 'w' : 'l'}">${m.sb}</span></div>`
      : '<div class="vs">VS</div>';
    return `<div class="court ${m.done ? 'done' : ''}" style="animation-delay:${0.15 + i * 0.12}s">
      <div class="court-h"><span>Court ${m.court}${mineMatch ? ' · <span style="color:var(--ball)">You</span>' : ''}</span><span class="st ${m.done ? 'fin' : ''}">${m.done ? 'Final' : '● Playing'}</span></div>
      <div class="teams">${teamHTML(m.a, 'a', m)}<div class="mid">${score}</div>${teamHTML(m.b, 'b', m)}</div>
      ${admin ? `<div class="act"><button class="btn block ${m.done ? 'small ghost' : 'primary'}" data-act="score" data-mid="${m.id}">${m.done ? 'Edit score' : 'Enter score'}</button></div>` : ''}
    </div>`;
  }

  function courtsHTML() {
    const t = S.t;
    if (!t.rounds.length) return '<div class="empty" style="margin-top:20px">No rounds played.</div>';
    const last = t.rounds.length - 1;
    const idx = ui.viewRound == null ? last : Math.min(ui.viewRound, last);
    const r = t.rounds[idx];
    const isLatest = idx === last;
    const admin = isAdmin() && t.status === 'live';
    const allDone = r.matches.every((m) => m.done);
    const anyDone = r.matches.some((m) => m.done);
    const pl = P();
    const byes = (r.byes || []).map((id) => pl[id]).filter(Boolean);
    let ctrl = '';
    if (admin && isLatest) {
      ctrl = `<div class="ctrl">
        ${allDone ? '<button class="btn primary huge" data-act="next">Next round →</button>' : `<button class="btn primary huge" disabled>${r.matches.filter((m) => !m.done).length} to score</button>`}
        ${!anyDone ? '<button class="btn" data-act="reshuffle">🔀 Reshuffle</button>' : ''}
        <button class="btn ghost" data-act="settings">⚙️</button>
        <button class="btn ghost danger" data-act="finish">End tournament</button>
      </div>`;
    } else if (isAdmin() && t.status === 'finished' && isLatest) {
      ctrl = '<div class="ctrl"><button class="btn ghost" data-act="reopen">Reopen tournament</button></div>';
    }
    return `<div class="round-h">
        <h2>Round <span>${r.n}</span>${isLatest && t.status === 'live' ? '' : ` <small class="muted" style="font-size:20px">of ${t.rounds.length}</small>`}</h2>
        ${t.rounds.length > 1 ? `<div class="round-nav"><button class="btn small" data-act="round" data-d="-1" ${idx === 0 ? 'disabled' : ''}>←</button><button class="btn small" data-act="round" data-d="1" ${isLatest ? 'disabled' : ''}>→</button></div>` : ''}
      </div>
      <div class="courts">${r.matches.map((m) => courtHTML(m, admin || (isAdmin() && t.status === 'finished'))).join('')}</div>
      ${byes.length ? `<div class="byes">☕ Sitting out: ${byes.map((p) => `<span class="pill"><img src="${photo(p)}" alt="">${esc(p.name)}</span>`).join('')}</div>` : ''}
      ${ctrl}
      ${!isAdmin() && t.status === 'live' ? '<p class="muted center tiny" style="margin-top:22px">Scores update live. The organiser enters them.</p>' : ''}`;
  }

  // ---------- Ladder ----------
  function ladderHTML(limit = 999) {
    const pl = P();
    const mid = me()?.id;
    const rows = S.standings.filter((s) => s.active || s.played).slice(0, limit);
    if (!rows.length) return '<div class="empty">No players yet.</div>';
    return `<div class="ladder">
      <div class="lhead"><span class="center">#</span><span></span><span></span><span>Player</span><span class="n hd">+/−</span><span class="n">Pts</span></div>
      ${rows.map((s) => {
        const p = pl[s.id];
        const mv = s.move > 0 ? `<span class="mv up">▲${s.move}</span>` : s.move < 0 ? `<span class="mv down">▼${-s.move}</span>` : '<span class="mv">–</span>';
        const hot = s.streak >= 3;
        return `<div class="lrow ${s.rank <= 3 ? 'p' + s.rank : ''} ${s.id === mid ? 'me' : ''}" data-pid="${s.id}">
          <span class="rk">${s.rank}</span>${mv}
          ${hot ? `<span class="av-ring hot"><img class="av" src="${photo(p)}" alt="" style="width:42px;height:42px"></span>` : img(p)}
          <div class="who"><div class="nm"><span>${esc(s.name)}</span>${streakTag(s)}${s.active ? '' : '<span class="tag out">Left</span>'}</div>
            <div class="sub">${s.w}W ${s.d ? s.d + 'D ' : ''}${s.l}L${s.byes ? ` · ${s.byes} sat` : ''} ${formDots(s)}</div></div>
          <span class="n diff">${s.diff > 0 ? '+' : ''}${s.diff}</span>
          <span class="n pts">${s.points}</span>
        </div>`;
      }).join('')}
    </div>`;
  }

  // FLIP animation so ladder rows slide to their new spots.
  function flip(container, mutate) {
    const before = {};
    container.querySelectorAll('[data-pid].lrow').forEach((el) => { before[el.dataset.pid] = el.getBoundingClientRect().top; });
    const changed = mutate();
    if (!changed || !Object.keys(before).length) return;
    container.querySelectorAll('[data-pid].lrow').forEach((el) => {
      const b = before[el.dataset.pid];
      if (b == null) return;
      const dy = b - el.getBoundingClientRect().top;
      if (Math.abs(dy) < 2) return;
      el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 700, easing: 'cubic-bezier(.2,.8,.2,1)' });
      if (dy > 0) el.animate([{ boxShadow: '0 0 0 2px rgba(57,229,140,.8)' }, { boxShadow: '0 0 0 0 rgba(57,229,140,0)' }], { duration: 1600 });
    });
  }

  // ---------- Stats ----------
  function awardsHTML() {
    const pl = P();
    const a = S.stats.awards;
    if (!a.length) return '<div class="empty">Awards unlock once scores are in.</div>';
    return `<div class="awards">${a.map((x) => `<div class="award aw-${x.key}">
      <span class="ic">${x.icon}</span>
      <div class="tt">${x.icon} ${esc(x.title)}</div>
      <div class="faces">${x.ids.slice(0, 4).map((id) => img(pl[id], '')).join('')}</div>
      <div class="nm">${esc(x.names.slice(0, 4).join(' & '))}${x.names.length > 4 ? ` +${x.names.length - 4}` : ''}</div>
      <div class="val">${esc(x.value)}</div>
      <div class="sub">${esc(x.sub)}</div>
    </div>`).join('')}</div>`;
  }

  function statsHTML() {
    const pl = P();
    const st = S.stats;
    const rounds = S.t.rounds.length;
    const rows = S.standings.filter((s) => s.played || s.active);
    return `<div class="section-h"><h2>Awards</h2><span class="aside">Updates live</span></div>
      <div class="totals">
        <div class="total"><b>${st.matchesPlayed}</b><span>Matches</span></div>
        <div class="total"><b>${st.totalPoints}</b><span>Points won</span></div>
        <div class="total"><b>${rounds}</b><span>Rounds</span></div>
      </div>
      ${awardsHTML()}
      <div class="section-h"><h2>Player stats</h2></div>
      <div class="tbl-wrap"><table class="stats">
        <thead><tr><th>Player</th><th>P</th><th>W</th><th>D</th><th>L</th><th>For</th><th>Agst</th><th>+/−</th><th>Win %</th><th>Avg</th><th>Best run</th><th>Pts</th></tr></thead>
        <tbody>${rows.map((s) => `<tr>
          <td><span class="pl">${img(pl[s.id], '')}${esc(s.name)} ${streakTag(s)}</span></td>
          <td>${s.played}</td><td>${s.w}</td><td>${s.d}</td><td>${s.l}</td><td>${s.pf}</td><td>${s.pa}</td>
          <td>${s.diff > 0 ? '+' : ''}${s.diff}</td><td>${s.winPct}%</td><td>${s.avg}</td><td>${s.bestStreak ? s.bestStreak + 'W' : '–'}</td>
          <td class="big">${s.points}</td></tr>`).join('')}</tbody>
      </table></div>`;
  }

  // ---------- Podium ----------
  function podiumHTML() {
    const pl = P();
    const top = S.standings.filter((s) => s.played).slice(0, 3);
    if (!top.length) return '<div class="empty" style="margin-top:20px">No results recorded.</div>';
    const slot = (s, cls, place) => s ? `<div class="pod ${cls}">
        ${place === 1 ? '<span class="crown">👑</span>' : ''}
        <span class="av-ring ${place === 1 ? 'hot' : ''}">${img(pl[s.id], '')}</span>
        <div class="nm">${esc(s.name)}</div><div class="pp">${s.points} pts · ${s.w}W</div>
        <div class="block">${place}</div></div>` : '<div></div>';
    return `<h2 class="champ-title">Champion<br><em>${esc(top[0].name)}</em></h2>
      <div class="podium">${slot(top[1], 'second', 2)}${slot(top[0], 'first', 1)}${slot(top[2], 'third', 3)}</div>
      <div class="section-h"><h2>Final ladder</h2></div>${ladderHTML()}`;
  }

  // ---------- TV mode ----------
  function renderTV() {
    const t = S.t;
    document.body.style.overflow = 'auto';
    const last = t.rounds[t.rounds.length - 1];
    let body;
    if (t.status === 'lobby') {
      body = `<div class="tv-lobby">
        <div><div class="qr-box"><img src="/api/t/${t.id}/qr.svg" alt="QR code to join"></div><div class="scan">Scan to join</div></div>
        <div>${squadHTML(false)}</div></div>`;
    } else if (t.status === 'finished') {
      body = `<div class="tv-body"><div>${podiumHTML().split('<div class="section-h">')[0]}</div><div><div class="section-h"><h2>Final ladder</h2></div>${ladderHTML(12)}</div></div>`;
    } else {
      body = `<div class="tv-body">
        <div><div class="round-h"><h2>Round <span>${last.n}</span></h2></div><div class="courts">${last.matches.map((m) => courtHTML(m, false)).join('')}</div>
          ${(last.byes || []).length ? `<div class="byes">☕ Sitting out: ${last.byes.map((id) => P()[id]).filter(Boolean).map((p) => `<span class="pill"><img src="${photo(p)}" alt="">${esc(p.name)}</span>`).join('')}</div>` : ''}
          <div class="section-h"><h2>Awards</h2></div>${awardsHTML()}</div>
        <div><div class="section-h"><h2>Live ladder</h2></div>${ladderHTML(14)}</div>
      </div>`;
    }
    const html = `<div class="tv">
      <div class="tv-top"><div><div class="badges">${t.status === 'live' ? '<span class="badge live"><i></i>Live</span>' : ''}<span class="badge">${fmtLabel(t)}</span><span class="badge">${ptsLabel(t)}</span></div><h1>${esc(t.name)}</h1></div>
      <a class="brand" href="/t/${t.id}"><img src="/icon.svg" alt=""><span>Ultimate <em>Paddle</em><br>Tournament</span></a></div>
      <div id="tv-main">${body}</div></div>`;
    if (!app.__tv) { app.innerHTML = html; app.__tv = true; app.__html = html; return; }
    flip(app, () => { if (app.__html === html) return false; app.innerHTML = html; app.__html = html; return true; });
  }

  // ---------- Round splash ----------
  function showSplash(r) {
    splashRoot.innerHTML = `<div class="splash" data-act="close-splash"><div class="splash-in">
      <div class="small">Here we go</div>
      <div class="big">Round ${r.n}</div>
      <div class="courts">${r.matches.map((m, i) => courtHTML(m, false, i)).join('')}</div>
      <div class="tap">Tap anywhere to close</div>
    </div></div>`;
    clearTimeout(showSplash.t);
    showSplash.t = setTimeout(() => { splashRoot.innerHTML = ''; }, route.view === 'tv' ? 9000 : 7000);
  }

  // ---------- Modals ----------
  function openModal(html, onMount) {
    modalRoot.innerHTML = `<div class="modal-bg" data-act="close-bg"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
    if (onMount) onMount($('.modal', modalRoot));
  }
  function closeModal() { modalRoot.innerHTML = ''; }

  function openPin() {
    openModal(`<h3>Organiser PIN</h3><p class="muted" style="margin:0 0 16px">Unlocks starting the tournament and entering scores on this device.</p>
      <form id="pin-form" class="form"><input class="input pin-input" type="password" inputmode="numeric" maxlength="8" autocomplete="off" id="pin" autofocus>
      <button class="btn primary block" type="submit">Unlock</button><p class="err" id="pin-err"></p></form>`, (m) => {
      $('#pin', m).focus();
      $('#pin-form', m).addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const out = await api('POST', `/api/t/${route.id}/admin/login`, { pin: $('#pin', m).value });
          LS.set(adminKey(route.id), out.adminToken);
          closeModal(); toast('Organiser mode on 🔓'); render();
        } catch (err) { $('#pin-err', m).textContent = err.message; }
      });
    });
  }

  function openScore(mid) {
    const t = S.t;
    const r = t.rounds.find((x) => x.matches.some((m) => m.id === mid));
    const m = r.matches.find((x) => x.id === mid);
    const pl = P();
    const N = t.points;
    const timed = t.scoring === 'time';
    const v = { a: m.done ? m.sa : timed ? 0 : Math.ceil(N / 2), b: m.done ? m.sb : timed ? 0 : Math.floor(N / 2) };
    const duo = (ids) => `<div class="duo">${ids.map((id) => `<span class="pw">${img(pl[id], '')}</span>`).join('')}</div><div class="names">${ids.map((id) => esc(pl[id]?.name)).join(' & ')}</div>`;
    const draw = (modal) => {
      $('#sa', modal).textContent = v.a; $('#sb', modal).textContent = v.b;
      modal.querySelectorAll('.quick button').forEach((b) => b.classList.toggle('on', +b.dataset.v === v.a));
    };
    openModal(`<h3>Court ${m.court} · Round ${r.n}</h3>
      <p class="muted" style="margin:0">${timed ? 'Enter both scores.' : `Scores add up to ${N}. Set one side, the other fills itself.`}</p>
      <div class="score-teams">
        <div class="score-team a">${duo(m.a)}<div class="stepper"><button data-s="a" data-d="-1">−</button><output id="sa">${v.a}</output><button data-s="a" data-d="1">+</button></div></div>
        <div class="score-team b">${duo(m.b)}<div class="stepper"><button data-s="b" data-d="-1">−</button><output id="sb">${v.b}</output><button data-s="b" data-d="1">+</button></div></div>
      </div>
      ${timed ? '' : `<div class="hint" style="margin:0 0 6px">Quick pick for the left team</div><div class="quick">${Array.from({ length: N + 1 }, (_, i) => `<button data-v="${i}">${i}</button>`).join('')}</div>`}
      <div class="row"><button class="btn primary grow" data-save>Save score</button>${m.done ? '<button class="btn ghost danger" data-clear>Clear</button>' : ''}</div>
      <p class="err" id="score-err"></p>`, (modal) => {
      draw(modal);
      modal.addEventListener('click', async (e) => {
        const st = e.target.closest('[data-s]');
        const q = e.target.closest('.quick button');
        if (st) {
          const side = st.dataset.s, other = side === 'a' ? 'b' : 'a';
          v[side] = Math.max(0, Math.min(timed ? 999 : N, v[side] + +st.dataset.d));
          if (!timed) v[other] = N - v[side];
          draw(modal);
        } else if (q) {
          v.a = +q.dataset.v; v.b = N - v.a; draw(modal);
        } else if (e.target.closest('[data-save]') || e.target.closest('[data-clear]')) {
          const clear = !!e.target.closest('[data-clear]');
          try {
            await api('PUT', `/api/t/${t.id}/matches/${m.id}`, clear ? { clear: true } : { sa: v.a, sb: v.b });
            closeModal();
            if (!clear) {
              const st2 = ST();
              const winners = v.a > v.b ? m.a : v.b > v.a ? m.b : [];
              toast(winners.length ? `${winners.map((id) => pl[id]?.name).join(' & ')} take it 💪` : 'Score saved');
              if (winners.some((id) => (st2[id]?.streak || 0) >= 2)) setTimeout(() => toast('🔥 Someone is heating up…'), 2900);
            }
            poll();
          } catch (err) { $('#score-err', modal).textContent = err.message; }
        }
      });
    });
  }

  function openEdit() {
    const t = S.t;
    openModal(`<h3>Edit details</h3>
      <form class="form" id="edit-form" style="margin-top:12px">
        <div class="field"><label>Name</label><input class="input" name="name" maxlength="60" value="${esc(t.name)}"></div>
        <div class="grid2"><div class="field"><label>Date</label><input class="input" type="date" name="date" value="${esc(t.date)}"></div>
        <div class="field"><label>Start time</label><input class="input" type="time" name="time" value="${esc(t.time)}"></div></div>
        <div class="field"><label>Venue</label><input class="input" name="venue" maxlength="120" value="${esc(t.venue)}"></div>
        <div class="field"><label>Length (minutes)</label><input class="input" type="number" name="durationMins" min="30" max="600" step="15" value="${t.durationMins}"></div>
        <div class="field"><label>Note for players</label><input class="input" name="notes" maxlength="300" placeholder="e.g. Bring a can of balls" value="${esc(t.notes || '')}"></div>
        <button class="btn primary block" type="submit">Save</button><p class="err" id="edit-err"></p>
      </form>`, (m) => {
      $('#edit-form', m).addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        if (f.date && f.time) f.startUtc = new Date(`${f.date}T${f.time}`).toISOString();
        try { await api('POST', `/api/t/${t.id}/settings`, f); closeModal(); toast('Saved'); poll(); } catch (err) { $('#edit-err', m).textContent = err.message; }
      });
    });
  }

  function openSettings() {
    const t = S.t;
    const s = { courts: t.courts, points: t.points, scoring: t.scoring, format: t.format, byePoints: t.byePoints };
    const body = () => `<h3>Next round settings</h3><p class="muted" style="margin:0 0 14px">Changes apply from the next round. Points already scored stay.</p>
      <div class="settings">
        <div class="field"><label>Courts</label><div class="stepper"><button data-k="courts" data-d="-1">−</button><output>${s.courts}</output><button data-k="courts" data-d="1">+</button></div></div>
        <div class="field"><label>Format</label><div class="seg"><button data-k="format" data-v="americano" class="${s.format === 'americano' ? 'on' : ''}">Americano</button><button data-k="format" data-v="mexicano" class="${s.format === 'mexicano' ? 'on' : ''}">Mexicano</button></div></div>
        <div class="field"><label>Points per match</label><div class="seg">${[16, 21, 24, 32].map((v) => `<button data-k="points" data-v="${v}" class="${s.scoring === 'points' && s.points === v ? 'on' : ''}">${v}</button>`).join('')}<button data-k="points" data-v="time" class="${s.scoring === 'time' ? 'on' : ''}">⏱</button></div></div>
      </div>
      <button class="btn primary block" data-save>Save</button>`;
    openModal(body(), (m) => {
      m.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-k]');
        if (b) {
          if (b.dataset.k === 'courts') s.courts = Math.max(1, Math.min(12, s.courts + +b.dataset.d));
          else if (b.dataset.k === 'format') s.format = b.dataset.v;
          else if (b.dataset.v === 'time') s.scoring = 'time'; else { s.scoring = 'points'; s.points = +b.dataset.v; }
          m.innerHTML = body();
        } else if (e.target.closest('[data-save]')) {
          try { await api('POST', `/api/t/${t.id}/settings`, s); closeModal(); toast('Saved for next round'); poll(); } catch (err) { toast(err.message, true); }
        }
      });
    });
  }

  function openAddOther() {
    const o = ui.other = { name: '', photo: null };
    const body = () => `<h3>Add a player</h3><p class="muted" style="margin:0">For someone without their phone. Snap their photo now.</p>
      <div class="join">
        <label class="photo-pick ${o.photo ? 'has' : ''}">${o.photo ? `<img src="${o.photo}" alt=""><span class="swap">Change</span>` : '<span class="ph"><b>📸</b>Their photo</span>'}<input type="file" accept="image/*" hidden data-photo="other"></label>
        <input class="input" id="other-name" maxlength="24" placeholder="Their name" value="${esc(o.name)}">
        <button class="imin" data-add-other style="font-size:30px">Add them</button><p class="err" id="other-err"></p>
      </div>`;
    openModal(body(), (m) => {
      m.addEventListener('input', (e) => { if (e.target.id === 'other-name') o.name = e.target.value; });
      m.addEventListener('change', async (e) => {
        if (e.target.dataset.photo !== 'other' || !e.target.files[0]) return;
        o.photo = await processPhoto(e.target.files[0]);
        m.innerHTML = body();
      });
      m.addEventListener('click', async (e) => {
        if (!e.target.closest('[data-add-other]')) return;
        if (!o.name.trim() || !o.photo) { $('#other-err', m).textContent = 'Name and photo, please'; return; }
        try {
          await fetch(`/api/t/${S.t.id}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: o.name, photo: o.photo }) })
            .then(async (r) => { if (!r.ok) throw new Error((await r.json()).error); });
          toast(`${o.name} is in 🎾`);
          o.name = ''; o.photo = null; m.innerHTML = body();
          poll();
        } catch (err) { $('#other-err', m).textContent = err.message; }
      });
    });
  }

  function openQR() {
    openModal(`<h3>Scan to join</h3><p class="muted" style="margin:0 0 16px">Hold this up at the courts.</p>
      <div class="qr-box"><img src="/api/t/${S.t.id}/qr.svg" alt="QR code"></div>
      <a class="btn block" style="margin-top:16px" href="/t/${S.t.id}/tv" target="_blank" rel="noopener">📺 Open TV mode for a big screen</a>`);
  }

  // ---------- photos ----------
  async function processPhoto(file) {
    const url = URL.createObjectURL(file);
    try {
      let im;
      try {
        im = await createImageBitmap(file); // respects phone photo rotation
      } catch {
        im = await new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = url; });
      }
      const w = im.naturalWidth || im.width, h = im.naturalHeight || im.height, s = Math.min(w, h);
      const size = Math.min(720, s);
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      // Bias the crop upward a touch on portrait photos so faces stay in frame.
      ctx.drawImage(im, (w - s) / 2, h > w ? (h - s) * 0.3 : 0, s, s, 0, 0, size, size);
      return c.toDataURL('image/jpeg', 0.88);
    } catch {
      toast("Couldn't read that photo, try another", true);
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // ---------- events ----------
  document.addEventListener('input', (e) => {
    if (e.target.dataset.draft) {
      ui.draft[e.target.dataset.draft] = e.target.value;
      const b = $('[data-act="join"]');
      if (b) b.disabled = !(ui.draft.name.trim() && ui.draft.photo) || ui.joining;
    }
  });

  document.addEventListener('change', async (e) => {
    const kind = e.target.dataset?.photo;
    if (!kind || kind === 'other' || !e.target.files?.[0]) return;
    const data = await processPhoto(e.target.files[0]);
    if (!data) return;
    if (kind === 'draft') { ui.draft.photo = data; render(); }
    if (kind === 'mine') {
      try { await api('PATCH', `/api/t/${S.t.id}/players/${me().id}`, { photo: data }); toast('Looking sharp 📸'); poll(); } catch (err) { toast(err.message, true); }
    }
  });

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act], [data-tab]');
    if (!el) return;
    if (el.dataset.tab) {
      ui.tab = el.dataset.tab; ui.viewRound = null; render(); window.scrollTo({ top: $('#r-tabs')?.offsetTop - 4 || 0, behavior: 'smooth' });
      return;
    }
    const act = el.dataset.act;
    const t = S?.t;
    const s = ui.setup;
    try {
      switch (act) {
        case 'close-bg': if (e.target === el) closeModal(); break;
        case 'close-splash': splashRoot.innerHTML = ''; break;
        case 'unlock': openPin(); break;
        case 'lock': if (confirm('Turn off organiser mode on this device?')) { LS.del(adminKey(t.id)); render(); } break;
        case 'join': {
          ui.joining = true; render();
          try {
            const out = await api('POST', `/api/t/${t.id}/join`, { name: ui.draft.name, photo: ui.draft.photo });
            LS.set(meKey(t.id), { id: out.player.id, token: out.playerToken });
            ui.draft = { name: '', photo: null };
            confetti(160);
            toast(`You're in, ${out.player.name}! 🎾`);
            await poll();
          } finally { ui.joining = false; render(); }
          break;
        }
        case 'not-me': if (confirm("Forget who you are on this device? (You'll stay in the tournament.)")) { LS.del(meKey(t.id)); render(); } break;
        case 'copy': await navigator.clipboard.writeText(`${location.origin}/t/${t.id}`); toast('Link copied 📋'); break;
        case 'share': navigator.share({ title: t.name, text: `${t.name} 🎾 ${fmtDate(t.date)} ${fmtTime(t.time)}. Tap to say you're in:`, url: `${location.origin}/t/${t.id}` }).catch(() => {}); break;
        case 'qr': openQR(); break;
        case 'edit': openEdit(); break;
        case 'add-other': openAddOther(); break;
        case 'courts': s.courts = Math.max(1, Math.min(12, s.courts + +el.dataset.d)); render(); break;
        case 'fmt': s.format = el.dataset.v; render(); break;
        case 'pts': if (el.dataset.v === 'time') s.scoring = 'time'; else { s.scoring = 'points'; s.points = +el.dataset.v; } render(); break;
        case 'bye': s.byePoints = !s.byePoints; render(); break;
        case 'start':
          el.disabled = true;
          await api('POST', `/api/t/${t.id}/start`, s);
          await poll();
          break;
        case 'remove': {
          const p = P()[el.dataset.pid];
          if (confirm(`Remove ${p.name}?${t.status === 'live' ? ' Their results so far stay on the ladder.' : ''}`)) { await api('DELETE', `/api/t/${t.id}/players/${p.id}`); poll(); }
          break;
        }
        case 'score': openScore(el.dataset.mid); break;
        case 'next': el.disabled = true; await api('POST', `/api/t/${t.id}/next`); await poll(); break;
        case 'reshuffle': await api('POST', `/api/t/${t.id}/reshuffle`); seenRounds = null; await poll(); toast('Reshuffled 🔀'); break;
        case 'settings': openSettings(); break;
        case 'finish': if (confirm('End the tournament and crown the champion?')) { await api('POST', `/api/t/${t.id}/finish`); poll(); } break;
        case 'reopen': await api('POST', `/api/t/${t.id}/reopen`); poll(); break;
        case 'round': {
          const last = t.rounds.length - 1;
          const cur = ui.viewRound == null ? last : ui.viewRound;
          const n = Math.max(0, Math.min(last, cur + +el.dataset.d));
          ui.viewRound = n === last ? null : n; render();
          break;
        }
        default: break;
      }
    } catch (err) {
      toast(err.message, true);
      if (act === 'start' || act === 'next') el.disabled = false;
    }
  });

  // ---------- confetti ----------
  function confetti(n = 150) {
    const c = $('#confetti');
    const ctx = c.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    c.width = innerWidth * dpr; c.height = innerHeight * dpr;
    ctx.scale(dpr, dpr);
    const colors = ['#e4ff3c', '#3cc8ff', '#ff6b4a', '#ffd54a', '#39e58c', '#ffffff'];
    const parts = Array.from({ length: n }, () => ({
      x: innerWidth / 2 + (Math.random() - 0.5) * 120, y: innerHeight * 0.45,
      vx: (Math.random() - 0.5) * 16, vy: -Math.random() * 18 - 6, s: Math.random() * 8 + 5,
      r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, c: colors[(Math.random() * colors.length) | 0], ball: Math.random() < 0.12,
    }));
    let frame = 0;
    (function tick() {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      for (const p of parts) {
        p.vy += 0.45; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
        if (p.ball) { ctx.font = `${p.s * 2.4}px serif`; ctx.fillText('🎾', 0, 0); } else { ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); }
        ctx.restore();
      }
      if (++frame < 200) requestAnimationFrame(tick); else ctx.clearRect(0, 0, innerWidth, innerHeight);
    })();
  }

  boot();
})();
