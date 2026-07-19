const cache = new Map();
export function remember(id, value, tenant) { cache.set(id, value); return value; }
export function recall(id, tenant) { return cache.get(id); }
export function clear() { cache.clear(); }
