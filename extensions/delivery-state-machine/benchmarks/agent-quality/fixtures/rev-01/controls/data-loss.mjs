import assert from "node:assert/strict"; import {rename} from "../lib/store.mjs"; const records={a:"A",b:"B"}; const result=rename(records,"missing","b"); assert.deepEqual(result,{a:"A",b:"B"});
