/**
 * Barrel re-export of the canonical data model.
 *
 * Everything under functions/src imports types and constants from HERE rather than
 * reaching across the repo directly, so the awkward relative path lives in exactly
 * one file. `shared/` is compiled into lib/ alongside functions/ (see tsconfig
 * rootDir) — there is no npm-workspace symlink for the deploy packager to miss.
 */
export * from '../../shared/src/index.js';
