'use strict';

require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const E = require('./engine');
const { createStore } = require('./store');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const CREATE_CODE = process.env.CREATE_CODE || ''; // optional: lock who can create tournaments
const store = createStore();
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '4mb' }));

// ---------- helpers ----------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (status, msg) => Object.assign(new Error(msg), { status });
const clean = (s, max = 80) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(pin), salt, 32).toString('hex') };
}
function adminToken(doc) {
  return crypto.createHmac('sha256', SECRET).update(doc.id + ':' + doc.pinHash).digest('base64url');
}
function isAdmin(req, doc) {
  const t = req.get('x-admin-token') || '';
  const want = adminToken(doc);
  return t.length === want.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(want));
}
function baseUrl(req) {
  return process.env.PUBLIC_URL?.replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;
}

const computed = new Map(); // id -> { version, payload }
function publicState(id, rec) {
  const hit = computed.get(id);
  if (hit && hit.version === rec.version) return hit.payload;
  const doc = rec.doc;
  const table = E.standings(doc);
  const payload = {
    version: rec.version,
    t: {
      id: doc.id, name: doc.name, date: doc.date, time: doc.time, startUtc: doc.startUtc,
      durationMins: doc.durationMins, venue: doc.venue, notes: doc.notes,
      courts: doc.courts, points: doc.points, scoring: doc.scoring, format: doc.format,
      byePoints: doc.byePoints, status: doc.status, createdAt: doc.createdAt,
      startedAt: doc.startedAt, finishedAt: doc.finishedAt,
      players: doc.players.map((p) => ({ id: p.id, name: p.name, photoV: p.photoV, active: p.active !== false, joinedAt: p.joinedAt })),
      rounds: doc.rounds,
    },
    standings: table,
    stats: E.stats(doc, table),
  };
  computed.set(id, { version: rec.version, payload });
  return payload;
}

async function load(id) {
  if (!/^[a-z0-9]{4,12}$/.test(id)) throw bad(404, 'Tournament not found');
  const rec = await store.get(id);
  if (!rec) throw bad(404, 'Tournament not found');
  return rec;
}
async function requireAdmin(req) {
  const rec = await load(req.params.id);
  if (!isAdmin(req, rec.doc)) throw bad(401, 'Organiser PIN needed');
  return rec;
}

function parsePhoto(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw bad(400, 'Please add a photo');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 2.5 * 1024 * 1024) throw bad(400, 'Photo too big');
  return { mime: m[1], buf };
}

function intIn(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}

function applySettings(doc, b) {
  if (b.name !== undefined) doc.name = clean(b.name, 60) || doc.name;
  if (b.date !== undefined) doc.date = /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : doc.date;
  if (b.time !== undefined) doc.time = /^\d{2}:\d{2}$/.test(b.time) ? b.time : doc.time;
  if (b.startUtc !== undefined && !Number.isNaN(Date.parse(b.startUtc))) doc.startUtc = new Date(b.startUtc).toISOString();
  if (b.durationMins !== undefined) doc.durationMins = intIn(b.durationMins, 30, 600, doc.durationMins);
  if (b.venue !== undefined) doc.venue = clean(b.venue, 120);
  if (b.notes !== undefined) doc.notes = clean(b.notes, 300);
  if (b.courts !== undefined) doc.courts = intIn(b.courts, 1, 12, doc.courts);
  if (b.points !== undefined) doc.points = intIn(b.points, 8, 64, doc.points);
  if (b.scoring !== undefined) doc.scoring = b.scoring === 'time' ? 'time' : 'points';
  if (b.format !== undefined) doc.format = b.format === 'mexicano' ? 'mexicano' : 'americano';
  if (b.byePoints !== undefined) doc.byePoints = !!b.byePoints;
}

// ---------- API ----------
app.get('/healthz', (req, res) => res.json({ ok: true, store: store.kind }));

app.post('/api/t', wrap(async (req, res) => {
  const b = req.body || {};
  if (CREATE_CODE && b.createCode !== CREATE_CODE) throw bad(403, 'Wrong create code');
  const pin = String(b.pin || '');
  if (!/^\d{4,8}$/.test(pin)) throw bad(400, 'PIN must be 4 to 8 digits');
  const { salt, hash } = hashPin(pin);
  let id;
  for (let i = 0; i < 5; i++) { id = E.code(6); if (!(await store.get(id))) break; }
  const doc = {
    id, name: 'Ultimate Paddle Tournament', date: '', time: '', startUtc: null, durationMins: 120,
    venue: '', notes: '', courts: 2, points: 24, scoring: 'points', format: 'americano', byePoints: true,
    status: 'lobby', players: [], rounds: [], createdAt: Date.now(), pinSalt: salt, pinHash: hash,
  };
  applySettings(doc, b);
  await store.create(doc);
  res.json({ id, adminToken: adminToken(doc) });
}));

app.get('/api/t/:id/state', wrap(async (req, res) => {
  const rec = await load(req.params.id);
  if (String(rec.version) === String(req.query.v || '')) return res.status(204).end();
  res.set('Cache-Control', 'no-store');
  res.json(publicState(req.params.id, rec));
}));

app.post('/api/t/:id/admin/login', wrap(async (req, res) => {
  const rec = await load(req.params.id);
  const { hash } = hashPin(String(req.body?.pin || ''), rec.doc.pinSalt);
  if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(rec.doc.pinHash))) {
    await new Promise((r) => setTimeout(r, 600));
    throw bad(401, 'Wrong PIN');
  }
  res.json({ adminToken: adminToken(rec.doc) });
}));

app.post('/api/t/:id/join', wrap(async (req, res) => {
  const name = clean(req.body?.name, 24);
  if (!name) throw bad(400, 'Please add your name');
  const photo = parsePhoto(req.body?.photo);
  const rec = await load(req.params.id);
  if (rec.doc.status === 'finished') throw bad(400, 'This tournament has finished');
  if (rec.doc.players.length >= 64) throw bad(400, 'Tournament is full');
  const pid = E.code(10);
  const playerToken = E.token();
  await store.putPhoto(pid, rec.doc.id, photo.mime, photo.buf);
  const out = await store.mutate(rec.doc.id, (doc) => {
    if (doc.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw bad(409, `${name} is already in. Add a surname initial?`);
    const p = { id: pid, name, photoV: Date.now(), active: true, joinedAt: Date.now(), tokenHash: crypto.createHash('sha256').update(playerToken).digest('hex') };
    doc.players.push(p);
    return p;
  });
  res.json({ player: { id: pid, name, photoV: out.result.photoV }, playerToken });
}));

app.patch('/api/t/:id/players/:pid', wrap(async (req, res) => {
  const rec = await load(req.params.id);
  const p = rec.doc.players.find((x) => x.id === req.params.pid);
  if (!p) throw bad(404, 'Player not found');
  const tok = req.get('x-player-token') || '';
  const owner = tok && crypto.createHash('sha256').update(tok).digest('hex') === p.tokenHash;
  if (!owner && !isAdmin(req, rec.doc)) throw bad(401, 'Not allowed');
  if (req.body?.photo) {
    const photo = parsePhoto(req.body.photo);
    await store.putPhoto(p.id, rec.doc.id, photo.mime, photo.buf);
  }
  await store.mutate(rec.doc.id, (doc) => {
    const q = doc.players.find((x) => x.id === p.id);
    if (req.body?.name) {
      const name = clean(req.body.name, 24);
      if (doc.players.some((x) => x.id !== q.id && x.name.toLowerCase() === name.toLowerCase())) throw bad(409, 'Name already taken');
      if (name) q.name = name;
    }
    if (req.body?.photo) q.photoV = Date.now();
    if (req.body?.active !== undefined && isAdmin(req, doc)) q.active = !!req.body.active;
  });
  res.json({ ok: true });
}));

app.delete('/api/t/:id/players/:pid', wrap(async (req, res) => {
  const rec = await requireAdmin(req);
  await store.mutate(rec.doc.id, (doc) => {
    const played = doc.rounds.some((r) => r.matches.some((m) => [...m.a, ...m.b].includes(req.params.pid)) || (r.byes || []).includes(req.params.pid));
    if (played) {
      const q = doc.players.find((x) => x.id === req.params.pid);
      if (q) q.active = false; // keep their results, just stop scheduling them
    } else {
      doc.players = doc.players.filter((x) => x.id !== req.params.pid);
    }
  });
  res.json({ ok: true });
}));

app.post('/api/t/:id/settings', wrap(async (req, res) => {
  const rec = await requireAdmin(req);
  await store.mutate(rec.doc.id, (doc) => applySettings(doc, req.body || {}));
  res.json({ ok: true });
}));

app.post('/api/t/:id/start', wrap(async (req, res) => {
  const rec = await requireAdmin(req);
  await store.mutate(rec.doc.id, (doc) => {
    if (doc.status !== 'lobby') throw bad(400, 'Already started');
    applySettings(doc, req.body || {});
    if (E.activePlayers(doc).length < 4) throw bad(400, 'Need at least 4 players');
    doc.status = 'live';
    doc.startedAt = Date.now();
    doc.rounds = [E.makeRound(doc)];
  });
  res.json({ ok: true });
}));

app.post('/api/t/:id/next', wrap(async (req, res) => {
  const rec = await requireAdmin(req);
  await store.mutate(rec.doc.id, (doc) => {
    if (doc.status !== 'live') throw bad(400, 'Tournament is not live');
    const last = doc.rounds[doc.rounds.length - 1];
    if (last && !E.isRoundComplete(last)) throw bad(400, 'Finish scoring this round first');
    applySettings(doc, req.body || {});
    doc.rounds.push(E.makeRound(doc));
  });
  res.json({ ok: true });
}));

app.post('/api/t/:id/reshuffle', wrap(async (req, res) => {
  const rec = await requireAdmin(req);
  await store.mutate(rec.doc.id, (doc) => {
    const last = doc.rounds[doc.rounds.length - 1];
    if (!last || doc.status !== 'live') throw bad(400, 'No round to reshuffle');
    if (last.matches.some((m) => m.done)) throw bad(400, 'Scores are already in for this round');
    doc.rounds.pop();
    doc.rounds.push(E.makeRound(doc));
  });
  res.json({ ok: true });
}));

app.put('/api/t/:id/matches/:mid', wrap(async (req, res) => {
  const rec = await requireAdmin(req);
  await store.mutate(rec.doc.id, (doc) => {
    const m = doc.rounds.flatMap((r) => r.matches).find((x) => x.id === req.params.mid);
    if (!m) throw bad(404, 'Match not found');
    if (req.body?.clear) { m.sa = null; m.sb = null; m.done = false; return; }
    const sa = parseInt(req.body?.sa, 10), sb = parseInt(req.body?.sb, 10);
    if (!Number.isInteger(sa) || !Number.isInteger(sb) || sa < 0 || sb < 0 || sa > 999 || sb > 999) throw bad(400, 'Scores must be numbers');
    if (doc.scoring === 'points' && sa + sb !== doc.points) throw bad(400, `Scores must add up to ${doc.points}`);
    m.sa = sa; m.sb = sb; m.done = true; m.at = Date.now();
  });
  res.json({ ok: true });
}));

app.post('/api/t/:id/finish', wrap(async (req, res) => {
  const rec = await requireAdmin(req);
  await store.mutate(rec.doc.id, (doc) => {
    // Drop an unplayed final round so it doesn't hang around.
    const last = doc.rounds[doc.rounds.length - 1];
    if (last && !last.matches.some((m) => m.done)) doc.rounds.pop();
    doc.status = 'finished';
    doc.finishedAt = Date.now();
  });
  res.json({ ok: true });
}));

app.post('/api/t/:id/reopen', wrap(async (req, res) => {
  const rec = await requireAdmin(req);
  await store.mutate(rec.doc.id, (doc) => { doc.status = doc.rounds.length ? 'live' : 'lobby'; doc.finishedAt = null; });
  res.json({ ok: true });
}));

app.get('/api/photo/:pid', wrap(async (req, res) => {
  const ph = await store.getPhoto(req.params.pid);
  if (!ph) return res.status(404).end();
  res.set('Content-Type', ph.mime);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(ph.data);
}));

app.get('/api/t/:id/qr.svg', wrap(async (req, res) => {
  const rec = await load(req.params.id);
  const svg = await QRCode.toString(`${baseUrl(req)}/t/${rec.doc.id}`, {
    type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0b0f14', light: '#ffffff' },
  });
  res.set('Content-Type', 'image/svg+xml');
  res.send(svg);
}));

// ---------- Calendar ----------
const icsEsc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
const icsDate = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

app.get('/t/:id/event.ics', wrap(async (req, res) => {
  const { doc } = await load(req.params.id);
  if (!doc.startUtc) throw bad(400, 'No date set yet');
  const start = new Date(doc.startUtc);
  const end = new Date(start.getTime() + (doc.durationMins || 120) * 60000);
  const url = `${baseUrl(req)}/t/${doc.id}`;
  const fmt = doc.format === 'mexicano' ? 'Mexicano' : 'Americano';
  const desc = `${fmt} padel, ${doc.scoring === 'time' ? 'timed matches' : doc.points + ' points per match'}.${doc.notes ? '\n' + doc.notes : ''}\n\nLive ladder: ${url}`;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Ultimate Paddle Tournament//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${doc.id}@ultimate-paddle-tournament`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsEsc('🎾 ' + doc.name)}`,
    `DESCRIPTION:${icsEsc(desc)}`,
    doc.venue ? `LOCATION:${icsEsc(doc.venue)}` : null,
    `URL:${url}`,
    'BEGIN:VALARM', 'TRIGGER:-PT2H', 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc(doc.name + ' in 2 hours')}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean);
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', `inline; filename="${doc.id}.ics"`);
  res.send(lines.join('\r\n'));
}));

// ---------- Pages ----------
const pub = path.join(__dirname, '..', 'public');
app.use(express.static(pub, { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0, index: false }));

async function page(req, res) {
  let html = require('fs').readFileSync(path.join(pub, 'index.html'), 'utf8');
  // Nice link previews when the join link is shared in group chats.
  const id = req.params.id;
  if (id) {
    const rec = await store.get(id).catch(() => null);
    if (rec) {
      const d = rec.doc;
      const title = `${d.name} 🎾`;
      const when = d.date ? new Date(d.date + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' }) : '';
      const t12 = d.time ? (() => { const [h, m] = d.time.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${h >= 12 ? 'pm' : 'am'}`; })() : '';
      const desc = [when, t12, d.venue, "tap to say you're in"].filter(Boolean).join(' · ');
      const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
      html = html
        .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
        .replace(/(<meta property="og:title" content=")[^"]*/, `$1${esc(title)}`)
        .replace(/(<meta property="og:description" content=")[^"]*/, `$1${esc(desc)}`);
    }
  }
  res.set('Cache-Control', 'no-store');
  res.send(html);
}
app.get('/', wrap(page));
app.get('/t/:id', wrap(page));
app.get('/t/:id/tv', wrap(page));
app.get('/t/:id/admin', wrap(page));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message });
});

store.init().then(() => {
  app.listen(PORT, () => console.log(`Ultimate Paddle Tournament on http://localhost:${PORT} (${store.kind} storage)`));
}).catch((e) => { console.error('Storage failed to start:', e); process.exit(1); });
