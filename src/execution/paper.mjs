// Fill mode "predictefy-paper": every bet is a real order on Predictefy's paper engine (POST /v1/paper/orders,
// 0 credits). The engine fills it against the venue's real order book. Nothing is sent to any venue.
// Orders are immediate-or-cancel buys, so nothing is ever left resting on the shared paper account.
import {sleep, round4} from '../util.mjs';

const WORKING = new Set(['open', 'partially_filled']);
const TRY_NEXT_VENUE = new Set(['PAPER_NO_LIVE_BOOK', 'PAPER_MARKET_CLOSED', 'MARKET_NOT_FOUND']);

/** How many shares the stake buys at the quoted price, capped by the cash that is really free. */
export function sizeOrder(cell, stakeUsd, cash, slippage) {
  const limit = Math.min(0.99, Math.ceil((cell.ask + slippage) * 100 - 1e-6) / 100);
  const feePerShare = Math.max(0, cell.net - cell.ask) + 0.005;   // the fee at the quoted price, with a little room
  const worstPerShare = limit + feePerShare;
  const wanted = Math.max(1, Math.floor(stakeUsd / cell.net + 1e-9));
  const affordable = Math.floor(cash / worstPerShare + 1e-9);
  return {limit: Number(limit.toFixed(2)), shares: Math.min(wanted, affordable), wanted, worstPerShare: round4(worstPerShare)};
}

async function follow(client, order, {waitMs, pollMs, pause}) {
  const deadline = Date.now() + waitMs;
  let uncertain = false;
  while (WORKING.has(order.status) && Date.now() < deadline) {
    await pause(pollMs);
    const read = await client.get(`/v1/paper/orders/${order.id}`, {label: 'GET /v1/paper/orders/{id}'});
    if (read.ok && read.data) order = read.data;
  }
  if (WORKING.has(order.status)) {
    await client.post(`/v1/paper/orders/${order.id}/cancel`, {}, {label: 'POST /v1/paper/orders/{id}/cancel'});
    const read = await client.get(`/v1/paper/orders/${order.id}`, {label: 'GET /v1/paper/orders/{id}'});
    if (read.ok && read.data) order = read.data;
    uncertain = WORKING.has(order.status);
  }
  return {order, uncertain};
}

/**
 * Buys one side of one market. `cells` are that side's live quotes, cheapest first; the next venue is tried only
 * when the paper engine has no live book for the cheaper one or the order filled nothing.
 * The same key always returns the same stored order, so a retry after a crash can never buy twice.
 */
export async function paperBuy({client, key, cells, stakeUsd, cash, cfg, pause = sleep}) {
  const attempts = [];
  // A bet is the full stake or nothing: with less than one stake of free cash the contestant sits this one out.
  if (cash < stakeUsd) return {status: 'no-cash', attempts: [{result: 'no-cash', free: cash, stake: stakeUsd}]};
  for (const cell of cells) {
    const size = sizeOrder(cell, stakeUsd, cash, cfg.slippage);
    if (size.shares < 1) { attempts.push({venue: cell.venue, result: 'no-cash', needed: size.worstPerShare}); return {status: 'no-cash', attempts}; }
    const orderKey = `${key}-${cell.venue}`;
    const placed = await client.post('/v1/paper/orders',
      {venue: cell.venue, marketId: cell.marketId, outcomeId: cell.outcomeId, side: 'buy', price: size.limit, size: size.shares, tif: 'IOC'},
      {headers: {'Idempotency-Key': orderKey}, label: 'POST /v1/paper/orders'});
    if (!placed.ok || !placed.data?.id) {
      const code = placed.error?.code || `HTTP_${placed.status}`;
      attempts.push({venue: cell.venue, key: orderKey, result: 'refused', code, message: String(placed.error?.message || '').slice(0, 200)});
      if (TRY_NEXT_VENUE.has(code)) continue;
      return {status: 'error', code, attempts};
    }
    const {order, uncertain} = await follow(client, placed.data, {waitMs: cfg.fillWaitSec * 1000, pollMs: cfg.pollEverySec * 1000, pause});
    const filled = Number(order.filledSize || 0);
    attempts.push({venue: cell.venue, key: orderKey, orderId: order.id, result: order.status, limit: size.limit, ordered: size.shares, filled, replay: placed.replay});
    if (filled > 0) {
      const fees = Number(order.feesPaid || 0), avgPrice = Number(order.avgFillPrice);
      return {
        status: filled >= size.shares ? 'filled' : 'partial', venue: cell.venue, marketId: cell.marketId, outcomeId: cell.outcomeId,
        orderId: order.id, key: orderKey, quotedAsk: cell.ask, limit: size.limit, ordered: size.shares, shares: filled, avgPrice, fees,
        cost: round4(filled * avgPrice + fees), fills: order.fills || [], uncertain, attempts,
      };
    }
    if (uncertain) return {status: 'unknown', orderId: order.id, key: orderKey, uncertain, attempts};
  }
  const noBook = attempts.length > 0 && attempts.every(a => a.code === 'PAPER_NO_LIVE_BOOK');
  return {status: noBook ? 'no-live-book' : 'no-fill', attempts};
}
