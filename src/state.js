/**
 * Persistent state in ~/.gang-sniper/state.json: open/closed positions, sniped tokens, daily spend counters.
 * Written atomically (tmp + rename) after every change so a crash never loses a fill.
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { DATA_DIR } from './config.js'

const FILE = resolve(DATA_DIR, 'state.json')
const replacer = (_, v) => (typeof v === 'bigint' ? v.toString() : v)
const today = () => new Date().toISOString().slice(0, 10)

const empty = () => ({ positions: {}, sniped: {}, daily: { date: today(), spent: {}, perCreator: {} } })

export function loadState() {
  const s = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : empty()
  return rollDay(s)
}

/** New day → fresh daily counters (positions untouched). */
export function rollDay(s) {
  if (s.daily?.date === today()) return s
  return { ...s, daily: { date: today(), spent: {}, perCreator: {} } }
}

export function saveState(s) {
  const tmp = `${FILE}.tmp`
  writeFileSync(tmp, JSON.stringify(s, replacer, 2))
  renameSync(tmp, FILE)
}

/** Reserve a token before sending so concurrent events (two WSS, backfill) can't double-buy it. */
export function markSniped(s, token, info) {
  return { ...s, sniped: { ...s.sniped, [token.toLowerCase()]: { at: Date.now(), ...info } } }
}

export function addSpend(s, key, amount, creator) {
  const spent = BigInt(s.daily.spent[key] || 0) + amount
  const c = creator.toLowerCase()
  return {
    ...s,
    daily: {
      ...s.daily,
      spent: { ...s.daily.spent, [key]: spent.toString() },
      perCreator: { ...s.daily.perCreator, [c]: (s.daily.perCreator[c] || 0) + 1 },
    },
  }
}

export function putPosition(s, pos) {
  return { ...s, positions: { ...s.positions, [pos.token.toLowerCase()]: pos } }
}

export const openPositions = (s) => Object.values(s.positions).filter((p) => p.status === 'open')

/** Correct the day's spend (e.g. estimate → actual cost from the receipt) without counting another buy. */
export function adjustSpend(s, key, delta) {
  const spent = BigInt(s.daily.spent[key] || 0) + delta
  return { ...s, daily: { ...s.daily, spent: { ...s.daily.spent, [key]: (spent < 0n ? 0n : spent).toString() } } }
}
