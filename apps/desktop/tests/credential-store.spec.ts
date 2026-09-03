/**
 * The main-process credential store over an injected crypto face: reference
 * and record round trips, lease exclusion and expiry, availability failures,
 * and the loud refusal of a corrupt or over-shared document.
 */

import { mkdir, mkdtemp, rm, readFile, chmod, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCredentialStore, LEASE_TIMEOUT_MS, type CredentialStore, type SafeStorageCrypto } from '../src/credential-store.ts'

let dir: string | undefined
let stores: CredentialStore[] = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-credential-store-'))
})

afterEach(async () => {
  stores = []
  vi.useRealTimers()
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
})

/** A reversible stand-in for safeStorage: a magic-prefixed XOR cipher whose decrypt refuses foreign ciphertext. */
function fakeCrypto(options: { available?: boolean } = {}): SafeStorageCrypto {
  const magic = Buffer.from([0xd5, 0x5c, 0x01])
  const xor = (bytes: Buffer): Buffer => Buffer.from(bytes.map((byte, index) => byte ^ (index % 251 + 1)))
  return {
    isEncryptionAvailable: () => options.available ?? true,
    encryptString: (plain: string) => Buffer.concat([magic, xor(Buffer.from(plain, 'utf8'))]),
    decryptString: (encrypted: Buffer) => {
      if (!encrypted.subarray(0, magic.length).equals(magic)) {
        throw new Error('safeStorage refused the ciphertext')
      }
      return xor(encrypted.subarray(magic.length)).toString('utf8')
    },
  }
}

/** Ciphertext the fake crypto produced, as the document stores it. */
function seal(plain: string): string {
  return fakeCrypto().encryptString(plain).toString('base64')
}

function store(options: { available?: boolean; filename?: string } = {}): CredentialStore {
  const created = createCredentialStore({
    filename: options.filename ?? join(dir!, 'credentials.json'),
    crypto: fakeCrypto(options.available === undefined ? {} : { available: options.available }),
  })
  stores.push(created)
  return created
}

describe('the main-process credential store', () => {
  it('round trips references and reports changes exactly', async () => {
    const current = store()
    await expect(current.get('DEEPSEEK_API_KEY')).resolves.toBeNull()
    await expect(current.has('DEEPSEEK_API_KEY')).resolves.toBe(false)
    await expect(current.set('DEEPSEEK_API_KEY', 'sk-secret')).resolves.toBe(true)
    await expect(current.has('DEEPSEEK_API_KEY')).resolves.toBe(true)
    await expect(current.get('DEEPSEEK_API_KEY')).resolves.toBe('sk-secret')
    await expect(current.unset('DEEPSEEK_API_KEY')).resolves.toBe(true)
    await expect(current.unset('DEEPSEEK_API_KEY')).resolves.toBe(false)
    await expect(current.get('DEEPSEEK_API_KEY')).resolves.toBeNull()
  })

  it('never writes plaintext to the document', async () => {
    const filename = join(dir!, 'credentials.json')
    const current = store({ filename })
    await current.set('DEEPSEEK_API_KEY', 'sk-secret')
    const text = await readFile(filename, 'utf8')
    expect(text).not.toContain('sk-secret')
    expect(text).toContain('"version": 1')
  })

  it('round trips records with kind tags readable without decryption', async () => {
    const current = store()
    const record = { kind: 'grant', payload: { token: 't', refresh: 'r' } } as const
    const { lease } = await current.leaseRecord('llm-pi-ai/route')
    await expect(current.commitRecord('llm-pi-ai/route', lease, record)).resolves.toEqual(record)
    await expect(current.readRecord('llm-pi-ai/route')).resolves.toEqual(record)
    await expect(current.recordStatus('llm-pi-ai/route')).resolves.toEqual({ configured: true, kind: 'grant' })
    await expect(current.recordStatus('llm-pi-ai/absent')).resolves.toEqual({ configured: false })
    // A later lease reads the committed record under its exclusion.
    const again = await current.leaseRecord('llm-pi-ai/route')
    expect(again.record).toEqual(record)
    expect(again.lease).toBeTypeOf('string')
    await current.abortLease(again.lease)
    await expect(current.listRecords()).resolves.toEqual([{ key: 'llm-pi-ai/route', kind: 'grant' }])
    await expect(current.deleteRecord('llm-pi-ai/route')).resolves.toBe(true)
    await expect(current.deleteRecord('llm-pi-ai/route')).resolves.toBe(false)
    await expect(current.readRecord('llm-pi-ai/route')).resolves.toBeNull()
    // Re-storing the identical value under the deterministic fake reports no change.
    const other = store()
    await expect(other.set('X', 'v')).resolves.toBe(true)
    await expect(other.set('X', 'v')).resolves.toBe(false)
  })

  it('serializes leases per key and holds different keys concurrently', async () => {
    const current = store()
    const first = await current.leaseRecord('scope/one')
    let secondGranted = false
    const second = current.leaseRecord('scope/one').then((held) => {
      secondGranted = true
      return held
    })
    const other = await current.leaseRecord('scope/two')
    await new Promise(resolve => setImmediate(resolve))
    expect(secondGranted).toBe(false)
    await current.abortLease(first.lease)
    const held = await second
    expect(held.record).toBeNull()
    await current.abortLease(other.lease)
    await current.abortLease(held.lease)
  })

  it('expires an abandoned lease and refuses its late commit', async () => {
    vi.useFakeTimers()
    const current = store()
    const held = await current.leaseRecord('scope/one')
    vi.advanceTimersByTime(LEASE_TIMEOUT_MS + 1)
    await expect(current.commitRecord('scope/one', held.lease, { kind: 'grant', payload: {} }))
      .rejects.toThrow('lease expired or was released')
    const next = await current.leaseRecord('scope/one')
    expect(next.record).toBeNull()
    await current.abortLease(next.lease)
    // Aborting a token this store never issued is a no-op.
    await expect(current.abortLease('never-issued')).resolves.toBeUndefined()
  })

  it('answers an operation failure while encryption is unavailable', async () => {
    const filename = join(dir!, 'credentials.json')
    const warm = store({ filename })
    await warm.set('X', 'v')
    const record = { kind: 'grant', payload: { token: 't' } } as const
    const held = await warm.leaseRecord('scope/id')
    await warm.commitRecord('scope/id', held.lease, record)
    const current = store({ filename, available: false })
    await expect(current.set('X', 'v2')).rejects.toThrow('encryption is unavailable')
    await expect(current.get('X')).rejects.toThrow('encryption is unavailable')
    await expect(current.leaseRecord('scope/id')).rejects.toThrow('encryption is unavailable')
    // Presence facts never decrypt, so they still answer.
    await expect(current.has('X')).resolves.toBe(true)
    await expect(current.recordStatus('scope/id')).resolves.toEqual({ configured: true, kind: 'grant' })
    await expect(current.listRecords()).resolves.toEqual([{ key: 'scope/id', kind: 'grant' }])
  })

  it('fails loud on a corrupt document instead of reading it as empty', async () => {
    const filename = join(dir!, 'credentials-corrupt.json')
    const shapes: ReadonlyArray<[string, RegExp]> = [
      ['not json', /not valid JSON/u],
      ['[]', /must hold a JSON object/u],
      ['{}', /no readable version 1/u],
      ['{"version":1,"refs":[]}', /"refs" .* must be an object/u],
      ['{"version":1,"refs":{"X":7}}', /is not ciphertext/u],
      ['{"version":1,"records":[]}', /"records" .* must be an object/u],
      ['{"version":1,"records":{"a/b":"x"}}', /is not a stored entry/u],
      ['{"version":1,"records":{"a/b":{}}}', /is not a stored entry/u],
      ['{"version":1,"records":{"a/b":{"kind":"grant"}}}', /is not a stored entry/u],
      ['{"version":1,"records":{"a/b":{"kind":"grant","value":""}}}', /empty ciphertext/u],
      ['{"version":1,"unknown":1}', /unknown top-level key "unknown"/u],
    ]
    for (const [text, failure] of shapes) {
      await writeFile(filename, text, { mode: 0o600, encoding: 'utf8' })
      await expect(store({ filename }).get('X')).rejects.toThrow(failure)
    }
  })

  it('reports ciphertext that no longer matches the keychain', async () => {
    const filename = join(dir!, 'credentials.json')
    const current = store({ filename })
    await current.set('X', 'v')
    const raw = JSON.parse(await readFile(filename, 'utf8')) as { refs: Record<string, string> }
    raw.refs['X'] = Buffer.from('not-the-ciphertext').toString('base64')
    await writeFile(filename, JSON.stringify(raw), 'utf8')
    await expect(store({ filename }).get('X')).rejects.toThrow('failed to decrypt')
  })

  it('refuses a document other OS users can read', async () => {
    const filename = join(dir!, 'credentials.json')
    const current = store({ filename })
    await current.set('X', 'v')
    await chmod(filename, 0o644)
    await expect(store({ filename }).get('X')).rejects.toThrow('readable beyond its owner')
  })

  it('surfaces a document that cannot be examined at all', async () => {
    const nested = await mkdtemp(join(dir!, 'sealed-'))
    await chmod(nested, 0o000)
    try {
      await expect(store({ filename: join(nested, 'credentials.json') }).get('X'))
        .rejects.toThrow()
    } finally {
      await chmod(nested, 0o700)
    }
  })

  it('surfaces a read failure that is not absence', async () => {
    const dirname = join(dir!, 'a-directory')
    await mkdir(dirname, { mode: 0o700 })
    await expect(store({ filename: dirname }).get('X')).rejects.toThrow()
  })

  it('reports a record that decrypts to a non-record', async () => {
    const filename = join(dir!, 'credentials.json')
    const document = {
      version: 1,
      refs: {},
      records: { 'scope/id': { kind: 'grant', value: seal('"not a record"') } },
    }
    await writeFile(filename, JSON.stringify(document), { mode: 0o600, encoding: 'utf8' })
    await expect(store({ filename }).readRecord('scope/id')).rejects.toThrow('decrypted to an invalid entry')
    await expect(store({ filename }).leaseRecord('scope/id')).rejects.toThrow('decrypted to an invalid entry')
  })

  it('reads a minimal document with no key spaces', async () => {
    const filename = join(dir!, 'credentials-minimal.json')
    await writeFile(filename, '{"version":1}', { mode: 0o600, encoding: 'utf8' })
    await expect(store({ filename }).get('X')).resolves.toBeNull()
    await expect(store({ filename }).listRecords()).resolves.toEqual([])
  })
})
