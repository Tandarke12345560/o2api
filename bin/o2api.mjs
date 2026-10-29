#!/usr/bin/env node
/**
 * Thin launcher so `npx o2api` / `npm i -g o2api` work.
 * All real work happens in ../server.mjs.
 */
await import(new URL("../server.mjs", import.meta.url));
