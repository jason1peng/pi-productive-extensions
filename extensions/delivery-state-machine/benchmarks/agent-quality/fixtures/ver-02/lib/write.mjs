import {writeFileSync} from "node:fs"; export function writeOnce(file, value) { writeFileSync(file, value, {flag:"wx"}); }
