/**
 * OS-keychain-backed credentials provider for the desktop shell: the
 * environment half resolves exactly like the local provider (inherited
 * process environment wins read-only, project and user `.env` files fall
 * back below the managed store), while the provider-managed writable source
 * lives in the Electron main process — one `safeStorage`-encrypted document
 * under the app's `userData`, reached over the desktop IPC carrier's native
 * lane. Runs in the desktop host child (plain Node) and imports no Electron
 * module; only the desktop composition mounts it, because the
 * `desktopRuntime` lane it reads exists only there.
 * @module @deepseek-ai/dsh-credentials-electron
 */

import type {
  DesktopNativeOp,
  DesktopNativeRequestArgs,
  DesktopNativeValue,
} from '@deepseek-ai/dsh-host-desktop-electron'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { CredentialProvider, parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRecordEntry,
  CredentialRecordInfo,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import type { LaunchEnvironmentEntry } from '@deepseek-ai/dsh-launch-environment'

/** The desktop carrier lane this provider reads, typed per native op. */
interface DesktopRuntimeLane {
  nativeRequest<Op extends DesktopNativeOp>(
    op: Op,
    args: DesktopNativeRequestArgs[Op],
    signal: AbortSignal,
  ): Promise<DesktopNativeValue[Op]>
}

/** The `ctx.credentials` OS-keychain implementation. */
export default class ElectronCredentialProvider extends CredentialProvider {
  /** The carrier lane; the composition must mount `desktopRuntime` for any operation. */
  private lane(): DesktopRuntimeLane {
    const lane = this.ctx.get('desktopRuntime') as DesktopRuntimeLane | undefined
    if (lane === undefined) {
      throw new Error('credentials-electron: the desktop composition exposes no desktopRuntime lane')
    }
    return lane
  }

  /**
   * One operation's signal. The seam carries no caller abort, and every
   * native credential operation is a bounded main-process round trip, so each
   * call takes a fresh never-aborted signal.
   */
  private signal(): AbortSignal {
    return new AbortController().signal
  }

  /** The inherited-environment value for a reference, or `undefined` when empty or unset. */
  private inherited(ref: CredentialRef): string | undefined {
    const entry = launchEnvironmentOf(this.ctx).getFrom(ref, ['process'])
    return entry !== undefined && entry.value.length > 0 ? entry.value : undefined
  }

  /**
   * The `.env` fallback for a reference — below the managed store, never above
   * it. The invoking project ranks over the user's home file, matching the
   * environment layering: the more specific location wins.
   */
  private dotenvFallback(ref: CredentialRef): LaunchEnvironmentEntry | undefined {
    const entry = launchEnvironmentOf(this.ctx).getFrom(ref, ['project-env', 'user-env'])
    return entry !== undefined && entry.value.length > 0 ? entry : undefined
  }

  /**
   * Reject a write the inherited environment would shadow into apparent
   * no-effect. Only that layer can shadow a write: everything else this
   * provider resolves ranks below the store being written.
   */
  private assertUnshadowed(ref: CredentialRef, verb: 'set' | 'unset'): void {
    if (this.inherited(ref) !== undefined) {
      throw new Error(
        `credentials-electron: "${ref}" is supplied read-only by the launching environment, so ${verb} would be`
        + ' shadowed; unset it in the shell you start dsh from instead',
      )
    }
  }

  override async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const inherited = this.inherited(ref)
    if (inherited !== undefined) return { value: inherited, source: 'env' }
    const stored = await this.lane().nativeRequest('credential-get', { ref }, this.signal())
    if (stored !== null) return { value: stored, source: 'keychain' }
    const fallback = this.dotenvFallback(ref)
    if (fallback !== undefined) return { value: fallback.value, source: fallback.source }
    return undefined
  }

  override async describe(ref: CredentialRef): Promise<CredentialInfo> {
    // Only the inherited environment is unwritable: it is the one layer this
    // process cannot edit. A user `.env` value is writable in the sense that
    // matters — storing a key replaces it as the effective one.
    if (this.inherited(ref) !== undefined) {
      return { configured: true, source: 'env', writable: false }
    }
    if (await this.lane().nativeRequest('credential-has', { ref }, this.signal())) {
      return { configured: true, source: 'keychain', writable: true }
    }
    const fallback = this.dotenvFallback(ref)
    if (fallback !== undefined) return { configured: true, source: fallback.source, writable: true }
    return { configured: false, writable: true }
  }

  override async set(ref: CredentialRef, value: string): Promise<void> {
    if (value.length === 0) {
      throw new Error(`credentials-electron: an empty value cannot be stored for "${ref}"; use unset`)
    }
    this.assertUnshadowed(ref, 'set')
    await this.lane().nativeRequest('credential-set', { ref, value }, this.signal())
    this.notifyUpdated(ref)
  }

  override async unset(ref: CredentialRef): Promise<void> {
    this.assertUnshadowed(ref, 'unset')
    const changed = await this.lane().nativeRequest('credential-unset', { ref }, this.signal())
    if (changed) this.notifyUpdated(ref)
  }

  override async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    const record = await this.lane().nativeRequest('credential-record-read', { key }, this.signal())
    return record ?? undefined
  }

  override async describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const status = await this.lane().nativeRequest('credential-record-status', { key }, this.signal())
    // Presence is the whole fact here: no layer ranks above this store for a
    // record, so nothing can shadow one.
    return status.configured
      ? { configured: true, ...status.kind === undefined ? {} : { kind: status.kind }, writable: true }
      : { configured: false, writable: true }
  }

  override async listRecords(): Promise<readonly CredentialRecordEntry[]> {
    const entries = await this.lane().nativeRequest('credential-record-list', undefined, this.signal())
    return entries.map(entry => ({
      // The main-side store validates its own document; a key that is not
      // addressable fails loud here rather than enumerating as opaque.
      key: parseCredentialKey(entry.key),
      kind: entry.kind,
    }))
  }

  override async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const lane = this.lane()
    // The lease holds the record's exclusion: `mutate` decides against the
    // record as it stands, and the lease self-expires in the main process if
    // this holder crashes before committing.
    const held = await lane.nativeRequest('credential-record-lease', { key }, this.signal())
    let next: CredentialRecord | undefined
    try {
      next = await mutate(held.record ?? undefined)
    } catch (error) {
      await lane.nativeRequest('credential-record-abort', { lease: held.lease }, this.signal())
      throw error
    }
    if (next === undefined) {
      await lane.nativeRequest('credential-record-abort', { lease: held.lease }, this.signal())
      return held.record ?? undefined
    }
    const after = await lane.nativeRequest(
      'credential-record-commit',
      { key, lease: held.lease, record: next },
      this.signal(),
    )
    this.notifyRecordUpdated(key)
    return after
  }

  override async deleteRecord(key: CredentialKey): Promise<void> {
    const changed = await this.lane().nativeRequest('credential-record-delete', { key }, this.signal())
    if (changed) this.notifyRecordUpdated(key)
  }
}
