import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { useBawBin, requireBaw, bawBin } = await import('../src/baw.js')

// a stand-in baw that answers like the real CLI does for a given wallet state
const fakeBaw = (status, address = '0x' + '1'.repeat(40)) => {
  const dir = mkdtempSync(join(tmpdir(), 'fakebaw-'))
  const bin = join(dir, 'baw')
  writeFileSync(bin, `#!/bin/sh
case "$1 $2" in
  "wallet status") echo '{"success":true,"data":{"status":"${status}"}}' ;;
  "wallet address") echo '{"success":true,"data":{"addresses":[{"binanceChainId":"56","address":"${address}"}]}}' ;;
  *) echo '{"success":false,"error":{"name":"UNKNOWN"}}' ;;
esac
`)
  chmodSync(bin, 0o755)
  return bin
}

describe('baw binary selection', () => {
  it('uses the configured wrapper and expands ~/', () => {
    useBawBin('~/.baw2-cli/bin/baw')
    expect(bawBin()).toMatch(/^\/.+\/\.baw2-cli\/bin\/baw$/)
  })

  it('requireBaw returns the address of a signed-in wallet', async () => {
    useBawBin(fakeBaw('CONNECTED', '0x' + 'a'.repeat(40)))
    expect(await requireBaw()).toBe('0x' + 'a'.repeat(40))
  })

  it('requireBaw refuses a signed-out wallet instead of continuing', async () => {
    const bin = fakeBaw('UNCONNECTED')
    useBawBin(bin)
    await expect(requireBaw()).rejects.toThrow(/未登录.*auth signin/)
  })

  it('a missing wrapper is reported by path', async () => {
    useBawBin('/nonexistent/baw')
    await expect(requireBaw()).rejects.toThrow(/\/nonexistent\/baw/)
  })
})
