'use strict';
// Quick sanity test: simulate tournaments and check fairness of the scheduler.
const E = require('../src/engine');
const assert = require('assert');

function sim(nPlayers, courts, rounds, format) {
  const doc = { players: [], rounds: [], courts, points: 24, scoring: 'points', format, byePoints: true };
  for (let i = 0; i < nPlayers; i++) doc.players.push({ id: 'p' + i, name: 'Player ' + i, active: true });
  for (let r = 0; r < rounds; r++) {
    const round = E.makeRound(doc);
    const ids = round.matches.flatMap((m) => [...m.a, ...m.b]);
    assert.strictEqual(new Set(ids).size, ids.length, 'nobody plays twice in a round');
    assert.strictEqual(ids.length + round.byes.length, nPlayers, 'everyone is either playing or sitting');
    for (const m of round.matches) { m.sa = Math.floor(Math.random() * 25); m.sb = 24 - m.sa; m.done = true; }
    doc.rounds.push(round);
  }
  const table = E.standings(doc);
  const partners = {};
  for (const r of doc.rounds) for (const m of r.matches) for (const t of [m.a, m.b]) {
    const k = t.slice().sort().join('|'); partners[k] = (partners[k] || 0) + 1;
  }
  const maxRepeat = Math.max(...Object.values(partners));
  const byes = table.map((s) => s.byes);
  const stats = E.stats(doc, table);
  return { maxRepeat, byeSpread: Math.max(...byes) - Math.min(...byes), awards: stats.awards.map((a) => a.title), leader: table[0] };
}

for (const [n, c, r, f] of [[8, 2, 7, 'americano'], [9, 2, 9, 'americano'], [12, 3, 8, 'americano'], [10, 2, 6, 'mexicano'], [5, 2, 5, 'americano'], [16, 4, 6, 'americano']]) {
  const out = sim(n, c, r, f);
  console.log(`${n} players, ${c} courts, ${r} rounds, ${f}: max partner repeat ${out.maxRepeat}, bye spread ${out.byeSpread}, leader ${out.leader.name} ${out.leader.points}pts`);
  if (f === 'americano' && n === 8) assert.strictEqual(out.maxRepeat, 1, '8 players over 7 rounds should never repeat a partner');
  assert.ok(out.byeSpread <= 1, 'sit-outs are spread evenly');
}
console.log('All engine checks passed ✅');
