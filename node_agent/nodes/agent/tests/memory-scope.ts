// A bus scope whose Unit constructor answers in-memory units, for the cache tests.
import type { BindingScope } from '@node-agent/sdk';

export function memoryScope(): BindingScope {
  const units = new Map<string, { meta: unknown; revision: number }>();
  const scope = {
    unit(_Ctor: unknown, unitId: string) {
      return {
        meta: undefined as unknown,
        revision: 0,
        async load() {
          const unit = units.get(unitId);
          if (unit !== undefined) {
            this.meta = unit.meta;
            this.revision = unit.revision;
          }
        },
        async save() {
          const current = units.get(unitId);
          if ((current?.revision ?? 0) !== this.revision) throw new Error('revision conflict');
          this.revision += 1;
          units.set(unitId, { meta: this.meta, revision: this.revision });
        },
        async delete() {
          if ((units.get(unitId)?.revision ?? 0) !== this.revision)
            throw new Error('revision conflict');
          units.delete(unitId);
          this.revision = 0;
        },
      };
    },
  };
  return scope as unknown as BindingScope;
}
