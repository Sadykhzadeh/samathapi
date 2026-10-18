// A bounded store for answers that never change. Entries leave oldest first
// once what they cost adds up to more than `maxBytes`, and one that is read
// counts as new again, so what a class keeps asking for stays. An entry costs
// the length of its body unless `cost(key, entry)` says otherwise.
export const createCache = (maxBytes, cost = (key, entry) => entry.body.length) => {
  const entries = new Map();
  let bytes = 0;

  const drop = (key) => {
    bytes -= entries.get(key).size;
    entries.delete(key);
  };

  return {
    get(key) {
      const held = entries.get(key);
      if (held === undefined) return undefined;
      entries.delete(key);
      entries.set(key, held);
      return held.entry;
    },

    set(key, entry) {
      const size = cost(key, entry);
      if (size > maxBytes) return;
      if (entries.has(key)) drop(key);
      entries.set(key, { entry, size });
      bytes += size;
      for (const oldest of entries.keys()) {
        if (bytes <= maxBytes) break;
        drop(oldest);
      }
    },

    get size() {
      return entries.size;
    },
  };
};
