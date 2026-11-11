// The local placement: one JSON document on this machine.
//
// This is the store behind `local-provider` - the same package pointed at the endpoint this stack runs
// itself. Those credentials are the stack's, not the bus's, so they are not written to a history unit
// every node on the bus could read: they go to the file `mode.ts` names, in the same document shape
// history holds, so either store can read what the other wrote.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { JsonObject } from '../providers/base.js';
import { type ProviderRows, type ProviderStore, rowsIn } from './index.js';

export class LocalStore implements ProviderStore {
  readonly path: string;
  /** A file survives the process, so the page is told the rows are kept. */
  persistent = true;

  constructor(path: string) {
    this.path = path;
  }

  /** The rows this stack saved for itself, or null when it has not saved any yet.
   *
   * A file that is there and cannot be parsed is an error, not an empty list: starting over would
   * show one blank row and let the page's next save overwrite every row it hid.
   */
  async read(): Promise<ProviderRows | null> {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const document = JSON.parse(text) as JsonObject;
    const rows = rowsIn(document.providers);
    return Object.keys(rows).length > 0 ? rows : null;
  }

  /** Write the rows where that file lives, through a temporary name so a crash leaves the old one.
   *
   * The rows carry API keys, so the file is `0600` and its directory `0700`: unencrypted, but not
   * readable by every other user on the machine. The temporary file is chmodded too - a stale one
   * from an earlier crash would otherwise keep whatever mode it was made with.
   */
  async write(rows: ProviderRows): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ providers: rows }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.path);
  }
}
