/**
 * The desktop preload: installs the IPC-carrier transport as the page global
 * `__DSH_TRANSPORT__` before any client plugin loads. The shell runs with
 * `contextIsolation: false` so the connection client receives the hooks —
 * and their `Response` values — by reference; the main process restricts the
 * IPC handlers to the current trusted main-frame document.
 * @module @deepseek-ai/dsh-desktop/preload
 */

import { ipcRenderer } from 'electron'
import {
  createDesktopTransport,
  DesktopIpcId,
  type PreloadOn,
  type PreloadRpc,
} from '@deepseek-ai/dsh-host-desktop-electron'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import {
  DESKTOP_WINDOW_THEME_CHANNEL,
  parseDesktopWindowThemeSource,
} from './window-theme.ts'

const on: PreloadOn = (channel, listener) => {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown): void => { listener(payload) }
  ipcRenderer.on(channel, wrapped)
  return () => { ipcRenderer.removeListener(channel, wrapped) }
}

const rpc: PreloadRpc = {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  on,
  send: (channel, payload) => { ipcRenderer.send(channel, payload) },
  newId: () => DesktopIpcId(randomUUID()),
}

;(globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__ = createDesktopTransport(rpc)

/** Relay presenter-owned theme metadata to the native window frame. */
function startWindowThemeSync(): void {
  let published: string | undefined
  const publish = (): void => {
    const source = parseDesktopWindowThemeSource(
      document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.dataset.dshThemeSource,
    )
    if (source === undefined || source === published) return
    published = source
    ipcRenderer.send(DESKTOP_WINDOW_THEME_CHANNEL, source)
  }
  const observer = new MutationObserver(publish)
  observer.observe(document.head, {
    attributes: true,
    attributeFilter: ['content', 'data-dsh-theme-source'],
    childList: true,
    subtree: true,
  })
  publish()
  addEventListener('unload', () => { observer.disconnect() }, { once: true })
}

if (document.readyState === 'loading') {
  addEventListener('DOMContentLoaded', startWindowThemeSync, { once: true })
} else {
  startWindowThemeSync()
}
