/** Locale-owned copy for Electron-native window, notification, and dialog surfaces. */

const zh = {
  applicationTitle: 'DeepSeek Harness',
  fatalPrefix: 'dsh desktop',
  fatalStages: {
    'fatal.renderer.invalidFetch': 'renderer 发送了非法 fetch 消息',
    'fatal.renderer.invalidFetchCancellation': 'renderer 发送了非法 fetch 取消消息',
    'fatal.renderer.invalidStreamOpen': 'renderer 发送了非法 stream 打开消息',
    'fatal.renderer.invalidStreamCancellation': 'renderer 发送了非法 stream 取消消息',
    'fatal.renderer.streamRelay': 'renderer stream 转发失败',
    'fatal.renderer.processExited': 'renderer 进程已退出',
    'fatal.renderer.loadFailed': 'renderer 加载失败',
    'fatal.host.invalidCarrierMessage': '宿主进程发送了非法载体消息',
    'fatal.host.processExited': '宿主进程已退出',
    'fatal.host.startFailed': '宿主进程启动失败',
  },
  rendererExitDetail: (reason: string, exitCode: number) => `${reason}；退出码 ${String(exitCode)}`,
  hostExitDetail: (exitCode: number | null) => `退出码 ${String(exitCode ?? 'null')}；请查看上方控制台输出`,
} as const

/** Fatal condition labels accepted by the Electron-native reporter. */
export type DesktopFatalStage = keyof typeof zh.fatalStages

/** Complete copy required by Electron-native presentation. */
export interface DesktopNativeCopy {
  readonly applicationTitle: string
  readonly fatalPrefix: string
  readonly fatalStages: Record<DesktopFatalStage, string>
  /**
   * Format renderer termination details around Electron's verbatim reason token.
   * @param reason Electron's renderer-exit reason token.
   * @param exitCode Renderer exit code.
   * @returns Localized termination details.
   */
  rendererExitDetail(reason: string, exitCode: number): string
  /**
   * Format host termination details.
   * @param exitCode Host child exit code, or null for signal termination.
   * @returns Localized termination details.
   */
  hostExitDetail(exitCode: number | null): string
}

const en = {
  applicationTitle: 'DeepSeek Harness',
  fatalPrefix: 'dsh desktop',
  fatalStages: {
    'fatal.renderer.invalidFetch': 'renderer sent an invalid fetch message',
    'fatal.renderer.invalidFetchCancellation': 'renderer sent an invalid fetch cancellation message',
    'fatal.renderer.invalidStreamOpen': 'renderer sent an invalid stream-open message',
    'fatal.renderer.invalidStreamCancellation': 'renderer sent an invalid stream cancellation message',
    'fatal.renderer.streamRelay': 'renderer stream relay failed',
    'fatal.renderer.processExited': 'renderer process exited',
    'fatal.renderer.loadFailed': 'renderer failed to load',
    'fatal.host.invalidCarrierMessage': 'host process sent an invalid carrier message',
    'fatal.host.processExited': 'host process exited',
    'fatal.host.startFailed': 'host process failed to start',
  },
  rendererExitDetail: (reason: string, exitCode: number) => `${reason}; exit code ${String(exitCode)}`,
  hostExitDetail: (exitCode: number | null) => `exit code ${String(exitCode ?? 'null')}; see the console output above`,
} satisfies DesktopNativeCopy

/**
 * Resolve Electron-native copy from an OS locale, defaulting unsupported locales to English.
 * @param locale Electron's current application locale.
 * @returns The complete native copy dictionary.
 */
export function desktopNativeCopy(locale: string): DesktopNativeCopy {
  return locale.toLowerCase().startsWith('zh') ? zh : en
}
