/**
 * `node:sqlite` emits an ExperimentalWarning on every process start. We have
 * chosen it deliberately, and a warning on every CLI invocation trains people
 * to ignore stderr — which is where the warnings that matter go. Everything
 * else still comes through.
 */
const SILENCED = new Set(['node:sqlite', 'SQLite']);

/**
 * Runs on import, not on call: `node:sqlite` emits its warning while the import
 * graph is still evaluating, so a call from a module body is already too late.
 * Import this module first in every entry point.
 */
export function quietExperimentalWarnings(): void {
  process.removeAllListeners('warning');
  process.on('warning', (warning) => {
    const isSqlite = warning.name === 'ExperimentalWarning' && [...SILENCED].some((s) => warning.message.includes(s));
    if (isSqlite) return;
    process.stderr.write(`${warning.name}: ${warning.message}\n`);
  });
}

quietExperimentalWarnings();
