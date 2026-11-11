/** A history node in a closure, for the tests that need one: units with a revision each, and the two
 *  answers the real node gives — a unit that does not exist yet, and a save that lands. The shell's
 *  custom commands (`shell.custom_commands`) are what it files there; its permission switches are the
 *  node's own file under `NODE_AGENT_HOME` (`settings.ts`), so a test reading `units` is reading what
 *  a restart would find of the *commands*. `call` is what `context(tenant, { call })` wants; `units`
 *  is what the test asserts on. */
export function fakeHistory() {
  const units = new Map();
  return {
    units,
    async call(node, cap, args) {
      if (node !== 'history') throw new Error(`this test has no "${node}" node`);
      const id = String(args?.unitId ?? '');
      if (cap === 'load') {
        const found = units.get(id);
        if (found === undefined)
          throw new Error(`persistent unit "default/shell/${id}" does not exist`);
        return { unit: { meta: structuredClone(found.meta), revision: found.revision } };
      }
      if (cap === 'save') {
        const before = units.get(id);
        const revision = (before?.revision ?? 0) + 1;
        units.set(id, { meta: structuredClone(args.meta), revision });
        return { unit: { meta: structuredClone(args.meta), revision } };
      }
      throw new Error(`history only provides load / save / delete / list (got "${cap}")`);
    },
  };
}
