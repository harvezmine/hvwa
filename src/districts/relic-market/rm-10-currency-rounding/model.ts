// model.ts — RM-10's three balances, per-player state, the exact net worth, the contract every levels/<level>.ts
// implements and the proof. Not served: View Source shows only levels/*.ts, and nothing here has a route.
import type { Level } from '../../../core/levels.js';
import { catalogOf, newShop, perShop, type Currency, type ShopState } from '../_shared/shop.js';

export type { Currency } from '../_shared/shop.js';

/** US cents every instance starts with: $10.00. Crowns and rupiah start at 0. */
export const START_WALLET = 1000;

/** No cart here, but a shop state has a catalog. */
export const CATALOG = catalogOf([]);

/** One exchange the player made, as the history lists it. */
export interface Exchange {
  readonly no: number;
  readonly from: Currency;
  readonly to: Currency;
  /** Whole minor units taken from `from`. */
  readonly debit: number;
  /** Whole minor units given in `to`. */
  readonly credit: number;
}

/** One player's shop at one level. `wallet` is the US dollars (cents); crowns and rupiah are whole units. */
export interface LabState extends ShopState {
  crn: number;
  idr: number;
  /** Set (and kept) the moment an exchange makes the proof hold, so the flag stays after later trades. */
  goalReached: boolean;
  /** Oldest first, at most LIMITS.history. Numbered with the shop's own counter. */
  readonly history: Exchange[];
}

const labs = perShop((): LabState => ({
  ...newShop({ catalog: CATALOG, wallet: START_WALLET }), crn: 0, idr: 0, goalReached: false, history: [],
}));
export const labFor = (req: { sessionId: string; level: Level }): LabState => labs.for(req);
/** Test seam: the lab state of session `sessionId` at `level` (balances, history). */
export const labState = (sessionId: string, level: Level): LabState => labs.for({ sessionId, level });
/** Restart lab: drop this (session, level)'s shop. Nothing here is a limiter or a budget, so a fresh shop helps no exploit. */
export const resetLab = (req: { sessionId: string; level: Level }): void => { labs.reset(req); };

export const CURRENCY_CODES: ReadonlySet<string> = new Set<Currency>(['USD', 'CRN', 'IDR']);
export const isCurrency = (s: string): s is Currency => CURRENCY_CODES.has(s);

/** A pair is USD against crowns or rupiah, either way round: nothing else is exchanged. */
export const isPair = (from: Currency, to: Currency): boolean => (from === 'USD') !== (to === 'USD');

/** A balance by currency. */
export function balanceOf(state: LabState, c: Currency): number {
  return c === 'USD' ? state.wallet : c === 'CRN' ? state.crn : state.idr;
}

/** Set a balance by currency. */
export function setBalance(state: LabState, c: Currency, units: number): void {
  if (c === 'USD') state.wallet = units;
  else if (c === 'CRN') state.crn = units;
  else state.idr = units;
}

/** Platform safety, not the lesson: no balance may pass this many units, so every sum stays far inside the safe integers. */
export const MAX_BALANCE = 1_000_000_000_000;

/**
 * Exact net worth in units of 1/325 cent: 1 cent is 325, 1 crown ($1.00) is 100 x 325, and 1 rupiah is 2 (16,250 IDR to
 * the dollar makes 162.5 IDR a cent). Integer arithmetic, so it is exact; BigInt so no balance can overflow it.
 */
export function netWorthScaled(state: Pick<LabState, 'wallet' | 'crn' | 'idr'>): bigint {
  return BigInt(state.wallet) * 325n + BigInt(state.crn) * 32_500n + BigInt(state.idr) * 2n;
}

/** The goal: at least $1.00 (100 cents = 32 500 scaled) above what THIS instance started with. */
export function goalScaled(state: Pick<LabState, 'startWallet'>): bigint {
  return BigInt(state.startWallet) * 325n + 32_500n;
}

/** What a level decided for an exchange: how many units leave `from` and how many arrive in `to`. */
export interface Conversion { readonly debit: number; readonly credit: number }

/** A published rate table: whatever columns the level uses, as plain numbers (served at GET /api/rates). */
export type RateTable = Readonly<Record<string, Readonly<Record<string, number>>>>;

/** What every levels/<level>.ts exports (checked by byLevel<RateLevel> in challenge.ts). */
export interface RateLevel {
  /** The rate table this level converts with, public at GET <lab>/api/rates: whatever the level uses is shown. */
  readonly RATES: RateTable;
  /**
   * Convert `n` units (1 to 999 999 999, within the balance) of `from` into `to` (a valid USD pair): the units taken
   * and given, or why not.
   */
  convert(from: Currency, to: Currency, n: number): Conversion | string;
}

/**
 * The proof (the oracle, not the flaw): this instance's exact net worth is at least $1.00 above its own start, which
 * no sequence of exchanges at correct rates can reach.
 */
export function proves(state: LabState): boolean {
  return netWorthScaled(state) >= goalScaled(state);
}
