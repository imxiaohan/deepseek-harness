import { describe, expect, it } from 'vitest'
import { clientSourceRoot, findUiI18nViolations, uiSourceFiles } from './verify-client-ui-i18n.ts'

function messages(source: string): string[] {
  return findUiI18nViolations('packages/client/ui-example/src/client/View.tsx', source)
    .map(violation => violation.text)
}

describe('Client UI i18n source check', () => {
  it('rejects direct JSX copy and copy-bearing attributes', () => {
    expect(messages(`
      const View = ({ ready }: { ready: boolean }) => <section aria-label="Overview">
        <span>Hard-coded text</span>
        <input placeholder={ready ? 'Search now' : ` + "`Wait ${'${ready}'}`" + `} />
        <div runningSummary="Still working" />
      </section>
    `)).toEqual(['Overview', 'Hard-coded text', 'Search now', 'Wait', 'Still working'])
  })

  it('rejects copy kept in label data and copy helper returns', () => {
    expect(messages(`
      const TABS = [{ id: 'summary', label: 'Summary' }]
      function statusLabel(status: string): string {
        if (status === 'done') return 'Complete'
        return 'Still running'
      }
      function duration(): string { return 'Not recorded' }
      function mode(): string { return 'compact' }
      function displayFailureMessage(): string { return 'API key is invalid' }
      const emptySummary = 'Nothing to show'
      function Dialog({ closeLabel = 'Close dialog' }: { closeLabel?: string }) { return closeLabel }
    `)).toEqual([
      'Summary', 'Complete', 'Still running', 'Not recorded', 'API key is invalid',
      'Nothing to show', 'Close dialog',
    ])
  })

  it('normalizes native separators before deriving a Client source root', () => {
    expect(clientSourceRoot('packages/extensions/sample/src/client/View.tsx'))
      .toBe('packages/extensions/sample/src/client')
    expect(clientSourceRoot('packages\\extensions\\sample\\src\\client\\View.tsx'))
      .toBe('packages/extensions/sample/src/client')
    expect(clientSourceRoot('packages/extensions/sample/src/server/index.ts')).toBeUndefined()
  })

  it('includes Electron-native presentation in the UI-copy corpus', () => {
    expect(uiSourceFiles()).toContain('apps/desktop/src/main.ts')
  })

  it('rejects copy passed to Electron-native presentation APIs', () => {
    expect(findUiI18nViolations('apps/desktop/src/main.ts', `
      import {
        BrowserWindow as ElectronWindow,
        Notification as NativeNotification,
        dialog as nativeDialog,
      } from 'electron/main'
      import * as electron from 'electron/main'
      const window = new ElectronWindow({ title: 'Desktop window' })
      new NativeNotification({ title: 'Fatal error', body: 'Host failed to start' }).show()
      nativeDialog.showErrorBox('Fatal error', 'Host process exited')
      nativeDialog.showMessageBox(window, { message: 'Try again later', buttons: ['Close dialog'] })
      new electron.BrowserWindow({ title: 'Namespace window' })
      new electron.Notification({ title: 'Namespace fatal', body: 'Namespace host failure' }).show()
      electron.dialog.showErrorBox('Namespace fatal', 'Namespace host exited')
      function reportFatal(_stage: string, _error?: unknown): void {}
      reportFatal('fatal.host.startFailed', new Error('Fatal wrapper copy'))
      reportFatal('fatal.host.startFailed', (new Error('Parenthesized fatal copy')))
      reportFatal('fatal.host.startFailed', new Error('Asserted fatal copy') as unknown)
      reportFatal('fatal.host.startFailed', new Error('Satisfied fatal copy') satisfies unknown)
      reportFatal('fatal.host.startFailed', new Error('Non-null fatal copy')!)
      reportFatal(
        'fatal.host.startFailed',
        true ? new Error('Conditional fatal copy') : Error('Fallback fatal copy'),
      )
      reportFatal('fatal.host.startFailed', Error('Callable fatal copy'))
    `).map(violation => violation.text)).toEqual([
      'Desktop window', 'Fatal error', 'Host failed to start', 'Fatal error',
      'Host process exited', 'Try again later', 'Close dialog', 'Namespace window',
      'Namespace fatal', 'Namespace host failure', 'Namespace fatal',
      'Namespace host exited', 'Fatal wrapper copy', 'Parenthesized fatal copy',
      'Asserted fatal copy', 'Satisfied fatal copy', 'Non-null fatal copy',
      'Conditional fatal copy', 'Fallback fatal copy', 'Callable fatal copy',
    ])
  })

  it('does not mistake shadowed Electron or fatal-reporter names for presentation bindings', () => {
    expect(findUiI18nViolations('apps/desktop/src/main.ts', `
      import {
        BrowserWindow as ElectronWindow,
        Notification as NativeNotification,
        dialog as nativeDialog,
      } from 'electron/main'
      import * as electron from 'electron/main'
      function reportFatal(_stage: string, _error?: unknown): void {}
      function shadow(
        ElectronWindow: any,
        NativeNotification: any,
        nativeDialog: any,
        electron: any,
        reportFatal: any,
      ): void {
        new ElectronWindow({ title: 'Shadow window' })
        new NativeNotification({ body: 'Shadow notification' })
        nativeDialog.showErrorBox('Shadow dialog', 'Shadow dialog body')
        new electron.BrowserWindow({ title: 'Shadow namespace window' })
        electron.dialog.showErrorBox('Shadow namespace dialog', 'Shadow namespace body')
        reportFatal('fatal.host.startFailed', new Error('Shadow fatal detail'))
      }
    `)).toEqual([])
  })

  it('accepts translated copy, dynamic values, structural attributes, and language tokens', () => {
    expect(messages(`
      const View = ({ t, value }: { t: (key: string) => string; value: string }) => (
        <section className="root" role="region" aria-label={t('overview')}>
          <span>{t('status.complete')}</span>
          <code>null</code>
          {value === 'pending' && <output>{value}</output>}
          <output>{value}</output>
        </section>
      )
    `)).toEqual([])
  })

  it('does not inspect locale dictionary owners', () => {
    expect(findUiI18nViolations(
      'packages/client/ui-example/src/client/locales.ts',
      'export const en = { title: "Hard-coded by design" }',
    )).toEqual([])
  })
})
