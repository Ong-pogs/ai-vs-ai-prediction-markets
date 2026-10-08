// What every contestant is told about a market: a handful of short facts in plain words.
// Every calculation and comparison is done here, in code, so no model has to do arithmetic to read them.
import {cents, duration, percent} from './util.mjs';
import {venueName} from './markets/sportsScreen.mjs';

const list = parts => parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;

function versusFair(side, label) {
  const gap = (side.cells[0].net - side.fair) * 100;
  if (Math.abs(gap) < 0.5) return `the cheapest ${label} is about the same as the fair price`;
  return `the cheapest ${label} is ${Number(Math.abs(gap).toFixed(1))} cents ${gap > 0 ? 'above' : 'below'} the fair price`;
}

/**
 * `fairPrice: false` leaves Predictefy's cross-venue fair price out of what the contestants see. With it in view
 * every model simply picks whichever side sits closest to fair; without it they have to judge the game themselves.
 * The fair price is still saved with every game, for scoring.
 */
export function buildFacts(game, id, nowMs = Date.now(), {fairPrice = true} = {}) {
  const untilStart = game.kickoffMs - nowMs;
  const when = game.status === 'live' || untilStart <= 0
    ? `In play. It started ${duration(-untilStart)} ago.`
    : `Starts in ${duration(untilStart)}.`;
  const priceOf = (side, label) => `${label} costs ${list(side.cells.map(c => `${cents(c.ask)} on ${venueName(c.venue)}`))}.`;
  const facts = {
    id,
    game: game.title,
    when,
    yes_means: `${game.yes.name} to win`,
    no_means: `${game.no.name} to win`,
    prices: `${priceOf(game.yes, 'YES')} ${priceOf(game.no, 'NO')} A winning share pays 100 cents.`,
  };
  if (!fairPrice) return facts;
  if (game.yes.fair !== null && game.no.fair !== null) {
    const venues = Math.max(game.yes.liveVenues, game.no.liveVenues);
    facts.fair_price = `Predictefy's no-vig fair price across ${venues} venue${venues === 1 ? '' : 's'} is ${percent(game.yes.fair)} for YES and ${percent(game.no.fair)} for NO.`;
    const value = `after fees, ${versusFair(game.yes, 'YES')}, and ${versusFair(game.no, 'NO')}.`;
    facts.value = value[0].toUpperCase() + value.slice(1);
  } else {
    facts.fair_price = 'Predictefy has no cross-venue fair price for this game.';
  }
  return facts;
}
