/**
 * query-plan-utils.mjs — shared helpers for query-plan regression guards.
 *
 * Used by test-attribution-same-row.mjs and test-stats-provenance-plan.mjs to
 * capture the REAL SQL a VocabularyDb method emits and EXPLAIN its plan. Both
 * guards assert the planner drives from a small match set, not a full scan.
 */
import Database from "better-sqlite3";

/**
 * Run fn() with Database.prototype.prepare instrumented to collect every SQL
 * string prepared during the call, then restore the prototype (even on throw).
 * Returns the captured SQL strings as an array.
 */
export function captureSql(fn) {
  const captured = new Set();
  const orig = Database.prototype.prepare;
  Database.prototype.prepare = function (sql) {
    captured.add(sql);
    return orig.call(this, sql);
  };
  try {
    fn();
  } finally {
    Database.prototype.prepare = orig;
  }
  return [...captured];
}

/**
 * EXPLAIN QUERY PLAN for sql against a readonly copy of dbPath, returning the
 * plan rows. Placeholders are bound to 1 (plan shape is binding-independent) and
 * the haversine_km UDF that geo-search SQL references is stubbed so EXPLAIN
 * doesn't throw on it.
 */
export function explainPlan(dbPath, sql) {
  const db = new Database(dbPath, { readonly: true });
  db.function("haversine_km", () => 0);
  try {
    return db.prepare("EXPLAIN QUERY PLAN " + sql.replace(/\?/g, "1")).all();
  } finally {
    db.close();
  }
}
