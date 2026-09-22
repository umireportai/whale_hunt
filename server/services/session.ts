import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface SessionView {
  readonly id: string;
  readonly name: string;
}

export class SessionError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

/** Stores the anonymous browser identity used by the Whale Hunt API. */
export class SessionService {
  constructor(private readonly db: DatabaseSync) {}

  create(): SessionView {
    const id = randomUUID();
    const name = `Navigator ${id.slice(0, 6).toUpperCase()}`;
    this.db
      .prepare('INSERT INTO sessions(id,name,created_at) VALUES(?,?,?)')
      .run(id, name, new Date().toISOString());
    return { id, name };
  }

  read(id: string): SessionView {
    const row = this.db.prepare('SELECT id,name FROM sessions WHERE id=?').get(id) as
      | { id: string; name: string }
      | undefined;
    if (!row) throw new SessionError('Start a session to enter Whale Hunt.', 401);
    return row;
  }

  rename(id: string, requestedName: string): SessionView {
    this.read(id);
    const name = requestedName.replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 24 || !/^[\p{L}\p{N} _.-]+$/u.test(name))
      throw new SessionError(
        'Choose a handle between 2 and 24 letters, numbers, spaces, dots, or dashes.',
      );
    this.db.prepare('UPDATE sessions SET name=? WHERE id=?').run(name, id);
    return this.read(id);
  }
}
