/**
 * @deepseek-ai/dsh-host-desktop-electron — the desktop shell's host plugin.
 * The tree side provides the virtual `webServer` service (route registry and
 * index injections with no listening socket) and the `desktopRuntime` lane
 * the host child serves the IPC carrier from: the connection shared fetch
 * handler, the virtual server's plugin-asset route, the Gateway wire stream,
 * and the boot payload. The Electron-free halves (IPC protocol, host bridge, preload
 * transport) live here too; the Electron main assembles them in `apps/desktop`.
 * @module @deepseek-ai/dsh-host-desktop-electron
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { VirtualWebServer } from './virtual-web-server.ts'

export { VirtualWebServer } from './virtual-web-server.ts'
export {
  serveDesktopHost,
  type DesktopHostRuntime,
} from './host-bridge.ts'
export type { DesktopHostChannel } from './ipc-protocol.ts'
export type {
  DesktopFetchResponseMessage,
  DesktopIpcMessage,
  DesktopHostSend,
} from './ipc-protocol.ts'
export {
  CARRIER_LOOPBACK_HOST,
  DesktopIpcId,
  loopbackCarrierUrl,
  parseDesktopIpcMessage,
} from './ipc-protocol.ts'
export {
  createDesktopTransport,
  type DesktopTransportHooks,
  DESKTOP_FETCH_CANCEL_CHANNEL,
  DESKTOP_FETCH_CHANNEL,
  DESKTOP_OPEN_STREAM_CHANNEL,
  DESKTOP_STREAM_CANCEL_CHANNEL,
  DESKTOP_STREAM_EVENT_CHANNEL,
  type DesktopStreamEvent,
  type PreloadFetchPayload,
  type PreloadInvoke,
  type PreloadOn,
  type PreloadRpc,
  type PreloadSend,
} from './preload-core.ts'

/** Stable Cordis plugin name. */
export const name = 'desktop-electron'

/** No service blocks the shell: it provides both of its own. */
export const inject: string[] = []

/** The connection face this package reads; the service owns token minting. */
interface ConnectionLane {
  createSharedFetchHandler(channel: '/api'): { fetch(request: Request): Promise<Response> }
}

/** The Gateway wire-stream face this package reads. */
interface WireStreamLane {
  readonly wireStream: {
    open(endpoint: string, payload: unknown, signal: AbortSignal): Promise<AsyncIterable<unknown>>
    failure(error: unknown): unknown
  }
}

/**
 * The desktop carrier lane over the booted composition: everything the host
 * child's IPC bridge dispatches onto, resolved lazily so the shell activates
 * before its sibling rows finish mounting.
 */
export class DesktopRuntime extends Service {
  private fetchLane: { fetch(request: Request): Promise<Response> } | undefined

  /** Register under the service name `desktopRuntime`. */
  constructor(ctx: Context) {
    super(ctx, 'desktopRuntime')
  }

  /**
   * The shared `/api` fetch handler, composed once the connection node half
   * is active. Electron main authorizes the renderer before this transport-
   * agnostic handler receives a request.
   * @returns the transport-agnostic dispatch face.
   */
  handler(): { fetch(request: Request): Promise<Response> } {
    this.fetchLane ??= (this.ctx.get('connection') as ConnectionLane | undefined)?.createSharedFetchHandler('/api')
    if (this.fetchLane === undefined) {
      throw new Error('desktop-electron: the composition exposes no connection service')
    }
    return this.fetchLane
  }

  /**
   * Dispatch one carrier request to the registered plugin-asset route or the shared API handler.
   * @param request - loopback-authority request reconstructed by the host bridge.
   * @returns the plugin asset or API response.
   */
  fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/plugins' || url.pathname.startsWith('/plugins/')) {
      const webServer = this.ctx.get('webServer') as VirtualWebServer | undefined
      if (webServer === undefined) {
        throw new Error('desktop-electron: the composition exposes no webServer service')
      }
      return webServer.fetchAsset(request)
    }
    return this.handler().fetch(request)
  }

  /**
   * Open one logical Gateway Remote stream.
   * @param endpoint - Gateway stream endpoint.
   * @param payload - stream-opening payload.
   * @param signal - cancellation for the logical stream.
   * @returns the stream's decoded items.
   */
  openStream(endpoint: string, payload: unknown, signal: AbortSignal): Promise<AsyncIterable<unknown>> {
    const gateway = this.ctx.get('typertGateway') as WireStreamLane | undefined
    if (gateway === undefined) {
      throw new Error('desktop-electron: the composition exposes no typertGateway service')
    }
    return gateway.wireStream.open(endpoint, payload, signal)
  }

  /**
   * Map one stream failure onto its Gateway wire value.
   * @param error - the failure to map.
   * @returns the wire error for the terminal frame.
   */
  failure(error: unknown): unknown {
    const gateway = this.ctx.get('typertGateway') as WireStreamLane | undefined
    if (gateway === undefined) {
      throw new Error('desktop-electron: the composition exposes no typertGateway service')
    }
    return gateway.wireStream.failure(error)
  }

  /**
   * The boot payload for the desktop index render.
   * @returns the index injection rows the virtual webServer collected.
   */
  bootPayload(): { injections: readonly IndexInjection[] } {
    const webServer = this.ctx.get('webServer') as VirtualWebServer | undefined
    if (webServer === undefined) {
      throw new Error('desktop-electron: the composition exposes no webServer service')
    }
    return { injections: webServer.collectIndexInjections() }
  }

}

/**
 * Mount the desktop shell's tree side: the virtual `webServer` over the
 * retained rows' injections, and the `desktopRuntime` carrier lane.
 * @param ctx - host plugin context.
 */
export function apply(ctx: Context): void {
  new VirtualWebServer(ctx)
  new DesktopRuntime(ctx)
}
