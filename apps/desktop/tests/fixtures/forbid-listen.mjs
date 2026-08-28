import { Server } from 'node:net'

if (process.env.DSH_DESKTOP_E2E_FORBID_LISTEN === '1'
  && process.env.ELECTRON_RUN_AS_NODE === '1') {
  Server.prototype.listen = function forbiddenDesktopListen() {
    throw new Error('desktop Electron test: the host child attempted to listen on a socket')
  }
}
