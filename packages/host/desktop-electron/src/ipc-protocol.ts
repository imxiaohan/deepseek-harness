/**
 * Wire messages for the desktop IPC carrier: the JSON protocol between the
 * Electron main process and the host child (over the Node process channel),
 * mirrored one-to-one between the renderer preload and the main process.
 * Binary bodies travel base64-encoded; everything else is JSON. Scheme
 * responses use pull-driven body chunks so process IPC never owns a complete
 * download archive.
 * @module @deepseek-ai/dsh-host-desktop-electron/ipc-protocol
 */

import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Correlation id of one fetch round trip or one logical stream. */
export type DesktopIpcId = Branded<'DesktopIpcId'>

/**
 * Brand a carrier correlation id at its owning boundary.
 * @param value - serialized correlation id.
 * @returns the carrier id.
 */
export function DesktopIpcId(value: string): DesktopIpcId {
  return value as DesktopIpcId
}

/** One serialized fetch request, main to host child. */
export interface DesktopFetchMessage {
  readonly t: 'fetch'
  readonly id: DesktopIpcId
  /** Loopback-authority URL the host child reconstructs the `Request` from. */
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body?: string
  /** Request a pull-driven response body instead of one response envelope. */
  readonly streamBody?: true
}

/** Cancel one fetch round trip, main to host child. */
export interface DesktopCancelFetchMessage {
  readonly t: 'fetch-cancel'
  readonly id: DesktopIpcId
}

/** Request the next body chunk for one streamed fetch response. */
export interface DesktopPullFetchMessage {
  readonly t: 'fetch-pull'
  readonly id: DesktopIpcId
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
  /** The body follows as pull-driven `fetch-chunk` and `fetch-end` messages. */
  readonly bodyStream?: true
}

/** One binary body chunk from a streamed fetch response. */
export interface DesktopFetchChunkMessage {
  readonly t: 'fetch-chunk'
  readonly id: DesktopIpcId
  readonly bodyBase64: string
}

/** Terminal success of one streamed fetch response body. */
export interface DesktopFetchEndMessage {
  readonly t: 'fetch-end'
  readonly id: DesktopIpcId
}

/** Terminal failure of one streamed fetch response body. */
export interface DesktopFetchErrorMessage {
  readonly t: 'fetch-error'
  readonly id: DesktopIpcId
  readonly error: string
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

/** Boot payload published by the host child once its carrier lane is ready. */
export interface DesktopBootResponseMessage {
  readonly t: 'boot-res'
  readonly injections: readonly IndexInjection[]
}

/** Request bounded profile teardown in the host child. */
export interface DesktopShutdownMessage {
  readonly t: 'shutdown'
  readonly code: 0 | 1
}

/** Every message the carrier protocol carries. */
export type DesktopIpcMessage =
  | DesktopFetchMessage
  | DesktopCancelFetchMessage
  | DesktopPullFetchMessage
  | DesktopFetchResponseMessage
  | DesktopFetchChunkMessage
  | DesktopFetchEndMessage
  | DesktopFetchErrorMessage
  | DesktopOpenStreamMessage
  | DesktopCancelStreamMessage
  | DesktopStreamItemMessage
  | DesktopStreamEndMessage
  | DesktopStreamErrorMessage
  | DesktopBootResponseMessage
  | DesktopShutdownMessage

/** One direction of the host-child channel: send a protocol message. */
export type DesktopHostSend = (message: DesktopIpcMessage) => void

/** The host-child half of the process channel. */
export interface DesktopHostChannel {
  readonly send: DesktopHostSend
  /** Register the inbound-message listener; returns its disposer. */
  readonly onMessage: (listener: (message: DesktopIpcMessage) => void) => () => void
}

/** Test whether a process-boundary value is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Test whether a record contains exactly the required and optional keys. */
function hasFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every(key => key in value) && Object.keys(value).every(key => allowed.has(key))
}

/** Test whether every value in a plain record is a string. */
function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(item => typeof item === 'string')
}

/** Validate one index-injection row before the main process renders it. */
function isIndexInjection(value: unknown): value is IndexInjection {
  if (!isRecord(value) || typeof value.kind !== 'string') return false
  switch (value.kind) {
    case 'global':
      return hasFields(value, ['kind', 'name'], ['value']) && typeof value.name === 'string'
    case 'script':
      return hasFields(value, ['kind', 'placement', 'text'])
        && (value.placement === 'head' || value.placement === 'body')
        && typeof value.text === 'string'
    case 'script-src':
      return hasFields(value, ['kind', 'placement', 'src'])
        && (value.placement === 'head' || value.placement === 'body')
        && typeof value.src === 'string'
    case 'script-preload':
      return hasFields(value, ['kind', 'src']) && typeof value.src === 'string'
    case 'style':
      return hasFields(value, ['kind', 'text']) && typeof value.text === 'string'
    case 'html':
      return hasFields(value, ['kind', 'placement', 'html'])
        && (value.placement === 'head' || value.placement === 'body')
        && typeof value.html === 'string'
    default:
      return false
  }
}

/**
 * Validate one protocol message from an untyped process-IPC value.
 * @param value - the raw `message` payload a child process received.
 * @returns the typed protocol message, or undefined when any field is invalid.
 */
export function parseDesktopIpcMessage(value: unknown): DesktopIpcMessage | undefined {
  if (!isRecord(value) || typeof value.t !== 'string') return undefined
  switch (value.t) {
    case 'fetch':
      if (!hasFields(value, ['t', 'id', 'url', 'method', 'headers'], ['body', 'streamBody'])
        || typeof value.id !== 'string'
        || typeof value.url !== 'string'
        || typeof value.method !== 'string'
        || !isStringRecord(value.headers)
        || value.body !== undefined && typeof value.body !== 'string'
        || value.streamBody !== undefined && value.streamBody !== true) return undefined
      break
    case 'fetch-res':
      if (!hasFields(value, ['t', 'id', 'status', 'statusText', 'headers', 'body'], ['bodyBase64', 'bodyStream'])
        || typeof value.id !== 'string'
        || !Number.isInteger(value.status)
        || typeof value.statusText !== 'string'
        || !isStringRecord(value.headers)
        || value.body !== null && typeof value.body !== 'string'
        || value.bodyBase64 !== undefined && typeof value.bodyBase64 !== 'string'
        || value.bodyStream !== undefined && value.bodyStream !== true
        || value.bodyBase64 !== undefined && value.body !== null
        || value.bodyStream === true && (value.body !== null || value.bodyBase64 !== undefined)) return undefined
      break
    case 'fetch-cancel':
    case 'fetch-pull':
    case 'fetch-end':
      if (!hasFields(value, ['t', 'id']) || typeof value.id !== 'string') return undefined
      break
    case 'fetch-chunk':
      if (!hasFields(value, ['t', 'id', 'bodyBase64'])
        || typeof value.id !== 'string'
        || typeof value.bodyBase64 !== 'string') return undefined
      break
    case 'fetch-error':
      if (!hasFields(value, ['t', 'id', 'error'])
        || typeof value.id !== 'string'
        || typeof value.error !== 'string') return undefined
      break
    case 'open-stream':
      if (!hasFields(value, ['t', 'id', 'endpoint', 'payload'])
        || typeof value.id !== 'string'
        || typeof value.endpoint !== 'string') return undefined
      break
    case 'stream-cancel':
    case 'stream-end':
      if (!hasFields(value, ['t', 'id']) || typeof value.id !== 'string') return undefined
      break
    case 'stream-item':
      if (!hasFields(value, ['t', 'id', 'value']) || typeof value.id !== 'string') return undefined
      break
    case 'stream-error':
      if (!hasFields(value, ['t', 'id', 'error']) || typeof value.id !== 'string') return undefined
      break
    case 'boot-res':
      if (!hasFields(value, ['t', 'injections'])
        || !Array.isArray(value.injections)
        || !value.injections.every(isIndexInjection)) return undefined
      break
    case 'shutdown':
      if (!hasFields(value, ['t', 'code']) || value.code !== 0 && value.code !== 1) return undefined
      break
    default:
      return undefined
  }
  const message = value as unknown as DesktopIpcMessage
  return 'id' in message ? { ...message, id: DesktopIpcId(message.id) } : message
}

/** The host used for host-side URLs reconstructed from custom-scheme requests. */
export const CARRIER_LOOPBACK_HOST = '127.0.0.1'

/**
 * Rewrite one renderer URL onto the host-side loopback authority after
 * Electron main authorizes its document. Only the pathname and search survive;
 * the custom-scheme origin has no meaning to host route implementations.
 * @param href - the renderer's absolute URL.
 * @returns the loopback-authority URL for the host-child request.
 */
export function loopbackCarrierUrl(href: string): string {
  const url = new URL(href)
  return `http://${CARRIER_LOOPBACK_HOST}${url.pathname}${url.search}`
}
