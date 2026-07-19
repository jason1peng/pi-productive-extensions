import assert from "node:assert/strict"; import {formatUser} from "../lib/format.mjs"; assert.equal(formatUser({name:"Ada"}), "ADA"); console.log("unit pass");
