/**
 * The Electron main process's OS-keychain-backed credential store: the
 * desktop peer of the local provider's `.credentials.yaml` document. Every
 * value is `safeStorage` ciphertext (macOS Keychain, Windows DPAPI, Linux
 * libsecret/KWallet) held in one JSON document under the app's `userData`;
 * the main process is the single writer, so one in-process operation chain
 * replaces the document lock, and `modifyRecord` exclusion runs as a per-key
 * lease whose holder self-expires, so a crashed mutation cannot wedge the
 * key. Pure over an injected crypto face so tests drive it without Electron.
 * @module @deepseek-ai/dsh-desktop/credential-store
 */

import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isDesktopCredentialRecord, type DesktopCredentialRecordWire } from '@deepseek-ai/dsh-host-desktop-electron'

/** The Electron `safeStorage` face this store encrypts and decrypts through. */
export interface SafeStorageCrypto {
  isEncryptionAvailable(): boolean
  encryptString(plaintext: string): Buffer
  decryptString(encrypted: Buffer): string
}

/** Store construction parameters. */
export interface CredentialStoreOptions {
  /** Absolute path of the JSON document this store owns exclusively. */
  readonly filename: string
  /** The OS-keychain crypto face; the Electron main process passes `safeStorage`. */
  readonly crypto: SafeStorageCrypto
}

/** The on-disk layout: version plus ciphertext-mapped key spaces. */
interface StoreDocument {
  readonly version: 1
  /** Reference entries as base64 ciphertext, keyed by reference name. */
  readonly refs: Record<string, string>
  /** Record entries: the kind tag in the clear for listing, the record JSON as base64 ciphertext. */
  readonly records: Record<string, { readonly kind: 'api-key' | 'grant'; readonly value: string }>
}

/** Permission bits outside the owner; a credentials document must have none of them. */
const GROUP_OTHER_BITS = 0o077

/**
 * How long one record lease may held. A mutation runs its caller's decision
 * while holding the lease, and that decision may include a network round
 * trip; the wait mirrors the local provider's document-lock bound, which is
 * sized by what a provider request costs.
 */
export const LEASE_TIMEOUT_MS = 30_000

/** One held record lease: its token, its expiry, and the waiters queued behind it. */
interface HeldLease {
  readonly key: string
  readonly token: string
  readonly timer: ReturnType<typeof setTimeout>
  /** Resolvers of lease requests queued behind this holder; run in order on release. */
  readonly waiters: Array<() => void>
}

/** Whether a filesystem error means absence; every non-ENOENT failure must surface. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Reject a credentials document other OS users can read, before its contents are read at all. */
async function assertOwnerOnly(filename: string): Promise<void> {
  let mode: number
  try {
    mode = (await stat(filename)).mode
  } catch (error) {
    if (!isENOENT(error)) throw error
    return
  }
  /* v8 ignore next -- POSIX coverage cannot take the Windows peer; native Windows coverage does. */
  if (process.platform === 'win32') return
  /* v8 ignore start -- the mode refusal is enforced by POSIX store tests. */
  const offending = mode & GROUP_OTHER_BITS
  if (offending !== 0) {
    throw new Error(
      `credential store: ${filename} is readable beyond its owner (mode ${(mode & 0o777).toString(8)});`
      + ` run "chmod 600 ${filename}" before starting again`,
    )
  }
  /* v8 ignore stop */
}

/** Parse and validate the store document; an unreadable document fails loud, never "empty". */
function parseStoreDocument(text: string, filename: string): StoreDocument {
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch (error) {
    throw new Error(`credential store: ${filename} is not valid JSON (${(error as Error).message})`)
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    throw new Error(`credential store: ${filename} must hold a JSON object`)
  }
  const fields = root as Record<string, unknown>
  if (fields['version'] !== 1) {
    throw new Error(`credential store: ${filename} declares no readable version 1 layout`)
  }
  for (const key of Object.keys(fields)) {
    if (key !== 'version' && key !== 'refs' && key !== 'records') {
      throw new Error(`credential store: unknown top-level key "${key}" in ${filename}`)
    }
  }
  const refs: Record<string, string> = {}
  const rawRefs = fields['refs'] ?? {}
  if (typeof rawRefs !== 'object' || Array.isArray(rawRefs)) {
    throw new Error(`credential store: "refs" in ${filename} must be an object`)
  }
  for (const [name, value] of Object.entries(rawRefs as Record<string, unknown>)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`credential store: the entry for "${name}" in ${filename} is not ciphertext`)
    }
    refs[name] = value
  }
  const records: StoreDocument['records'] = {}
  const rawRecords = fields['records'] ?? {}
  if (typeof rawRecords !== 'object' || Array.isArray(rawRecords)) {
    throw new Error(`credential store: "records" in ${filename} must be an object`)
  }
  for (const [key, entry] of Object.entries(rawRecords as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)
      || (entry as Record<string, unknown>)['kind'] !== 'api-key' && (entry as Record<string, unknown>)['kind'] !== 'grant'
      || typeof (entry as Record<string, unknown>)['value'] !== 'string') {
      throw new Error(`credential store: the record "${key}" in ${filename} is not a stored entry`)
    }
    const record = entry as { kind: 'api-key' | 'grant'; value: string }
    if (record.value.length === 0) {
      throw new Error(`credential store: the record "${key}" in ${filename} has empty ciphertext`)
    }
    records[key] = record
  }
  return { version: 1, refs, records }
}

/** Render the document for persistence. */
function renderStoreDocument(document: StoreDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`
}

/** The store's operation surface; every method is safe to call concurrently. */
export interface CredentialStore {
  /** Whether one reference is stored; never decrypts. */
  has(ref: string): Promise<boolean>
  /** Resolve one reference's plaintext, or null while unconfigured. */
  get(ref: string): Promise<string | null>
  /**
   * Store one reference's value.
   * @returns whether the store changed (the value differed).
   */
  set(ref: string, value: string): Promise<boolean>
  /**
   * Remove one reference.
   * @returns whether the store changed (the reference was present).
   */
  unset(ref: string): Promise<boolean>
  /** One record's presence and kind; never decrypts. */
  recordStatus(key: string): Promise<{ configured: boolean; kind?: 'api-key' | 'grant' }>
  /** One record's decrypted value, or null while none is stored. */
  readRecord(key: string): Promise<DesktopCredentialRecordWire | null>
  /** Every stored record's address and kind; never decrypts. */
  listRecords(): Promise<Array<{ key: string; kind: 'api-key' | 'grant' }>>
  /**
   * Acquire one record's mutation lease and read its current value; waits
   * behind an earlier holder and fails once the holder's own expiry lapses.
   * @returns the lease token and the record as it stands.
   */
  leaseRecord(key: string): Promise<{ lease: string; record: DesktopCredentialRecordWire | null }>
  /**
   * Write one record under its lease and release it.
   * @returns the record as committed.
   */
  commitRecord(key: string, lease: string, record: DesktopCredentialRecordWire): Promise<DesktopCredentialRecordWire>
  /** Release one lease without writing; a mutation that declined or threw. */
  abortLease(lease: string): Promise<void>
  /**
   * Remove one record.
   * @returns whether the store changed (the record was present).
   */
  deleteRecord(key: string): Promise<boolean>
}

/**
 * Open the credential store over one document.
 * @param options - the document path and the OS-keychain crypto face.
 * @returns the store's operation surface.
 */
export function createCredentialStore(options: CredentialStoreOptions): CredentialStore {
  const { filename, crypto } = options

  /** Loaded lazily on first use; every write updates the cache and the file together. */
  let cache: StoreDocument | undefined
  /**
   * Single exclusive operation chain: loads and writes run one at a time in
   * queue order, so an edit can never render from state a concurrent write is
   * replacing.
   */
  let operations: Promise<unknown> = Promise.resolve()

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const task = operations.then(operation, operation)
    operations = task.then(() => undefined, () => undefined)
    return task
  }

  /** The cached-or-disk document read; callers already inside the operation chain use this directly. */
  const readDocument = async (): Promise<StoreDocument> => {
    if (cache !== undefined) return cache
    await assertOwnerOnly(filename)
    let text: string
    try {
      text = await readFile(filename, 'utf8')
    } catch (error) {
      if (!isENOENT(error)) throw error
      cache = { version: 1, refs: {}, records: {} }
      return cache
    }
    cache = parseStoreDocument(text, filename)
    return cache
  }

  /** A cold-cache read joins the chain so it cannot interleave with a write. */
  const load = (): Promise<StoreDocument> => cache !== undefined
    ? Promise.resolve(cache)
    : enqueue(readDocument)

  const persist = async (next: StoreDocument): Promise<void> => {
    // Re-checked before every write: an external editor or a restored backup
    // can loosen the mode after boot.
    await assertOwnerOnly(filename)
    await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
    // 0600: a document holding secrets is never world-readable.
    await writeFileAtomic(filename, renderStoreDocument(next), { mode: 0o600, dirMode: 0o700 })
    cache = next
  }

  const assertCrypto = (): void => {
    if (!crypto.isEncryptionAvailable()) {
      throw new Error('credential store: OS-keychain encryption is unavailable on this system, so no credential can be stored or read')
    }
  }

  const decrypt = (ciphertext: string, subject: string): string => {
    try {
      return crypto.decryptString(Buffer.from(ciphertext, 'base64'))
    } catch {
      throw new Error(
        `credential store: failed to decrypt ${subject}; the ciphertext no longer matches this system's keychain (a copied document or a re-provisioned app identity)`,
      )
    }
  }

  const encrypt = (plaintext: string): string => crypto.encryptString(plaintext).toString('base64')

  /** One held record lease per key; different keys hold concurrently. */
  const heldByKey = new Map<string, HeldLease>()
  /** Lease tokens this store ever issued; the commit/abort lookup face. */
  const leases = new Map<string, HeldLease>()

  const grantLease = (key: string, resolve: (holder: HeldLease) => void): void => {
    const holder: HeldLease = {
      key,
      token: randomUUID(),
      timer: setTimeout(() => {
        // Expiry releases the holder's slot; its later commit answers
        // "unknown lease", so a crashed mutation cannot wedge the key.
        releaseLease(holder)
      }, LEASE_TIMEOUT_MS),
      waiters: [],
    }
    heldByKey.set(key, holder)
    leases.set(holder.token, holder)
    resolve(holder)
  }

  const releaseLease = (holder: HeldLease): void => {
    clearTimeout(holder.timer)
    leases.delete(holder.token)
    /* v8 ignore next -- the token lookup already proved the holder live; the guard is defense in depth. */
    if (heldByKey.get(holder.key) !== holder) return
    const next = holder.waiters.shift()
    if (next === undefined) {
      heldByKey.delete(holder.key)
      return
    }
    // The released key's next waiter takes over in order.
    next()
  }

  const acquireLease = (key: string): Promise<HeldLease> => new Promise<HeldLease>((resolve) => {
    const current = heldByKey.get(key)
    if (current === undefined) grantLease(key, resolve)
    else current.waiters.push(() => { grantLease(key, resolve) })
  })

  const readUnderLease = async (holder: HeldLease): Promise<DesktopCredentialRecordWire | null> => {
    const document = await load()
    const entry = document.records[holder.key]
    if (entry === undefined) return null
    assertCrypto()
    const parsed: unknown = JSON.parse(decrypt(entry.value, `record "${holder.key}"`))
    if (!isDesktopCredentialRecord(parsed)) {
      throw new Error(`credential store: record "${holder.key}" decrypted to an invalid entry`)
    }
    return parsed
  }

  return {
    async has(ref): Promise<boolean> {
      return Object.hasOwn((await load()).refs, ref)
    },
    async get(ref): Promise<string | null> {
      const ciphertext = (await load()).refs[ref]
      if (ciphertext === undefined) return null
      assertCrypto()
      return decrypt(ciphertext, `the stored "${ref}"`)
    },
    set: (ref, value) => enqueue(async () => {
      assertCrypto()
      const document = await readDocument()
      const ciphertext = encrypt(value)
      if (document.refs[ref] === ciphertext) return false
      await persist({ ...document, refs: { ...document.refs, [ref]: ciphertext } })
      return true
    }),
    unset: ref => enqueue(async () => {
      const document = await readDocument()
      if (!Object.hasOwn(document.refs, ref)) return false
      const refs = Object.fromEntries(Object.entries(document.refs).filter(([stored]) => stored !== ref))
      await persist({ ...document, refs })
      return true
    }),
    async recordStatus(key) {
      const entry = (await load()).records[key]
      return entry === undefined ? { configured: false } : { configured: true, kind: entry.kind }
    },
    async readRecord(key) {
      const entry = (await load()).records[key]
      if (entry === undefined) return null
      assertCrypto()
      const parsed: unknown = JSON.parse(decrypt(entry.value, `record "${key}"`))
      if (!isDesktopCredentialRecord(parsed)) {
        throw new Error(`credential store: record "${key}" decrypted to an invalid entry`)
      }
      return parsed
    },
    async listRecords() {
      return Object.entries((await load()).records).map(([key, entry]) => ({ key, kind: entry.kind }))
    },
    async leaseRecord(key) {
      const holder = await acquireLease(key)
      try {
        return { lease: holder.token, record: await readUnderLease(holder) }
      } catch (error) {
        releaseLease(holder)
        throw error
      }
    },
    commitRecord: (key, lease, record) => enqueue(async () => {
      const holder = leases.get(lease)
      if (holder === undefined || holder.key !== key) {
        throw new Error('credential store: the record lease expired or was released before the commit')
      }
      assertCrypto()
      const document = await readDocument()
      await persist({
        ...document,
        records: { ...document.records, [key]: { kind: record.kind, value: encrypt(JSON.stringify(record)) } },
      })
      releaseLease(holder)
      return record
    }),
    abortLease(lease) {
      const holder = leases.get(lease)
      if (holder !== undefined) releaseLease(holder)
      return Promise.resolve()
    },
    deleteRecord: key => enqueue(async () => {
      const document = await readDocument()
      if (!Object.hasOwn(document.records, key)) return false
      const records = Object.fromEntries(Object.entries(document.records).filter(([stored]) => stored !== key))
      await persist({ ...document, records })
      return true
    }),
  }
}
