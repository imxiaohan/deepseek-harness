/**
 * The desktop preload: installs the IPC-carrier transport as the page global
 * `__DSH_TRANSPORT__` before any client plugin loads. The shell runs with
 * `contextIsolation: false` so the connection client receives the hooks —
 * and their `Response` values — by reference; the carrier's trust line is
 * the main process's sender gate, not the renderer world boundary.
 * @module @deepseek-ai/dsh-desktop/preload
 */

import { ipcRenderer } from 'electron'
import {
  createDesktopTransport,
  type PreloadOn,
  type PreloadRpc,
} from '@deepseek-ai/dsh-host-desktop-electron'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

const on: PreloadOn = (channel, listener) => {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown): void => { listener(payload) }
  ipcRenderer.on(channel, wrapped)
  return () => { ipcRenderer.removeListener(channel, wrapped) }
}

const rpc: PreloadRpc = {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  on,
  send: (channel, payload) => { ipcRenderer.send(channel, payload) },
  newId: () => randomUUID(),
}

;(globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__ = createDesktopTransport(rpc)
