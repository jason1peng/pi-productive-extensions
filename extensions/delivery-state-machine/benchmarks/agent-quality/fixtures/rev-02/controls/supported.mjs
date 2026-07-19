import assert from "node:assert/strict"; import {append} from "../lib/queue.mjs"; assert.deepEqual(append([1],2),[1,2]); console.log("pass");
