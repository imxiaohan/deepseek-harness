/**
 * Registration, layering, and record behavior of the OS-keychain provider
 * over a stubbed desktop carrier lane: the environment layers resolve
 * locally, every managed-store operation crosses the lane, and the seam's
 * notification and exclusion contracts hold.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  DSH_LAUNCH_ENVIRONMENT_KEY,
  createLaunchEnvironmentSnapshot,
} from '@deepseek-ai/dsh-launch-environment'
import { credentialRef, credentialKey, parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import ElectronCredentialProvider from '../src/index.ts'

/** An in-memory managed store the stub lane answers from. */
function stubLane() {
  const refs = new Map<string, string>()
  const records = new Map<string, CredentialRecord>()
  const requests: string[] = []
  const lane = {
    nativeRequest: async (
      op: string,
      args: {
        ref?: string
        key?: string
        value?: string
        lease?: string
        record?: CredentialRecord | null
      } | undefined,
    ): Promise<unknown> => {
      requests.push(op)
      switch (op) {
        case 'credential-has':
          return refs.has(args!.ref!)
        case 'credential-get':
          return refs.get(args!.ref!) ?? null
        case 'credential-set':
          refs.set(args!.ref!, args!.value!)
          return true
        case 'credential-unset':
          return refs.delete(args!.ref!)
        case 'credential-record-status': {
          const record = records.get(args!.key!)
          if (record !== undefined) return { configured: true, kind: record.kind }
          // The wire validator admits a configured status without a kind tag;
          // one dedicated key answers that shape for the describe branch.
          return args!.key!.endsWith('/kindless')
            ? { configured: true }
            : { configured: false }
        }
        case 'credential-record-read':
          return records.get(args!.key!) ?? null
        case 'credential-record-list':
          return [...records].map(([key, record]) => ({ key, kind: record.kind }))
        case 'credential-record-lease':
          return { lease: `lease-${String(records.size)}-${args!.key}`, record: records.get(args!.key!) ?? null }
        case 'credential-record-commit':
          records.set(args!.key!, args!.record!)
          return args!.record!
        case 'credential-record-abort':
          return undefined
        case 'credential-record-delete':
          return records.delete(args!.key!)
        default:
          throw new Error(`stub lane: unknown op ${op}`)
      }
    },
  }
  return { lane, refs, records, requests }
}

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

/** Boot the provider over one lane and an optional environment layering. */
async function boot(
  lane: { nativeRequest: unknown },
  layers: Parameters<typeof createLaunchEnvironmentSnapshot>[0] = [],
): Promise<Context> {
  ctx = new Context()
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot(layers))
  ctx.provide('desktopRuntime', lane)
  const fiber = ctx.plugin(ElectronCredentialProvider)
  await fiber.await()
  return ctx
}

describe('ElectronCredentialProvider', () => {
  it('registers ctx.credentials and leaves with its fiber', async () => {
    const { lane } = stubLane()
    const current = await boot(lane)
    expect(current.get('credentials')).toBeInstanceOf(ElectronCredentialProvider)
    await current.fiber.dispose()
    expect(current.get('credentials')).toBeUndefined()
  })

  it('fails loud without a desktopRuntime lane', async () => {
    ctx = new Context()
    ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([]))
    const fiber = ctx.plugin(ElectronCredentialProvider)
    await fiber.await()
    const provider = ctx.get('credentials')!
    await expect(provider.resolve(credentialRef('ABSENT'))).rejects.toThrow('no desktopRuntime lane')
    await fiber.dispose()
  })

  it('layers inherited env over the keychain over .env fallbacks', async () => {
    const { lane, refs } = stubLane()
    refs.set('API_KEY', 'stored')
    const current = await boot(lane, [
      { source: 'process', values: { FROM_ENV: 'env-value' } },
      { source: 'project-env', values: { FROM_PROJECT: 'project-value' } },
      { source: 'user-env', values: { FROM_USER: 'user-value' } },
    ] as Parameters<typeof createLaunchEnvironmentSnapshot>[0])
    const provider = current.get('credentials')!

    await expect(provider.resolve(credentialRef('FROM_ENV'))).resolves.toEqual({ value: 'env-value', source: 'env' })
    await expect(provider.resolve(credentialRef('API_KEY'))).resolves.toEqual({ value: 'stored', source: 'keychain' })
    await expect(provider.resolve(credentialRef('FROM_PROJECT'))).resolves.toEqual({ value: 'project-value', source: 'project-env' })
    await expect(provider.resolve(credentialRef('FROM_USER'))).resolves.toEqual({ value: 'user-value', source: 'user-env' })
    await expect(provider.resolve(credentialRef('ABSENT'))).resolves.toBeUndefined()

    await expect(provider.describe(credentialRef('FROM_ENV'))).resolves.toEqual({ configured: true, source: 'env', writable: false })
    await expect(provider.describe(credentialRef('API_KEY'))).resolves.toEqual({ configured: true, source: 'keychain', writable: true })
    await expect(provider.describe(credentialRef('FROM_PROJECT'))).resolves.toEqual({ configured: true, source: 'project-env', writable: true })
    await expect(provider.describe(credentialRef('ABSENT'))).resolves.toEqual({ configured: false, writable: true })
  })

  it('writes through the lane and fans the reference-updated event', async () => {
    const { lane, refs } = stubLane()
    const current = await boot(lane)
    const provider = current.get('credentials')!
    const updated = vi.fn()
    current.on('credentials/reference-updated', updated)

    await expect(provider.set(credentialRef('NEW_KEY'), 'value-1')).resolves.toBeUndefined()
    expect(refs.get('NEW_KEY')).toBe('value-1')
    expect(updated).toHaveBeenCalledTimes(1)
    expect(updated).toHaveBeenCalledWith('NEW_KEY')

    // Removing an absent reference is a no-op and publishes nothing.
    updated.mockClear()
    await expect(provider.unset(credentialRef('ABSENT'))).resolves.toBeUndefined()
    expect(updated).not.toHaveBeenCalled()
    await expect(provider.unset(credentialRef('NEW_KEY'))).resolves.toBeUndefined()
    expect(refs.has('NEW_KEY')).toBe(false)
    expect(updated).toHaveBeenCalledTimes(1)
  })

  it('rejects empty values and writes the environment shadows', async () => {
    const { lane } = stubLane()
    const current = await boot(lane, [
      { source: 'process', values: { SHADOWED: 'env-value' } },
    ] as Parameters<typeof createLaunchEnvironmentSnapshot>[0])
    const provider = current.get('credentials')!

    await expect(provider.set(credentialRef('X'), '')).rejects.toThrow('an empty value cannot be stored')
    await expect(provider.set(credentialRef('SHADOWED'), 'v')).rejects.toThrow('shadowed')
    await expect(provider.unset(credentialRef('SHADOWED'))).rejects.toThrow('shadowed')
  })

  it('serves the record half through the lane, branding enumerated keys', async () => {
    const { lane, records } = stubLane()
    const key = credentialKey('llm-pi-ai', 'route')
    records.set(key, { kind: 'grant', payload: { token: 't' } })
    const current = await boot(lane)
    const provider = current.get('credentials')!

    await expect(provider.readRecord(key)).resolves.toEqual({ kind: 'grant', payload: { token: 't' } })
    await expect(provider.readRecord(credentialKey('llm-pi-ai', 'absent'))).resolves.toBeUndefined()
    await expect(provider.describeRecord(key)).resolves.toEqual({ configured: true, kind: 'grant', writable: true })
    await expect(provider.describeRecord(credentialKey('llm-pi-ai', 'absent')))
      .resolves.toEqual({ configured: false, writable: true })
    // A configured status without a kind tag is wire-admissible; describe
    // reports presence without inventing a discriminant.
    await expect(provider.describeRecord(credentialKey('llm-pi-ai', 'kindless')))
      .resolves.toEqual({ configured: true, writable: true })
    const entries = await provider.listRecords()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.key).toBe(key)
    expect(parseCredentialKey(entries[0]!.key)).toBe(key)
    expect(entries[0]!.kind).toBe('grant')
  })

  it('runs modifyRecord as lease, mutate, commit and publishes the write', async () => {
    const { lane } = stubLane()
    const key = credentialKey('llm-pi-ai', 'route')
    const current = await boot(lane)
    const provider = current.get('credentials')!
    const updated = vi.fn()
    current.on('credentials/record-updated', updated)

    const first = await provider.modifyRecord(key, async () => ({ kind: 'grant', payload: { n: 1 } }))
    expect(first).toEqual({ kind: 'grant', payload: { n: 1 } })
    expect(updated).toHaveBeenCalledTimes(1)

    // A mutation that declines leaves the record untouched and publishes nothing.
    updated.mockClear()
    const kept = await provider.modifyRecord(key, async () => undefined)
    expect(kept).toEqual({ kind: 'grant', payload: { n: 1 } })
    expect(updated).not.toHaveBeenCalled()

    // Declining over an absent record reports absence, not an error.
    await expect(provider.modifyRecord(credentialKey('llm-pi-ai', 'nothing'), async () => undefined))
      .resolves.toBeUndefined()

    // A mutation that throws releases the lease and propagates.
    await expect(provider.modifyRecord(key, async () => {
      throw new Error('mutate failed')
    })).rejects.toThrow('mutate failed')
    await expect(provider.readRecord(key)).resolves.toEqual({ kind: 'grant', payload: { n: 1 } })
  })

  it('deletes a record through the lane and publishes only real removals', async () => {
    const { lane, records } = stubLane()
    const key = credentialKey('llm-pi-ai', 'route')
    records.set(key, { kind: 'api-key', key: 'sk' })
    const current = await boot(lane)
    const provider = current.get('credentials')!
    const updated = vi.fn()
    current.on('credentials/record-updated', updated)

    await expect(provider.deleteRecord(credentialKey('llm-pi-ai', 'absent'))).resolves.toBeUndefined()
    expect(updated).not.toHaveBeenCalled()
    await expect(provider.deleteRecord(key)).resolves.toBeUndefined()
    expect(records.has(key)).toBe(false)
    expect(updated).toHaveBeenCalledTimes(1)
  })
})
