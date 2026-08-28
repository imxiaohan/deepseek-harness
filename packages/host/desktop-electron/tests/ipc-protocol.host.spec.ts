import { describe, expect, it } from 'vitest'
import { DesktopIpcId, parseDesktopIpcMessage, type DesktopIpcMessage } from '../src/index.ts'

const valid: DesktopIpcMessage[] = [
  { t: 'fetch', id: DesktopIpcId('f'), url: 'http://127.0.0.1/api/x', method: 'POST', headers: {}, body: '{}' },
  { t: 'fetch', id: DesktopIpcId('fs'), url: 'http://127.0.0.1/export', method: 'GET', headers: {}, streamBody: true },
  { t: 'fetch-cancel', id: DesktopIpcId('f') },
  { t: 'fetch-pull', id: DesktopIpcId('fs') },
  { t: 'fetch-res', id: DesktopIpcId('f'), status: 200, statusText: 'OK', headers: {}, body: null, bodyBase64: 'AA==' },
  { t: 'fetch-res', id: DesktopIpcId('fs'), status: 200, statusText: 'OK', headers: {}, body: null, bodyStream: true },
  { t: 'fetch-chunk', id: DesktopIpcId('fs'), bodyBase64: 'AA==' },
  { t: 'fetch-end', id: DesktopIpcId('fs') },
  { t: 'fetch-error', id: DesktopIpcId('fs'), error: 'failed' },
  { t: 'open-stream', id: DesktopIpcId('s'), endpoint: '$events', payload: {} },
  { t: 'stream-cancel', id: DesktopIpcId('s') },
  { t: 'stream-item', id: DesktopIpcId('s'), value: null },
  { t: 'stream-end', id: DesktopIpcId('s') },
  { t: 'stream-error', id: DesktopIpcId('s'), error: { code: 'internal' } },
  {
    t: 'boot-res',
    injections: [
      { kind: 'global', name: '__BOOT__', value: {} },
      { kind: 'script', placement: 'head', text: 'globalThis.ready = true' },
      { kind: 'script-src', placement: 'body', src: '/entry.js' },
      { kind: 'script-preload', src: '/preload.js' },
      { kind: 'style', text: 'body {}' },
      { kind: 'html', placement: 'body', html: '<main></main>' },
    ],
  },
  { t: 'shutdown', code: 0 },
  { t: 'shutdown', code: 1 },
]

describe('desktop IPC parser', () => {
  it('accepts every carrier message', () => {
    for (const message of valid) expect(parseDesktopIpcMessage(message)).toEqual(message)
  })

  it.each([
    null,
    [],
    {},
    { t: 'unknown' },
    { t: 'boot-res', injections: null },
    { t: 'boot-res', injections: [null] },
    { t: 'boot-res', injections: [{ kind: 1 }] },
    { t: 'boot-res', injections: [{ kind: 'unknown' }] },
    { t: 'boot-res', injections: [{ kind: 'script', placement: 'side', text: '' }] },
    { t: 'boot-res', injections: [{ kind: 'global', name: 1, value: null }] },
    { t: 'stream-end', id: 1 },
    { t: 'stream-item', id: 's' },
    { t: 'stream-error', id: 's' },
    { t: 'stream-cancel', id: 's', extra: true },
    { t: 'fetch-cancel', id: 1 },
    { t: 'fetch-pull', id: 1 },
    { t: 'fetch', id: 'f', url: '/', method: 'GET', headers: {}, streamBody: false },
    { t: 'open-stream', id: 's', endpoint: 1, payload: {} },
    { t: 'fetch', id: 'f', url: '/', method: 'GET', headers: { x: 1 } },
    { t: 'fetch', id: 'f', url: '/', method: 'GET', headers: {}, body: 1 },
    { t: 'fetch-res', id: 'f', status: '200', statusText: 'OK', headers: {}, body: null },
    { t: 'fetch-res', id: 'f', status: 200, statusText: 'OK', headers: {}, body: false },
    { t: 'fetch-res', id: 'f', status: 200, statusText: 'OK', headers: {}, body: null, bodyBase64: 1 },
    { t: 'fetch-res', id: 'f', status: 200, statusText: 'OK', headers: {}, body: 'x', bodyBase64: 'eA==' },
    { t: 'fetch-res', id: 'f', status: 200, statusText: 'OK', headers: {}, body: null, bodyStream: false },
    { t: 'fetch-res', id: 'f', status: 200, statusText: 'OK', headers: {}, body: 'x', bodyStream: true },
    { t: 'fetch-res', id: 'f', status: 200, statusText: 'OK', headers: {}, body: null, bodyBase64: 'eA==', bodyStream: true },
    { t: 'fetch-chunk', id: 1, bodyBase64: '' },
    { t: 'fetch-chunk', id: 'f' },
    { t: 'fetch-chunk', id: 'f', bodyBase64: 1 },
    { t: 'fetch-error', id: 1, error: 'failed' },
    { t: 'fetch-error', id: 'f' },
    { t: 'fetch-error', id: 'f', error: 1 },
    { t: 'shutdown', code: 2 },
    { t: 'shutdown', code: 0, extra: true },
  ])('rejects malformed traffic: %j', (value) => {
    expect(parseDesktopIpcMessage(value)).toBeUndefined()
  })
})
