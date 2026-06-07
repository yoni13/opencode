export * as WorkspaceV2 from "./workspace"

import { Schema } from "effect"
import { withStatics } from "./schema"
import { Identifier } from "./util/identifier"

const pattern = /^wrk[_-][A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export const ID = Schema.String.check(Schema.isPattern(pattern)).pipe(
  Schema.brand("WorkspaceV2.ID"),
  withStatics((schema) => ({
    ascending: (id?: string) => {
      if (!id) return schema.make("wrk_" + Identifier.ascending())
      if (!pattern.test(id)) throw new Error(`Invalid workspace ID: ${id}`)
      return schema.make(id)
    },
    create: () => schema.make("wrk_" + Identifier.ascending()),
  })),
)
export type ID = typeof ID.Type
