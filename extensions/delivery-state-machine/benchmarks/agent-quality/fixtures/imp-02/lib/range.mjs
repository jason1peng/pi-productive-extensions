export function inclusiveRange(start, end) { return Array.from({length: Math.max(0, end - start)}, (_, index) => start + index); }
