/**
 * Wire messages for the desktop IPC carrier: the JSON protocol between the
 * Electron main process and the host child (over the Node process channel),
 * mirrored one-to-one between the renderer preload and the main process.
 * Binary bodies travel base64-encoded; everything else is JSON.
 * @module @deepseek-ai/dsh-host-desktop-electron/ipc-protocol
 */

/** Correlation id of one fetch round trip or one logical stream. */
export type DesktopIpcId = string

/** One serialized fetch request, main to host child. */
export interface DesktopFetchMessage {
  readonly t: 'fetch'
  readonly id: DesktopIpcId
  /** Loopback-authority URL the host child reconstructs the `Request` from. */
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body?: string
}

/** One serialized fetch response, host child to main. */
export interface DesktopFetchResponseMessage {
  readonly t: 'fetch-res'
  readonly id: DesktopIpcId
  readonly status: number
  readonly statusText: string
  readonly headers: Record<string, string>
  readonly body: string | null
  /** Present only when the body is not valid UTF-8 text. */
  readonly bodyBase64?: string
}

/** Open one logical Gateway stream, main to host child. */
export interface DesktopOpenStreamMessage {
  readonly t: 'open-stream'
  readonly id: DesktopIpcId
  readonly endpoint: string
  readonly payload: unknown
}

/** Cancel one logical stream, main to host child. */
export interface DesktopCancelStreamMessage {
  readonly t: 'stream-cancel'
  readonly id: DesktopIpcId
}

/** One decoded stream item, host child to main. */
export interface DesktopStreamItemMessage {
  readonly t: 'stream-item'
  readonly id: DesktopIpcId
  readonly value: unknown
}

/** Terminal success of one logical stream, host child to main. */
export interface DesktopStreamEndMessage {
  readonly t: 'stream-end'
  readonly id: DesktopIpcId
}

/** Terminal failure of one logical stream, host child to main. */
export interface DesktopStreamErrorMessage {
  readonly t: 'stream-error'
  readonly id: DesktopIpcId
  /** Gateway-mapped wire error (`typertGateway.wireStream.failure`). */
  readonly error: unknown
}

/** Request the boot payload (index injections), main to host child. */
export interface DesktopBootMessage {
  readonly t: 'boot'
}

/** Boot payload answer, host child to main. */
export interface DesktopBootResponseMessage {
  readonly t: 'boot-res'
  readonly injections: readonly unknown[]
}

/** Request one plugin bundle's bytes, main to host child. */
export interface DesktopBundleMessage {
  readonly t: 'bundle'
  readonly id: DesktopIpcId
  /** Package name owning the `dsh.client` declaration. */
  readonly package: string
}

/** Plugin bundle answer, host child to main. */
export interface DesktopBundleResponseMessage {
  readonly t: 'bundle-res'
  readonly id: DesktopIpcId
  readonly bytesBase64: string
}

/** Every message the carrier protocol carries. */
export type DesktopIpcMessage =
  | DesktopFetchMessage
  | DesktopFetchResponseMessage
  | DesktopOpenStreamMessage
  | DesktopCancelStreamMessage
  | DesktopStreamItemMessage
  | DesktopStreamEndMessage
  | DesktopStreamErrorMessage
  | DesktopBootMessage
  | DesktopBootResponseMessage
  | DesktopBundleMessage
  | DesktopBundleResponseMessage

/** One direction of the host-child channel: send a protocol message. */
export type DesktopHostSend = (message: DesktopIpcMessage) => void

/** The host-child half of the process channel. */
export interface DesktopHostChannel {
  readonly send: DesktopHostSend
  /** Register the inbound-message listener; returns its disposer. */
  readonly onMessage: (listener: (message: DesktopIpcMessage) => void) => () => void
}

/**
 * Decode one protocol message from an untyped process-IPC value.
 * @param value - the raw `message` payload a child process received.
 * @returns the typed protocol message, or undefined when the value carries no protocol shape.
 */
export function parseDesktopIpcMessage(value: unknown): DesktopIpcMessage | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const t = (value as { t?: unknown }).t
  if (typeof t !== 'string') return undefined
  return value as DesktopIpcMessage
}

/** The loopback host the `/api` trust fence reads; the carrier's synthesized authority. */
export const CARRIER_LOOPBACK_HOST = '127.0.0.1'

/**
 * Rewrite one renderer URL onto the loopback authority: the desktop carrier's
 * loopback-equivalence decision, applied where the bridge mints the host-side
 * request. Only the pathname and search survive; the scheme origin is the
 * renderer's, not the fence's business.
 * @param href - the renderer's absolute URL.
 * @returns the loopback-authority URL for the host-child request.
 */
export function loopbackCarrierUrl(href: string): string {
  const url = new URL(href)
  return `http://${CARRIER_LOOPBACK_HOST}${url.pathname}${url.search}`
}
