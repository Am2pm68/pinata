import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// `node:sqlite` is not listed in Node's `builtinModules`, so a static import
// makes Vite try to resolve it as a package on disk. Loading it through
// createRequire keeps it out of the bundler's dependency graph.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = InstanceType<typeof DatabaseSync>;

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(here, '..', '..', 'migrations', '0001_init.sql');

/**
 * A D1-shaped facade over Node's built-in SQLite.
 *
 * D1 is SQLite, so the semantics the code actually depends on -- UNIQUE
 * constraints, `ON CONFLICT DO NOTHING`, and `meta.changes` reporting 0 when a
 * conditional UPDATE matches nothing -- are the real thing here rather than a
 * mock. That is the whole point: the idempotency guarantees are tested against
 * the engine that enforces them in production.
 */
function sanitise(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

class FakeStatement {
  private args: unknown[] = [];

  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
  ) {}

  bind(...args: unknown[]): FakeStatement {
    this.args = args.map(sanitise);
    return this;
  }

  async first<T>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...(this.args as never[]));
    return (row as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[]; success: true }> {
    const rows = this.db.prepare(this.sql).all(...(this.args as never[]));
    return { results: rows as T[], success: true };
  }

  async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    const result = this.db.prepare(this.sql).run(...(this.args as never[]));
    return {
      success: true,
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }
}

export class FakeD1 {
  readonly raw: DatabaseSync;

  constructor() {
    this.raw = new DatabaseSync(':memory:');
    this.raw.exec(readFileSync(MIGRATION, 'utf8'));
  }

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this.raw, sql);
  }
}

export function makeD1(): D1Database {
  return new FakeD1() as unknown as D1Database;
}
