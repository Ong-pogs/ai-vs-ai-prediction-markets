// Each contestant's own books: cash, open bets and settled bets. The paper account at Predictefy is shared with
// everything else on the same API key, so the harness never reads its balance; it tracks only its own orders.
import {round4} from './util.mjs';

export function newAccount(startingCash) {
  return {startingCash, cash: startingCash, positions: [], realized: 0, feesPaid: 0, staked: 0};
}

export function openPosition(account, position) {
  account.cash = round4(account.cash - position.cost);
  account.feesPaid = round4(account.feesPaid + position.fees);
  account.staked = round4(account.staked + position.cost);
  account.positions.push({...position, state: 'open', mark: position.avgPrice, markAsOf: position.openedAt, markSource: 'fill price'});
}

export function settlePosition(position, account, {won, how, at}) {
  const payout = won ? position.shares : 0;
  position.state = won ? 'won' : 'lost';
  position.payout = payout;
  position.pnl = round4(payout - position.cost);
  position.settledAt = at;
  position.how = how;
  account.cash = round4(account.cash + payout);
  account.realized = round4(account.realized + position.pnl);
}

export const openPositions = account => account.positions.filter(p => p.state === 'open');
export const openValue = account => round4(openPositions(account).reduce((sum, p) => sum + p.shares * (p.mark ?? p.avgPrice), 0));
export const equity = account => round4(account.cash + openValue(account));

export function summary(account) {
  const settled = account.positions.filter(p => p.state !== 'open');
  const open = openPositions(account);
  return {
    cash: account.cash, openValue: openValue(account), equity: equity(account), pnl: round4(equity(account) - account.startingCash),
    realized: account.realized, feesPaid: account.feesPaid, staked: account.staked,
    bets: account.positions.length, settled: settled.length, won: settled.filter(p => p.state === 'won').length,
    lost: settled.filter(p => p.state === 'lost').length, open: open.length, openCost: round4(open.reduce((sum, p) => sum + p.cost, 0)),
  };
}
