#!/usr/bin/env node
// Launcher. Node's fetch / WebSocket only use HTTP(S)_PROXY when NODE_USE_ENV_PROXY=1 is set at process start, and
// the BSC RPC / baw calls time out without it behind a local proxy; so re-exec once with it set, before any app module
// loads. Node < 22 has no global WebSocket, which the listener needs.
import { spawn } from 'node:child_process'

const [major] = process.versions.node.split('.').map(Number)
if (major < 22) {
  console.error(`gang-sniper needs Node.js 22 or newer (found ${process.version}).`)
  process.exit(1)
}

const proxied = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'].some((v) => process.env[v])
if (proxied && process.env.NODE_USE_ENV_PROXY !== '1') {
  const child = spawn(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1' } })
  // `kill <pid>` / pm2 / systemd signal this launcher, not the child: pass it on so the sniper stops cleanly
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig))
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
} else {
  await import('../src/cli.js')
}
