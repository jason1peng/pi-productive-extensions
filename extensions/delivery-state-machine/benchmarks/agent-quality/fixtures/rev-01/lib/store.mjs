export function rename(records, from, to) { const value=records[from]; delete records[to]; records[to]=value; delete records[from]; return records; }
