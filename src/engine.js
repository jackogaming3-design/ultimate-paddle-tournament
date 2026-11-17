'use strict';

// Tournament engine: round generation (Americano + Mexicano), ladder, streaks and stats.
// Pure functions over the tournament doc so they're easy to test.

const crypto = require('crypto');

const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
function code(len = 6) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHA[bytes[i] % ALPHA.length];
  return out;
}
function token(len = 24) {
  return crypto.randomBytes(len).toString('base64url');
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function activePlayers(doc) {
  return doc.players.filter((p) => p.active !== false);
}

function isRoundComplete(r) {
  return r.matches.length > 0 && r.matches.every((m) => m.done);
}

// Points credited to a player sitting out a completed round.
function byeCredit(doc, round) {
  if (doc.scoring === 'time') {
    const done = round.matches.filter((m) => m.done);
    if (!done.length) return 0;
    const total = done.reduce((s, m) => s + m.sa + m.sb, 0);
    return Math.round(total / (done.length * 2));
  }
  return Math.floor(doc.points / 2);
}

function blank(p) {
  return {
    id: p.id, name: p.name, played: 0, w: 0, d: 0, l: 0, pf: 0, pa: 0,
    byes: 0, byePts: 0, form: [], streak: 0, bestStreak: 0, worstStreak: 0,
    points: 0, diff: 0, winPct: 0, avg: 0, rank: 0, move: 0, active: p.active !== false,
  };
}

// Tally results from the first `roundLimit` rounds (all rounds by default).
function tally(doc, roundLimit = Infinity) {
  const P = {};
  for (const p of doc.players) P[p.id] = blank(p);
  doc.rounds.forEach((r, i) => {
    if (i >= roundLimit) return;
    for (const m of r.matches) {
      if (!m.done) continue;
      for (const [team, f, a] of [[m.a, m.sa, m.sb], [m.b, m.sb, m.sa]]) {
        for (const pid of team) {
          const s = P[pid];
          if (!s) continue;
          s.played++; s.pf += f; s.pa += a;
          const o = f > a ? 'W' : f < a ? 'L' : 'D';
          if (o === 'W') s.w++; else if (o === 'L') s.l++; else s.d++;
          s.form.push(o);
        }
      }
    }
    if (doc.byePoints && isRoundComplete(r)) {
      const credit = byeCredit(doc, r);
      for (const pid of r.byes || []) {
        const s = P[pid];
        if (!s) continue;
        s.byes++; s.byePts += credit;
      }
    }
  });
  const list = Object.values(P);
  for (const s of list) {
    let run = 0, best = 0, worst = 0, lrun = 0;
    for (const o of s.form) {
      if (o === 'W') { run++; lrun = 0; } else if (o === 'L') { lrun++; run = 0; } else { run = 0; lrun = 0; }
      best = Math.max(best, run); worst = Math.max(worst, lrun);
    }
    s.streak = run > 0 ? run : -lrun;
    s.bestStreak = best; s.worstStreak = worst;
    s.points = s.pf + s.byePts;
    s.diff = s.pf - s.pa;
    s.winPct = s.played ? Math.round((s.w / s.played) * 100) : 0;
    s.avg = s.played ? Math.round((s.pf / s.played) * 10) / 10 : 0;
  }
  list.sort((x, y) => y.points - x.points || y.w - x.w || y.diff - x.diff || x.name.localeCompare(y.name));
  list.forEach((s, i) => { s.rank = i + 1; });
  return list;
}

function standings(doc) {
  const now = tally(doc);
  if (doc.rounds.length >= 1) {
    const before = tally(doc, doc.rounds.length - 1);
    const prev = Object.fromEntries(before.map((s) => [s.id, s.rank]));
    const anyDoneNow = doc.rounds[doc.rounds.length - 1].matches.some((m) => m.done);
    for (const s of now) s.move = anyDoneNow && doc.rounds.length > 1 ? (prev[s.id] || s.rank) - s.rank : 0;
  }
  return now;
}

// --- Round generation -------------------------------------------------------

function history(doc) {
  const partner = {}, opp = {}, apps = {}, byes = {};
  const inc = (o, a, b) => {
    const k = a < b ? a + '|' + b : b + '|' + a;
    o[k] = (o[k] || 0) + 1;
  };
  for (const r of doc.rounds) {
    for (const m of r.matches) {
      inc(partner, m.a[0], m.a[1]); inc(partner, m.b[0], m.b[1]);
      for (const x of m.a) for (const y of m.b) inc(opp, x, y);
      for (const pid of [...m.a, ...m.b]) apps[pid] = (apps[pid] || 0) + 1;
    }
    for (const pid of r.byes || []) byes[pid] = (byes[pid] || 0) + 1;
  }
  return { partner, opp, apps, byes };
}

const pk = (a, b) => (a < b ? a + '|' + b : b + '|' + a);

function splitCost(h, a, b) {
  const pc = (x, y) => h.partner[pk(x, y)] || 0;
  const oc = (x, y) => h.opp[pk(x, y)] || 0;
  let c = 0;
  c += Math.pow(pc(a[0], a[1]), 2) * 10 + Math.pow(pc(b[0], b[1]), 2) * 10;
  for (const x of a) for (const y of b) c += Math.pow(oc(x, y), 2);
  return c;
}

function bestSplit(h, g) {
  const options = [
    [[g[0], g[1]], [g[2], g[3]]],
    [[g[0], g[2]], [g[1], g[3]]],
    [[g[0], g[3]], [g[1], g[2]]],
  ];
  let best = null, bestC = Infinity;
  for (const [a, b] of shuffle(options)) {
    const c = splitCost(h, a, b);
    if (c < bestC) { bestC = c; best = [a, b]; }
  }
  return { teams: best, cost: bestC };
}

function chooseSitters(doc, h, players, sitCount) {
  if (sitCount <= 0) return [];
  const last = doc.rounds[doc.rounds.length - 1];
  const satLast = new Set(last ? last.byes || [] : []);
  const ranked = shuffle(players).sort((x, y) =>
    (h.byes[x.id] || 0) - (h.byes[y.id] || 0) ||
    (satLast.has(x.id) ? 1 : 0) - (satLast.has(y.id) ? 1 : 0) ||
    (h.apps[y.id] || 0) - (h.apps[x.id] || 0));
  return ranked.slice(0, sitCount).map((p) => p.id);
}

function makeRound(doc) {
  const players = activePlayers(doc);
  const courts = Math.min(doc.courts, Math.floor(players.length / 4));
  if (courts < 1) throw new Error('Need at least 4 players to make a round.');
  const h = history(doc);
  const byes = chooseSitters(doc, h, players, players.length - courts * 4);
  const playing = players.filter((p) => !byes.includes(p.id)).map((p) => p.id);

  let groups;
  if (doc.format === 'mexicano' && doc.rounds.some(isRoundComplete)) {
    // Mexicano: group by current ladder position, 1st+4th vs 2nd+3rd.
    const order = standings(doc).map((s) => s.id).filter((id) => playing.includes(id));
    groups = [];
    for (let i = 0; i < courts; i++) {
      const g = order.slice(i * 4, i * 4 + 4);
      groups.push([[g[0], g[3]], [g[1], g[2]]]);
    }
  } else {
    // Americano: many random tries, keep the one with the fewest repeat partners/opponents.
    let best = null, bestC = Infinity;
    for (let t = 0; t < 600; t++) {
      const s = shuffle(playing);
      let cost = 0;
      const gs = [];
      for (let i = 0; i < courts; i++) {
        const r = bestSplit(h, s.slice(i * 4, i * 4 + 4));
        cost += r.cost; gs.push(r.teams);
      }
      if (cost < bestC) { bestC = cost; best = gs; if (cost === 0) break; }
    }
    groups = best;
  }

  const n = doc.rounds.length + 1;
  return {
    n,
    createdAt: Date.now(),
    byes,
    matches: groups.map(([a, b], i) => ({
      id: code(8), court: i + 1, a, b, sa: null, sb: null, done: false,
    })),
  };
}

// --- Stats -----------------------------------------------------------------

function stats(doc, table) {
  const name = Object.fromEntries(doc.players.map((p) => [p.id, p.name]));
  const done = [];
  doc.rounds.forEach((r) => r.matches.forEach((m) => { if (m.done) done.push({ ...m, round: r.n }); }));
  const out = { matchesPlayed: done.length, totalPoints: 0, awards: [] };
  if (!done.length) return out;
  out.totalPoints = done.reduce((s, m) => s + m.sa + m.sb, 0);

  const played = table.filter((s) => s.played > 0);
  const top = played.slice().sort((a, b) => b.pf - a.pf)[0];
  if (top) out.awards.push({ key: 'scorer', icon: '🎯', title: 'Top Scorer', ids: [top.id], value: `${top.pf} pts`, sub: `${top.avg} per match` });

  const hot = played.slice().sort((a, b) => b.bestStreak - a.bestStreak || b.pf - a.pf)[0];
  if (hot && hot.bestStreak >= 2) out.awards.push({ key: 'streak', icon: '🔥', title: 'Hottest Streak', ids: [hot.id], value: `${hot.bestStreak} wins in a row`, sub: hot.streak >= 3 ? 'Still on fire' : 'Best run of the day' });

  const duos = {};
  for (const m of done) {
    for (const [team, f, a] of [[m.a, m.sa, m.sb], [m.b, m.sb, m.sa]]) {
      const k = pk(team[0], team[1]);
      const d = duos[k] || (duos[k] = { ids: team.slice(), pts: 0, games: 0, wins: 0, diff: 0 });
      d.pts += f; d.games++; d.diff += f - a; if (f > a) d.wins++;
    }
  }
  const duo = Object.values(duos).sort((a, b) => b.diff / b.games - a.diff / a.games || b.pts - a.pts)[0];
  if (duo) out.awards.push({ key: 'duo', icon: '🤝', title: 'Dream Team', ids: duo.ids, value: `${duo.diff >= 0 ? '+' : ''}${duo.diff} together`, sub: `${duo.wins}/${duo.games} wins` });

  const big = done.slice().sort((a, b) => Math.abs(b.sa - b.sb) - Math.abs(a.sa - a.sb))[0];
  if (big && big.sa !== big.sb) {
    const win = big.sa > big.sb ? big.a : big.b;
    out.awards.push({ key: 'smash', icon: '💥', title: 'Biggest Smashing', ids: win, value: `${Math.max(big.sa, big.sb)}–${Math.min(big.sa, big.sb)}`, sub: `Round ${big.round}, Court ${big.court}` });
  }

  const wall = played.filter((s) => s.played >= 2).sort((a, b) => a.pa / a.played - b.pa / b.played)[0];
  if (wall) out.awards.push({ key: 'wall', icon: '🧱', title: 'The Wall', ids: [wall.id], value: `${Math.round((wall.pa / wall.played) * 10) / 10} conceded`, sub: 'per match, lowest of anyone' });

  const climb = table.slice().sort((a, b) => b.move - a.move)[0];
  if (climb && climb.move >= 2) out.awards.push({ key: 'climber', icon: '🚀', title: 'Rocket', ids: [climb.id], value: `Up ${climb.move} spots`, sub: 'Biggest climb this round' });

  const unbeaten = played.filter((s) => s.played >= 2 && s.l === 0);
  if (unbeaten.length) out.awards.push({ key: 'unbeaten', icon: '🛡️', title: 'Unbeaten', ids: unbeaten.map((s) => s.id), value: unbeaten.length === 1 ? `${unbeaten[0].w}W ${unbeaten[0].d}D` : `${unbeaten.length} players`, sub: 'Haven\'t lost yet' });

  const cold = played.filter((s) => s.streak <= -3).sort((a, b) => a.streak - b.streak)[0];
  if (cold) out.awards.push({ key: 'cold', icon: '🥶', title: 'Ice Cold', ids: [cold.id], value: `${-cold.streak} losses on the trot`, sub: 'Due for a big one' });

  // Round MVP team: highest score in the most recent complete round.
  const lastDone = [...doc.rounds].reverse().find(isRoundComplete);
  if (lastDone) {
    let mvp = null;
    for (const m of lastDone.matches) {
      for (const [team, f, a] of [[m.a, m.sa, m.sb], [m.b, m.sb, m.sa]]) {
        if (!mvp || f - a > mvp.margin) mvp = { ids: team, f, a, margin: f - a };
      }
    }
    if (mvp) out.awards.push({ key: 'mvp', icon: '⭐', title: `Round ${lastDone.n} MVPs`, ids: mvp.ids, value: `${mvp.f}–${mvp.a}`, sub: 'Best result last round' });
  }

  for (const a of out.awards) a.names = a.ids.map((id) => name[id] || '?');
  return out;
}

module.exports = {
  code, token, shuffle, tally, standings, makeRound, stats, isRoundComplete, activePlayers, byeCredit,
};
