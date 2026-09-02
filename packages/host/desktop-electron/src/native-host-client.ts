/**
 * Host-side native-operation client for the desktop carrier: routes
 * operations the host child cannot perform itself — an Electron-native
 * `dialog` that only the main process can open — to Electron main over the
 * same correlation-id channel the fetch/stream carrier uses. The provider
 * holds one stable client for its service life, so pending native edits share
 * one inbound listener.
 * @module @deepseek-ai/dsh-host-desktop-electron/native-host-client
 */

import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import {
  DesktopIpcId,
  type DesktopHostChannel,
} from './ipc-protocol.ts'

/** One pending native request awaiting its correlated main-process answer. */
interface PendingNative {
  readonly resolve: (path: string | null) => void
  readonly reject: (error: Error) => void
}

/**
 * The host-side native-op client bound to one carrier channel.
 * @param channel - the host child's process channel.
 * @returns a disposer detaching the channel listener, plus native operations.
 */
export function createNativeHostClient(channel: DesktopHostChannel): {
  readonly dispose: () => void
  readonly pickDirectory: (signal: AbortSignal) => Promise<string | null>
} {
  const pending = new Map<string, PendingNative>()
  const dispose = channel.onMessage((message) => {
    if (message.t !== 'pick-directory-res') return
    const waiter = pending.get(message.id)
    if (waiter === undefined) return
    pending.delete(message.id)
    waiter.resolve(message.path)
  })

  return {
    dispose,
    pickDirectory(signal): Promise<string | null> {
      signal.throwIfAborted()
      return new Promise<string | null>((resolve, reject) => {
        const id = DesktopIpcId(`ntv-native:${randomUUID()}`)
        const waiter: PendingNative = { resolve, reject }
        pending.set(id, waiter)
        const detach = () => {
          signal.removeEventListener('abort', detach)
          if (pending.get(id) === waiter) {
            pending.delete(id)
            // The main process still owns its chooser; dropping the waiter
            // abandons any late result rather than resolving after disposal.
            waiter.reject(new Error('desktop native directory pick aborted'))
          }
        }
        signal.addEventListener('abort', detach, { once: true })
        try {
          channel.send({ t: 'pick-directory', id })
        } catch (error) {
          // The carrier rejected the request outright; drop this waiter with
          // the real error rather than the abort message. The id is fresh, so
          // deletion is unconditional.
          signal.removeEventListener('abort', detach)
          pending.delete(id)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
  }
}
