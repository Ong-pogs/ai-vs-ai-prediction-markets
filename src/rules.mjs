// The one fixed rule that turns a contestant's answers into bets. It is the same for every contestant,
// so the only thing that differs between them is what they answered.

/**
 * answers: {g1: {call, pYes, lean, strength}}, slate: [{gid: 'g1', ...}] in the order the games were shown.
 * With a minimum above zero the round is a forced pick: the highest strength scores are bet, on the side leaned to.
 * With a minimum of zero only BUY calls are bet.
 * Returns every eligible pick, strongest first. The runner bets down this list until `max` bets have filled, so an
 * order that does not fill (a quiet book) is replaced by the contestant's next strongest pick.
 */
export function chooseBets(answers, slate, rules) {
  const {min, max} = rules.betsPerRound;
  const pool = [];
  slate.forEach((game, order) => {
    const answer = answers?.[game.gid];
    if (!answer) return;
    if (min > 0) {
      // A buy call names the side outright; otherwise the side is the one the contestant leans to.
      const side = answer.call === 'BUY_YES' ? 'YES' : answer.call === 'BUY_NO' ? 'NO' : answer.lean;
      if (side === 'YES' || side === 'NO') pool.push({gid: game.gid, side, strength: answer.strength ?? 0, order});
    } else if (answer.call === 'BUY_YES' || answer.call === 'BUY_NO') {
      pool.push({gid: game.gid, side: answer.call === 'BUY_YES' ? 'YES' : 'NO', strength: answer.strength ?? 0, order});
    }
  });
  pool.sort((a, b) => b.strength - a.strength || a.order - b.order);
  return pool.map(({gid, side, strength}) => ({gid, side, strength}));
}

/** The bets a contestant is due this round: the strongest `max` of its ranked picks. */
export const topBets = (ranked, rules) => ranked.slice(0, rules.betsPerRound.max);

/** How many of the answers were a buy the contestant wanted, and how many were skips. Kept for every round. */
export function wantedCounts(answers) {
  const rows = Object.values(answers || {});
  return {buy: rows.filter(a => a.call === 'BUY_YES' || a.call === 'BUY_NO').length, skip: rows.filter(a => a.call === 'SKIP').length};
}
