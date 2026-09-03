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

/** One stored credential record as it crosses the native-op wire, mirroring the seam's record union. */
export type DesktopCredentialRecordWire =
  | { readonly kind: 'api-key'; readonly key?: string; readonly env?: Record<string, string> }
  | { readonly kind: 'grant'; readonly payload: unknown }

/** The closed vocabulary of native operations the host child can ask Electron main to perform. */
export type DesktopNativeOp =
  | 'directory-pick'
  | 'credential-has'
  | 'credential-get'
  | 'credential-set'
  | 'credential-unset'
  | 'credential-record-status'
  | 'credential-record-read'
  | 'credential-record-list'
  | 'credential-record-lease'
  | 'credential-record-commit'
  | 'credential-record-abort'
  | 'credential-record-delete'

/** Per-operation request arguments; `undefined` members send no `args` field at all. */
export interface DesktopNativeRequestArgs {
  readonly 'directory-pick': undefined
  readonly 'credential-has': { readonly ref: string }
  readonly 'credential-get': { readonly ref: string }
  readonly 'credential-set': { readonly ref: string; readonly value: string }
  readonly 'credential-unset': { readonly ref: string }
  readonly 'credential-record-status': { readonly key: string }
  readonly 'credential-record-read': { readonly key: string }
  readonly 'credential-record-list': undefined
  readonly 'credential-record-lease': { readonly key: string }
  readonly 'credential-record-commit': {
    readonly key: string
    readonly lease: string
    readonly record: DesktopCredentialRecordWire
  }
  readonly 'credential-record-abort': { readonly lease: string }
  readonly 'credential-record-delete': { readonly key: string }
}

/** Per-operation success values; `undefined` members carry no `value` field. */
export interface DesktopNativeValue {
  readonly 'directory-pick': string | null
  readonly 'credential-has': boolean
  readonly 'credential-get': string | null
  readonly 'credential-set': boolean
  readonly 'credential-unset': boolean
  readonly 'credential-record-status': { readonly configured: boolean; readonly kind?: 'api-key' | 'grant' }
  readonly 'credential-record-read': DesktopCredentialRecordWire | null
  readonly 'credential-record-list': readonly { readonly key: string; readonly kind: 'api-key' | 'grant' }[]
  readonly 'credential-record-lease': {
    readonly lease: string
    readonly record: DesktopCredentialRecordWire | null
  }
  readonly 'credential-record-commit': DesktopCredentialRecordWire
  readonly 'credential-record-abort': undefined
  readonly 'credential-record-delete': boolean
}

/** One host-initiated native request, host child to Electron main, narrowed per op. */
export type DesktopNativeRequestMessage = {
  [Op in DesktopNativeOp]: {
    readonly t: 'native-request'
    /** Correlation id; the matching response carries it back. */
    readonly id: DesktopIpcId
    readonly op: Op
  } & (DesktopNativeRequestArgs[Op] extends undefined
    ? { readonly args?: undefined }
    : { readonly args: DesktopNativeRequestArgs[Op] })
}[DesktopNativeOp]

/** The successful answer to one native request, Electron main to host child. */
export interface DesktopNativeOkMessage {
  readonly t: 'native-ok'
  readonly id: DesktopIpcId
  readonly op: DesktopNativeOp
  readonly value?: DesktopNativeValue[DesktopNativeOp]
}

/** The failed answer to one native request; the error text never quotes a secret. */
export interface DesktopNativeErrorMessage {
  readonly t: 'native-error'
  readonly id: DesktopIpcId
  readonly op: DesktopNativeOp
  readonly error: string
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
  | DesktopNativeRequestMessage
  | DesktopNativeOkMessage
  | DesktopNativeErrorMessage

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

/** Test whether one value is JSON-admissible (no `undefined`, functions, or non-finite numbers). */
function isJsonValue(value: unknown, seen: Set<object> = new Set()): boolean {
  if (value === null) return true
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true
    case 'number':
      return Number.isFinite(value)
    case 'object': {
      if (seen.has(value)) return false
      if (Array.isArray(value)) {
        seen.add(value)
        const ok = value.every(item => isJsonValue(item, seen))
        seen.delete(value)
        return ok
      }
      if (Object.getPrototypeOf(value) !== Object.prototype) return false
      seen.add(value)
      const ok = Object.values(value).every(item => isJsonValue(item, seen))
      seen.delete(value)
      return ok
    }
    default:
      return false
  }
}

/** Validate one stored credential record against the seam's closed union. */
export function isDesktopCredentialRecord(value: unknown): value is DesktopCredentialRecordWire {
  if (!isRecord(value) || typeof value.kind !== 'string') return false
  switch (value.kind) {
    case 'api-key':
      return hasFields(value, ['kind'], ['key', 'env'])
        && (value.key === undefined || typeof value.key === 'string' && value.key.length > 0)
        && (value.env === undefined || isRecord(value.env)
          && Object.entries(value.env).every(([name, entry]) =>
            typeof name === 'string' && name.length > 0 && typeof entry === 'string' && entry.length > 0))
    case 'grant':
      return hasFields(value, ['kind', 'payload']) && isJsonValue(value.payload)
    default:
      return false
  }
}

/** Test one record-kind tag. */
function isRecordKind(value: unknown): value is 'api-key' | 'grant' {
  return value === 'api-key' || value === 'grant'
}

/** Test the closed native-op vocabulary. */
function isNativeOp(value: unknown): value is DesktopNativeOp {
  return value === 'directory-pick'
    || value === 'credential-has'
    || value === 'credential-get'
    || value === 'credential-set'
    || value === 'credential-unset'
    || value === 'credential-record-status'
    || value === 'credential-record-read'
    || value === 'credential-record-list'
    || value === 'credential-record-lease'
    || value === 'credential-record-commit'
    || value === 'credential-record-abort'
    || value === 'credential-record-delete'
}

/** Test one ref-or-key args field: a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Validate `native-request` args against the operation's exact field set. */
function isNativeArgs(op: string, args: unknown): boolean {
  const field = (value: Record<string, unknown>, name: string): boolean =>
    isNonEmptyString(value[name])
  switch (op) {
    case 'directory-pick':
    case 'credential-record-list':
      return args === undefined
    case 'credential-has':
    case 'credential-get':
    case 'credential-unset':
      return isRecord(args) && hasFields(args, ['ref']) && field(args, 'ref')
    case 'credential-set':
      return isRecord(args) && hasFields(args, ['ref', 'value'])
        && field(args, 'ref') && field(args, 'value')
    case 'credential-record-status':
    case 'credential-record-read':
    case 'credential-record-lease':
    case 'credential-record-delete':
      return isRecord(args) && hasFields(args, ['key']) && field(args, 'key')
    case 'credential-record-commit':
      return isRecord(args) && hasFields(args, ['key', 'lease', 'record'])
        && field(args, 'key') && field(args, 'lease')
        && isDesktopCredentialRecord(args.record)
    case 'credential-record-abort':
      return isRecord(args) && hasFields(args, ['lease']) && field(args, 'lease')
    default:
      return false
  }
}

/** Validate `native-ok`'s value against the operation's result shape. */
function isNativeValue(op: DesktopNativeOp, value: unknown): boolean {
  switch (op) {
    case 'directory-pick':
    case 'credential-get':
      return value === null || typeof value === 'string'
    case 'credential-has':
    case 'credential-set':
    case 'credential-unset':
    case 'credential-record-delete':
      return typeof value === 'boolean'
    case 'credential-record-status':
      return isRecord(value) && hasFields(value, ['configured'], ['kind'])
        && typeof value.configured === 'boolean'
        && (value.kind === undefined || isRecordKind(value.kind))
    case 'credential-record-read':
      return value === null || isDesktopCredentialRecord(value)
    case 'credential-record-commit':
      return isDesktopCredentialRecord(value)
    case 'credential-record-list':
      return Array.isArray(value) && value.every(entry =>
        isRecord(entry) && hasFields(entry, ['key', 'kind'])
          && isNonEmptyString(entry.key) && isRecordKind(entry.kind))
    case 'credential-record-lease':
      return isRecord(value) && hasFields(value, ['lease', 'record'])
        && isNonEmptyString(value.lease)
        && (value.record === null || isDesktopCredentialRecord(value.record))
    case 'credential-record-abort':
      return value === undefined
  }
  /* v8 ignore next -- unreachable: the op vocabulary is validated before this switch. */
  return false
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
    case 'native-request':
      if (!hasFields(value, ['t', 'id', 'op'], ['args'])
        || typeof value.id !== 'string'
        || typeof value.op !== 'string'
        || !isNativeArgs(value.op, value.args)) return undefined
      break
    case 'native-ok':
      if (!hasFields(value, ['t', 'id', 'op'], ['value'])
        || typeof value.id !== 'string'
        || !isNativeOp(value.op)
        || !isNativeValue(value.op, value.value)) return undefined
      break
    case 'native-error':
      if (!hasFields(value, ['t', 'id', 'op', 'error'])
        || typeof value.id !== 'string'
        || !isNativeOp(value.op)
        || typeof value.error !== 'string') return undefined
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
