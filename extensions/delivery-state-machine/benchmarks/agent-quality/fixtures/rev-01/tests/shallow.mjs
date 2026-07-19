import assert from "node:assert/strict"; import {rename} from "../lib/store.mjs"; assert.deepEqual(rename({a:"A"},"a","b"),{b:"A"}); console.log("pass");
