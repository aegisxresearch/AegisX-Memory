/**
 * The released version of AegisX-Memory, in one place for every surface that
 * reports it: `aegisxmemory --version`, doctor's build comparison, and the MCP
 * server handshake (`serverInfo.version`).
 *
 * Must equal package.json `version` — `test/version.test.ts` fails on drift, so
 * a release bump is a two-line change that cannot half-land.
 */
export const VERSION_BASE = '1.30.0';
