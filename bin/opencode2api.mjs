#!/usr/bin/env node
/**
 * Thin launcher so `npx opencode2api` / `npm i -g opencode2api` work.
 * All real work happens in ../server.mjs.
 */
await import(new URL("../server.mjs", import.meta.url));
