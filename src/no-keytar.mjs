/**
 * Preloaded (node --import) into the sniper's own `baw` child. baw keeps its session id in the OS keychain under one
 * fixed entry ("baw" / "agentSessionId"), so a second wallet signed in on the same machine would overwrite the first.
 * Making `@github/keytar` unresolvable sends baw down its built-in no-keychain path: the session id is stored,
 * encrypted, in BINANCE_BAW_DIR/session.json instead, and the keychain entry (the user's default wallet) is untouched.
 */
import { register } from 'node:module'

const hook = `
export async function resolve(specifier, context, next) {
  if (specifier === '@github/keytar') {
    const e = new Error('keytar disabled for an isolated baw session')
    e.code = 'ERR_MODULE_NOT_FOUND'
    throw e
  }
  return next(specifier, context)
}`

register(`data:text/javascript,${encodeURIComponent(hook)}`)
