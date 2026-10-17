// A bounded store for answers that never change. Entries leave oldest first
// once their bodies add up to more than `maxBytes`, and one that is read counts
// as new again, so what a class keeps asking for stays.
export const createCache = (maxBytes) => {
  const entries = new Map();
  let bytes = 0;

  return {
    get(key) {
      const entry = entries.get(key);
      if (entry !== undefined) {
        entries.delete(key);
        entries.set(key, entry);
      }
      return entry;
    },

    set(key, entry) {
      const size = entry.body.length;
      if (size > maxBytes) return;
      if (entries.has(key)) bytes -= entries.get(key).body.length;
      entries.delete(key);
      entries.set(key, entry);
      bytes += size;
      for (const [oldest, old] of entries) {
        if (bytes <= maxBytes) break;
        entries.delete(oldest);
        bytes -= old.body.length;
      }
    },

    get size() {
      return entries.size;
    },
  };
};
