import pg from 'pg';

export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(text: string): Promise<void>;
}

export interface ClosableDb extends Db {
  end(): Promise<void>;
}

export function pgDb(connectionString: string, onError?: (err: Error) => void): ClosableDb {
  const pool = new pg.Pool({ connectionString, max: 5 });
  pool.on('error', (err) => onError?.(err));
  return {
    async query<T>(text: string, params: unknown[] = []) {
      const r = await pool.query(text, params);
      return { rows: r.rows as T[] };
    },
    async exec(text: string) {
      await pool.query(text);
    },
    end: () => pool.end(),
  };
}
