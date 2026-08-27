/**
 * The desktop composition's virtual `webServer` service: the route-registry
 * face the retained rows inject, with no listening socket behind it. The
 * `/plugins` route and index injections feed the Electron main process's
 * custom-scheme handler; every other registration (the `/api` route, the
 * Gateway's WebSocket upgrade) satisfies the injection contract and is never
 * hit by a request — the IPC carrier dispatches at fetch level instead.
 *
 * The public surface mirrors {@link WebServer}'s consumer face; consumers'
 * static types come from `dsh-host-webserver`'s Context merge.
 * @module @deepseek-ai/dsh-host-desktop-electron/virtual-web-server
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { IndexInjection, WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'

/**
 * The socket-free route registry standing in for the HTTP carrier service.
 * Activation listens never: there is no server, no fallback dispatch, and no
 * port — reading one is a carrier mismatch, not a value.
 */
export class VirtualWebServer extends Service {
  private readonly exact = new Map<string, WebRoute>()
  private readonly prefixes = new Map<string, WebRoute>()
  private readonly upgrades = new Map<string, WebUpgradeRoute>()

  /** Register under the desktop composition's service name `webServer`. */
  constructor(ctx: Context) {
    super(ctx, 'webServer')
  }

  /**
   * Register a named route into the registry the custom-scheme handler reads.
   * Duplicate (kind, path) throws, matching the HTTP carrier's contract.
   * @param route - kind, path, and the owning handler.
   * @returns the disposer removing the route.
   */
  register(route: WebRoute): () => void {
    const table = route.kind === 'exact' ? this.exact : this.prefixes
    if (table.has(route.path)) {
      throw new Error(`desktop webServer: duplicate ${route.kind} route "${route.path}"`)
    }
    table.set(route.path, route)
    return () => { table.delete(route.path) }
  }

  /**
   * Accept an upgrade registration. The Gateway's WebSocket upgrade lands
   * here; the IPC carrier replaces the physical downlink, so the handler is
   * stored for contract completeness and never invoked.
   * @param route - pathname and the unused owning handler.
   * @returns the disposer removing the registration.
   */
  registerUpgrade(route: WebUpgradeRoute): () => void {
    if (this.upgrades.has(route.path)) {
      throw new Error(`desktop webServer: duplicate upgrade route "${route.path}"`)
    }
    this.upgrades.set(route.path, route)
    return () => { this.upgrades.delete(route.path) }
  }

  /**
   * Accept the fallback seat. The desktop scheme handler serves the dist
   * itself; the registered handler is stored for contract completeness and
   * never invoked.
   * @param handler - the unused fallback owner.
   * @returns the disposer releasing the seat.
   */
  registerFallback(handler: WebRoute['handler']): () => void {
    this.fallback = handler
    return () => { this.fallback = undefined }
  }

  /** The accepted fallback seat; kept for the consumer contract, never dispatched. */
  fallback: WebRoute['handler'] | undefined

  /**
   * Collect the structured index injection table: the same event the HTTP
   * carrier emits, answered by the same listeners (the module registry's boot
   * rows), read fresh by the desktop index render.
   * @returns the injection rows for the served index.
   */
  collectIndexInjections(): IndexInjection[] {
    const table: IndexInjection[] = []
    this.ctx.emit('webserver/index-inject', table)
    return table
  }

  /**
   * The prefix-registered route a pathname resolves to, for the custom-scheme
   * handler's `/plugins` bundle serving.
   * @param pathname - absolute request pathname.
   * @returns the matching route, or undefined when none claims it.
   */
  routeFor(pathname: string): WebRoute | undefined {
    const exact = this.exact.get(pathname)
    if (exact !== undefined) return exact
    const segments = pathname.split('/')
    for (let index = segments.length; index > 0; index -= 1) {
      const prefix = segments.slice(0, index).join('/') || '/'
      const route = this.prefixes.get(prefix)
      if (route !== undefined) return route
    }
    return undefined
  }

  /** There is no listening socket; a port read is a carrier mismatch. */
  get port(): number {
    throw new Error('desktop webServer: the desktop composition listens on no port')
  }

  /**
   * The carrier's synthesized loopback authority — the same value the IPC
   * bridge mints into every host-side request. Bind-dependent consumers
   * (the directory picker's boot sampling) read it to pick their loopback
   * branch; there is no socket behind it.
   */
  get host(): string {
    return '127.0.0.1'
  }
}
