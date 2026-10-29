#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 o2api contributors
/**
 * Thin launcher so `npx o2api` / `npm i -g o2api` work.
 * All real work happens in ../server.mjs.
 */
await import(new URL("../server.mjs", import.meta.url));
