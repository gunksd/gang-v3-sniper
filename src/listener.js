/**
 * The one trigger: eth_subscribe("logs", { address: LaunchpadV3, topics: [Created] }).
 * Only LaunchpadV3's own Created is subscribed — no chain-wide log stream. Several WSS endpoints may be given
 * (comma separated); each one subscribes, the first copy of an event wins, duplicates are dropped by tx:logIndex.
 * A heartbeat (eth_blockNumber) detects silently dead sockets; on reconnect the gap is backfilled with getLogs and
 * handed over with `backfilled: true` so the caller can skip stale tokens.
 */
import { CREATED_TOPIC } from './abi.js'
import { parseCreated, logsFor } from './chain.js'
import { log } from './log.js'
import { redact } from './config.js'

const HEARTBEAT_MS = 15_000
const HEARTBEAT_TIMEOUT_MS = 8_000
const SEEN_CAP = 5000

export function listenCreated({ urls, pad, client, onCreated, reconnectMs = 1500, topic = CREATED_TOPIC, parse = parseCreated, fromBlock = null }) {
  const seen = new Set()
  // set before connecting so the first subscribe already backfills [fromBlock, head]
  let lastBlock = fromBlock == null ? null : fromBlock - 1n
  let stopped = false
  const sockets = new Set()

  const deliver = (ev, meta) => {
    if (!ev || ev.removed) return
    const key = `${ev.txHash}:${ev.logIndex}`
    if (seen.has(key)) return
    seen.add(key)
    if (seen.size > SEEN_CAP) seen.delete(seen.values().next().value)
    if (lastBlock == null || ev.blockNumber > lastBlock) lastBlock = ev.blockNumber
    onCreated(ev, meta)
  }

  async function backfill(from) {
    try {
      // a few blocks behind: load-balanced RPC nodes lag each other; the live subscription delivers the newest ones
      const head = (await client.getBlockNumber()) - 3n
      if (from > head) return
      // this listener's own event (V3 Created, 打新 Created / Launched …), not always V3 Created
      const evs = await logsFor(client, pad, topic, parse, from, head)
      for (const ev of evs) deliver(ev, { source: 'backfill', backfilled: true, head })
      if (lastBlock == null || head > lastBlock) lastBlock = head
    } catch (e) {
      log('backfill_error', { error: e.shortMessage || e.message })
    }
  }

  function connect(url) {
    const name = redact(url) // logs never carry an API key
    if (stopped) return
    const t0 = Date.now()
    const ws = new WebSocket(url)
    sockets.add(ws)
    let nextId = 1
    let subId = null
    let pingTimer = null
    let pongTimer = null
    const send = (method, params) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }))

    const close = (reason) => {
      clearInterval(pingTimer); clearTimeout(pongTimer)
      sockets.delete(ws)
      try { ws.close() } catch { /* already closed */ }
      if (stopped) return
      log('wss_reconnect', { url: name, reason, inMs: reconnectMs })
      setTimeout(() => connect(url), reconnectMs)
    }

    ws.onopen = () => {
      send('eth_subscribe', ['logs', { address: pad, topics: [topic] }])
      pingTimer = setInterval(() => {
        send('eth_blockNumber', [])
        pongTimer = setTimeout(() => close('heartbeat timeout'), HEARTBEAT_TIMEOUT_MS)
      }, HEARTBEAT_MS)
    }
    ws.onmessage = (m) => {
      let msg
      try { msg = JSON.parse(String(m.data)) } catch { return }
      if (msg.id === 1) {
        if (msg.error) return close(`subscribe error: ${redact(msg.error.message)}`)
        subId = msg.result
        log('wss_subscribed', { url: name, subId, ms: Date.now() - t0 })
        // anything mined while this socket was down
        if (lastBlock != null) backfill(lastBlock + 1n)
        return
      }
      if (msg.id) { clearTimeout(pongTimer); return } // heartbeat reply
      if (msg.method === 'eth_subscription' && msg.params?.subscription === subId) {
        const raw = msg.params.result
        deliver(parse(raw), { source: name, backfilled: false, receivedAt: Date.now() })
      }
    }
    ws.onerror = (e) => log('wss_error', { url: name, error: e?.message || 'socket error' })
    ws.onclose = () => { if (sockets.has(ws)) close('closed by peer') }
  }

  for (const url of urls) connect(url)
  return {
    stop() {
      stopped = true
      for (const ws of sockets) { try { ws.close() } catch { /* */ } }
      sockets.clear()
    },
    setLastBlock(b) { lastBlock = b },
  }
}
