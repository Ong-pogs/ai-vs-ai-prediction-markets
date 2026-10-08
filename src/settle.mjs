// Predictefy's paper engine does not settle Polymarket or Kalshi positions by itself, so the harness reads each
// market's real resolution through Predictefy (GET /api/{venue}/fetchMarket) and settles its own ledger.
// A market counts as settled only when Predictefy says it is resolved AND the price of the held outcome is decisive.
// A resolved market can still carry an old in-game price, and that is never treated as a result.

export function readResolution(market, outcomeId, {decisive = 0.985} = {}) {
  if (!market) return {state: 'unknown'};
  const outcomes = market.outcomes || [];
  const held = outcomes.find(o => String(o.outcomeId) === String(outcomeId));
  const price = typeof held?.price === 'number' ? held.price : null;
  const base = {status: market.status, price, asOf: market.asOf ?? null, priceBasis: held?.priceBasis ?? null};
  if (market.status !== 'resolved') return {state: 'open', ...base};
  if (price === null) return {state: 'unclear', ...base};
  if (price >= decisive) return {state: 'won', payoutPerShare: 1, ...base};
  if (price <= 1 - decisive) return {state: 'lost', payoutPerShare: 0, ...base};
  return {state: 'unclear', ...base};
}

export function describeResolution(venue, marketId, reading) {
  const price = reading.price === null || reading.price === undefined ? 'no price' : `outcome price ${reading.price}`;
  return `Predictefy GET /api/${venue}/fetchMarket?marketId=${marketId}: status ${reading.status}, ${price}${reading.asOf ? `, as of ${reading.asOf}` : ''}`;
}
