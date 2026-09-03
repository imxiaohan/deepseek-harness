/**
 * Host-side native-operation client for the desktop carrier: routes
 * operations the host child cannot perform itself — an Electron-native
 * `dialog` or `safeStorage` that only the main process can reach — to
 * Electron main over the same correlation-id channel the fetch/stream carrier
 * uses. Each request carries one closed-vocabulary op and its validated args;
 * the matched answer resolves as the op's value or rejects with the main
 * process's error text. The provider holds one stable client for its service
 * life, so pending native ops share one inbound listener.
 * @module @deepseek-ai/dsh-host-desktop-electron/native-host-client
 */

import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import {
  DesktopIpcId,
  type DesktopHostChannel,
  type DesktopNativeOp,
  type DesktopNativeRequestArgs,
  type DesktopNativeValue,
} from './ipc-protocol.ts'

/** One pending native request awaiting its correlated main-process answer. */
interface PendingNative {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

/** The request surface the host-child native lane exposes, fully typed per op. */
export interface DesktopNativeLane {
  /**
   * Perform one native operation through Electron main.
   * @param op - the closed-vocabulary operation.
   * @param args - the operation's arguments; ops without arguments take `undefined`.
   * @param signal - caller lifetime; abort rejects the waiter and abandons any late answer.
   * @returns the operation's validated value.
   */
  request<Op extends DesktopNativeOp>(
    op: Op,
    args: DesktopNativeRequestArgs[Op],
    signal: AbortSignal,
  ): Promise<DesktopNativeValue[Op]>
}

/**
 * The host-side native-op client bound to one carrier channel.
 * @param channel - the host child's process channel.
 * @returns the typed request lane plus its disposer.
 */
export function createNativeHostClient(channel: DesktopHostChannel): DesktopNativeLane & { dispose(): void } {
  const pending = new Map<string, PendingNative>()
  const dispose = channel.onMessage((message) => {
    if (message.t !== 'native-ok' && message.t !== 'native-error') return
    const waiter = pending.get(message.id)
    if (waiter === undefined) return
    pending.delete(message.id)
    if (message.t === 'native-error') waiter.reject(new Error(message.error))
    else waiter.resolve(message.value)
  })

  return {
    dispose,
    request<Op extends DesktopNativeOp>(
      op: Op,
      args: DesktopNativeRequestArgs[Op],
      signal: AbortSignal,
    ): Promise<DesktopNativeValue[Op]> {
      signal.throwIfAborted()
      return new Promise<DesktopNativeValue[Op]>((resolve, reject) => {
        const id = DesktopIpcId(`ntv-native:${randomUUID()}`)
        const waiter: PendingNative = {
          resolve: (value) => { resolve(value as DesktopNativeValue[Op]) },
          reject,
        }
        pending.set(id, waiter)
        const detach = () => {
          signal.removeEventListener('abort', detach)
          if (pending.get(id) === waiter) {
            pending.delete(id)
            // The main process still owns its operation; dropping the waiter
            // abandons any late answer rather than resolving after disposal.
            waiter.reject(new Error(`desktop native ${op} request aborted`))
          }
        }
        signal.addEventListener('abort', detach, { once: true })
        try {
          // The generic op/args pair cannot narrow into the per-op union member
          // structurally; the receiving side's parse re-validates both fields.
          channel.send({
            t: 'native-request',
            id,
            op,
            ...args === undefined ? {} : { args },
          } as Parameters<DesktopHostChannel['send']>[0])
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
