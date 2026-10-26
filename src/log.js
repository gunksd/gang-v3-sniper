/** NDJSON logger: one line per event to stdout and ~/.gang-sniper/sniper.log. bigint → string. */
import { appendFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { DATA_DIR } from './config.js'

mkdirSync(DATA_DIR, { recursive: true })
const FILE = resolve(DATA_DIR, 'sniper.log')
const replacer = (_, v) => (typeof v === 'bigint' ? v.toString() : v)

let quiet = false
export const setQuiet = (q) => { quiet = q }

export function log(event, fields = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), event, ...fields }, replacer)
  appendFileSync(FILE, line + '\n')
  if (!quiet) process.stdout.write(line + '\n')
}
