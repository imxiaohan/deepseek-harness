/**
 * Electron-native backend of the directory-picker seam: registers
 * `ctx.directoryPicker` with the `native` capability, routing each pick to the
 * Electron main process over the desktop carrier — the shell opens the real
 * OS chooser from the window and relays the chosen absolute path back. Runs
 * in the desktop host child (plain Node), so it never imports Electron; the
 * dialog lives in the Electron main process. Only composed by the desktop
 * shell: the `desktopRuntime` lane it reads exists only there.
 * @module @deepseek-ai/dsh-host-directory-picker-electron
 */

import { DirectoryPicker } from '@deepseek-ai/dsh-host-directory-picker'
import type { DirectoryPickerCapability } from '@deepseek-ai/dsh-host-directory-picker'

/** The desktop carrier lane this backend reads. */
interface DesktopRuntimeLane {
  nativeRequest(op: 'directory-pick', args: undefined, signal: AbortSignal): Promise<string | null>
}

/** The `ctx.directoryPicker` Electron-native implementation (stable capability per service life). */
export default class ElectronDirectoryPicker extends DirectoryPicker {
  private readonly nativeCapability: DirectoryPickerCapability = {
    kind: 'native',
    pick: signal => this.pick(signal),
  }

  /** Route one pick to the Electron main process and await its answer. */
  private async pick(signal: AbortSignal): Promise<string | null> {
    const lane = this.ctx.get('desktopRuntime') as DesktopRuntimeLane | undefined
    if (lane === undefined) {
      throw new Error('directory-picker-electron: the desktop composition exposes no desktopRuntime lane')
    }
    return lane.nativeRequest('directory-pick', undefined, signal)
  }

  /**
   * The native interaction capability.
   * @returns the stable `native` capability object.
   */
  capability(): DirectoryPickerCapability {
    return this.nativeCapability
  }
}
