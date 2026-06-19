import { Effect, ScopedCache, Scope } from "effect"
import * as EffectLogger from "@opencode-ai/core/effect/logger"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceRef, WorkspaceRef } from "./instance-ref"
import { registerDisposer } from "./instance-registry"
import { WorkspaceContext } from "@/control-plane/workspace-context"

const TypeId = "~opencode/InstanceState"

export interface InstanceState<A, E = never, R = never> {
  readonly [TypeId]: typeof TypeId
  readonly cache: ScopedCache.ScopedCache<string, A, E, R>
  readonly keysByDirectory: Map<string, Set<string>>
}

export const context = Effect.gen(function* () {
  const ctx = yield* InstanceRef
  if (!ctx) return yield* Effect.die(new Error("InstanceRef not provided"))
  return ctx
})

export const workspaceID = Effect.gen(function* () {
  return (yield* WorkspaceRef) ?? WorkspaceContext.workspaceID
})

export const directory = Effect.map(context, (ctx) => ctx.directory)

const cacheKey = Effect.gen(function* () {
  const dir = yield* directory
  const workspace = yield* workspaceID
  return {
    directory: dir,
    key: workspace ? `${dir}\u0000${workspace}` : dir,
  }
})

export const make = <A, E = never, R = never>(
  init: (ctx: InstanceContext) => Effect.Effect<A, E, R | Scope.Scope>,
): Effect.Effect<InstanceState<A, E, Exclude<R, Scope.Scope>>, never, R | Scope.Scope> =>
  Effect.gen(function* () {
    const keysByDirectory = new Map<string, Set<string>>()
    const cache = yield* ScopedCache.make<string, A, E, R>({
      capacity: Number.POSITIVE_INFINITY,
      lookup: () =>
        Effect.gen(function* () {
          return yield* init(yield* context)
        }),
    })

    const off = registerDisposer((directory) =>
      Effect.runPromise(
        Effect.gen(function* () {
          for (const key of keysByDirectory.get(directory) ?? [directory]) {
            yield* ScopedCache.invalidate(cache, key)
          }
          keysByDirectory.delete(directory)
        }).pipe(Effect.provide(EffectLogger.layer)),
      ),
    )
    yield* Effect.addFinalizer(() => Effect.sync(off))

    return {
      [TypeId]: TypeId,
      cache,
      keysByDirectory,
    }
  })

export const get = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    const key = yield* cacheKey
    const keys = self.keysByDirectory.get(key.directory) ?? new Set<string>()
    keys.add(key.key)
    self.keysByDirectory.set(key.directory, keys)
    return yield* ScopedCache.get(self.cache, key.key)
  })

export const use = <A, E, R, B>(self: InstanceState<A, E, R>, select: (value: A) => B) => Effect.map(get(self), select)

export const useEffect = <A, E, R, B, E2, R2>(
  self: InstanceState<A, E, R>,
  select: (value: A) => Effect.Effect<B, E2, R2>,
) => Effect.flatMap(get(self), select)

export const has = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.has(self.cache, (yield* cacheKey).key)
  })

export const invalidate = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    const key = yield* cacheKey
    yield* ScopedCache.invalidate(self.cache, key.key)
    const keys = self.keysByDirectory.get(key.directory)
    keys?.delete(key.key)
    if (keys?.size === 0) self.keysByDirectory.delete(key.directory)
  })

export * as InstanceState from "./instance-state"
