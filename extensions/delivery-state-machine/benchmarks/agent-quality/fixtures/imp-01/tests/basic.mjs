import assert from "node:assert/strict"; import {clear,remember,recall} from "../src/cache.mjs";
clear(); remember("x", 1); assert.equal(recall("x"), 1); console.log("basic pass");
