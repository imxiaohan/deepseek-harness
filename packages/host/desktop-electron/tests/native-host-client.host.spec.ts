import { describe, expect, it } from 'vitest'
import { DesktopIpcId, type DesktopHostChannel, type DesktopIpcMessage } from '../src/index.ts'
import { createNativeHostClient } from '../src/native-host-client.ts'

/** An in-memory channel whose inbound `pick-directory` the test answers. */
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
  it('sends a pick-directory request and resolves the matched response', async () => {
    const { channel, sent, deliver } = openChannel()
    const client = createNativeHostClient(channel)
    const waited = client.pickDirectory(new AbortController().signal)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.t).toBe('pick-directory')
    const id = DesktopIpcId((sent[0] as { id: string }).id)
    deliver({ t: 'pick-directory-res', id, path: '/chosen' })
    await expect(waited).resolves.toBe('/chosen')
  })

  it('resolves null when the operator cancels', async () => {
    const { channel, sent, deliver } = openChannel()
    const client = createNativeHostClient(channel)
    const waited = client.pickDirectory(new AbortController().signal)
    deliver({ t: 'pick-directory-res', id: DesktopIpcId((sent[0] as { id: string }).id), path: null })
    await expect(waited).resolves.toBeNull()
  })

  it('rejects when the caller signal aborts before any response', async () => {
    const { channel } = openChannel()
    const client = createNativeHostClient(channel)
    const controller = new AbortController()
    const waited = client.pickDirectory(controller.signal)
    controller.abort(new Error('caller cancelled'))
    await expect(waited).rejects.toThrow('desktop native directory pick aborted')
  })

  it('drops a response after the client disposes', async () => {
    const { channel, sent, deliver, disposed } = openChannel()
    const client = createNativeHostClient(channel)
    const waited = client.pickDirectory(new AbortController().signal)
    client.dispose()
    expect(disposed()).toBe(true)
    deliver({ t: 'pick-directory-res', id: DesktopIpcId((sent[0] as { id: string }).id), path: '/late' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(waited).toBeInstanceOf(Promise)
  })

  it('ignores unknown-correlation and unrelated responses', async () => {
    const { channel, deliver } = openChannel()
    const client = createNativeHostClient(channel)
    const waited = client.pickDirectory(new AbortController().signal)
    deliver({ t: 'pick-directory-res', id: DesktopIpcId('unknown'), path: '/stray' })
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
    await expect(client.pickDirectory(new AbortController().signal)).rejects.toThrow('ipc closed')
  })

  it('maps a non-Error carrier send failure to an Error', async () => {
    const channel: DesktopHostChannel = {
      send: () => { throw 'ipc closed' },
      onMessage: () => () => {},
    }
    const client = createNativeHostClient(channel)
    await expect(client.pickDirectory(new AbortController().signal)).rejects.toThrow('ipc closed')
  })

  it('ignores an abort arrival after the waiter already settled', async () => {
    const { channel, sent, deliver } = openChannel()
    const client = createNativeHostClient(channel)
    const controller = new AbortController()
    const waited = client.pickDirectory(controller.signal)
    deliver({ t: 'pick-directory-res', id: DesktopIpcId((sent[0] as { id: string }).id), path: '/dettled' })
    controller.abort()
    await expect(waited).resolves.toBe('/dettled')
    client.dispose()
  })
})
