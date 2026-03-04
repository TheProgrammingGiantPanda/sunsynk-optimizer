/**
 * Patches the global console to prefix every log/warn/error with a timestamp.
 * Import this module once at the top of the entry point — all code automatically
 * gets timestamped output, including third-party modules that use console directly.
 */

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 23);

const _log   = console.log.bind(console);
const _warn  = console.warn.bind(console);
const _error = console.error.bind(console);

console.log   = (...args: unknown[]) => _log  (`${ts()}`, ...args);
console.warn  = (...args: unknown[]) => _warn (`${ts()}`, ...args);
console.error = (...args: unknown[]) => _error(`${ts()}`, ...args);
