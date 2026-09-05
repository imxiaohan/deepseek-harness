import { describe, expect, it } from 'vitest'
import { DesktopIpcId, type DesktopHostChannel, type DesktopIpcMessage } from '../src/index.ts'
import { createNativeHostClient } from '../src/native-host-client.ts'

/** An in-memory channel whose inbound native answers the test drives. */
function openChannel() {
  const listeners = new Set<(message: DesktopIpcMessage) => void>()
  const sent: DesktopIpcMessage[] = []
  const channel: DesktopHostChannel = {
    send: (message) => { sent.push(message) },
    onMessage: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return {
    channel, sent,
    deliver: (message: DesktopIpcMessage) => { for (const listener of [...listeners]) listener(message) },
    disposed: () => listeners.size === 0,
  }
}

describe('native host client', () => {
  it('sends a native request and resolves the matched ok value', async () => {
    const { channel, sent, deliver } = openChannel()
    const client = createNativeHostClient(channel)
    const waited = client.request('directory-pick', undefined, new AbortController().signal)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.t).toBe('native-request')
    const request = sent[0] as { op: string; id: string }
    expect(request.op).toBe('directory-pick')
    expect(request.id).toBeTypeOf('string')
    deliver({ t: 'native-ok', id: DesktopIpcId(request.id), op: 'directory-pick', value: '/chosen' })
    await expect(waited).resolves.toBe('/chosen')
  })

  it('rejects with the main process error text', async () => {
    const { channel, sent, deliver } = openChannel()
    const client = createNativeHostClient(channel)
    const waited = client.request('credential-get', { ref: 'X' }, new AbortController().signal)
    deliver({
      t: 'native-error',
      id: DesktopIpcId((sent[0] as { id: string }).id),
      op: 'credential-get',
      error: 'encryption unavailable',
    })
    await expect(waited).rejects.toThrow('encryption unavailable')
  })

  it('resolves null when the operator cancels the chooser', async () => {
    const { channel, sent, deliver } = openChannel()
    const client = createNativeHostClient(channel)
    const waited = client.request('directory-pick', undefined, new AbortController().signal)
    deliver({
      t: 'native-ok',
      id: DesktopIpcId((sent[0] as { id: string }).id),
      op: 'directory-pick',
      value: null,
    })
    await expect(waited).resolves.toBeNull()
  })

  it('rejects when the caller signal aborts before any answer', async () => {
    const { channel } = openChannel()
    const client = createNativeHostClient(channel)
    const controller = new AbortController()
    const waited = client.request('directory-pick', undefined, controller.signal)
    controller.abort(new Error('caller cancelled'))
    await expect(waited).rejects.toThrow('desktop native directory-pick request aborted')
  })

  it('drops an answer after the client disposes', async () => {
    const { channel, sent, deliver, disposed } = openChannel()
    const client = createNativeHostClient(channel)
    const waited = client.request('directory-pick', undefined, new AbortController().signal)
    client.dispose()
    expect(disposed()).toBe(true)
    deliver({
      t: 'native-ok',
      id: DesktopIpcId((sent[0] as { id: string }).id),
      op: 'directory-pick',
      value: '/late',
    })
    // The unmatched answer must not resolve or reject the settled waiter.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(waited).toBeInstanceOf(Promise)
  })

  it('ignores unknown-correlation and unrelated responses', async () => {
    const { channel, deliver } = openChannel()
    const client = createNativeHostClient(channel)
    const waited = client.request('directory-pick', undefined, new AbortController().signal)
    deliver({ t: 'native-ok', id: DesktopIpcId('unknown'), op: 'directory-pick', value: '/stray' })
    deliver({ t: 'fetch-end', id: DesktopIpcId('other') })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(waited).toBeInstanceOf(Promise)
    client.dispose()
  })

  it('rejects and surfaces when the carrier send throws', async () => {
    const channel: DesktopHostChannel = {
      send: () => { throw new Error('ipc closed') },
      onMessage: () => () => {},
    }
    const client = createNativeHostClient(channel)
    await expect(client.request('directory-pick', undefined, new AbortController().signal))
      .rejects.toThrow('ipc closed')
  })

  it('maps a non-Error carrier send failure to an Error', async () => {
    const channel: DesktopHostChannel = {
      send: () => { throw 'ipc closed' },
      onMessage: () => () => {},
    }
    const client = createNativeHostClient(channel)
    await expect(client.request('directory-pick', undefined, new AbortController().signal))
      .rejects.toThrow('ipc closed')
  })

  it('ignores an abort arrival after the waiter already settled', async () => {
    const { channel, sent, deliver } = openChannel()
    const client = createNativeHostClient(channel)
    const controller = new AbortController()
    const waited = client.request('directory-pick', undefined, controller.signal)
    deliver({
      t: 'native-ok',
      id: DesktopIpcId((sent[0] as { id: string }).id),
      op: 'directory-pick',
      value: '/settled',
    })
    controller.abort()
    await expect(waited).resolves.toBe('/settled')
    client.dispose()
  })
})
