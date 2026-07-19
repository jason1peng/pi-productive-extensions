import assert from "node:assert/strict"; import {clear,remember,recall} from "../src/cache.mjs";
clear(); remember("x", "A", "tenant-a"); remember("x", "B", "tenant-b"); assert.equal(recall("x", "tenant-a"), "A"); assert.equal(recall("x", "tenant-b"), "B"); clear(); remember("x", "default"); assert.equal(recall("x"), "default"); console.log("tenant pass");
