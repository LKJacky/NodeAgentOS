// Long-running commands. `exec` spawns a process and waits only `yield_ms`; if it is still
// running the caller gets a session handle and the process keeps going. Output lives in two ring
// buffers with a read cursor, so every poll answers with what is *new* rather than the whole log
// again — and a session that outlives its turn is still there in the next one.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/** The only environment variables a command may inherit. A trailing `*` is a prefix, so `LC_*`
 *  covers the locale family. */
export const CHILD_ENV_KEEP = [
  'PATH',
  'HOME',
  'LANG',
  'LC_*',
  'TERM',
  'SHELL',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TZ',
] as const;

/** Does one `CHILD_ENV_KEEP` entry cover this variable name? */
function keeps(name: string, pattern: string): boolean {
  return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

/**
 * The environment `exec` hands a command: a **whitelist**, and nothing outside it.
 *
 * The node's own environment is the wrong thing to pass on. It holds the bus token
 * (`NODE_AGENT_TOKEN`), the serving credentials (`SERVE_*`), whatever the deployment exported to
 * pay for a model (`*_API_KEY`, `*_SECRET`), and the agent's own keys (`AWS_*`, `GITHUB_TOKEN`,
 * `NPM_TOKEN`, `SSH_AUTH_SOCK`, …). Inherited, all of it is readable with no permission bypass at
 * all — `echo $NODE_AGENT_TOKEN` was enough to walk off with the bus.
 *
 * That is why this is a whitelist and not a blacklist. A blacklist only names the secrets someone
 * remembered on the day it was written; the next secret added anywhere else in the workspace would
 * be inherited again, because whoever adds a new one has no reason to think of this file. Inverted,
 * the default is "no": a name that is not listed here — secret, new `NODE_AGENT_*`, whatever —
 * never reaches a command, and letting one through is a deliberate edit to this list. If a command
 * ever needs another variable, add it *here*, knowing it becomes readable by every command.
 *
 * `run-node` is the one deliberate exception: it adds only `NODE_AGENT_BUS_URL` and
 * `NODE_AGENT_TOKEN` (plus an optional node name) to the filtered environment, because starting a
 * local node is exactly the case where those two are the point. `exec` still inherits neither.
 */
export function childEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (CHILD_ENV_KEEP.some((pattern) => keeps(name, pattern))) env[name] = value;
  }
  return env;
}

/** Characters of one stream kept per session. Older output is dropped (and counted), never the
 *  process: the model is reading a tail, not archiving a log. */
export const SESSION_BUFFER_CHARS = 256 * 1024;

/** Sessions that may be live at once — the cheapest guard against a model that forks forever. */
export const MAX_SESSIONS_RUNNING = 8;

/** How many finished sessions stay readable, and for how long each one does. */
export const MAX_SESSIONS_FINISHED = 8;
export const SESSION_TTL_MS = 5 * 60_000;

/** Hard cap on one session's life, whatever the caller asked for. */
export const SESSION_MAX_MS = 30 * 60_000;

/** After SIGTERM, how long a process gets to leave on its own before SIGKILL. */
const GRACE_MS = 2_000;

/** `timeout(1)`'s exit code, so a deadline kill still reports what callers know. */
export const TIMEOUT_CODE = 124;

/** What one session looks like from outside. */
export interface SessionStatus {
  id: string;
  command: string;
  cwd: string;
  pid: number | undefined;
  running: boolean;
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  spawnError: string | null;
  startedAt: number;
  ageMs: number;
}

/** One stream read: the new characters, and whether more are already buffered. */
export interface StreamRead {
  text: string;
  more: boolean;
}

/** One poll of a session: its status, what is new on each stream, and what was lost. */
export interface Poll {
  status: SessionStatus;
  stdout: StreamRead;
  stderr: StreamRead;
  dropped: number;
}

/** The tail of one stream plus a read cursor. `push` keeps it bounded, `take` hands each reader
 *  only the characters it has not seen. */
class Ring {
  private text = '';
  private read = 0;
  private lost = 0;

  push(chunk: string): void {
    this.text += chunk;
    const over = this.text.length - SESSION_BUFFER_CHARS;
    if (over <= 0) return;

    this.text = this.text.slice(over);
    this.lost += over;
    this.read = Math.max(0, this.read - over);
  }

  take(max: number): StreamRead {
    const text = this.text.slice(this.read, this.read + max);
    this.read += text.length;
    return { text, more: this.read < this.text.length };
  }

  /** Characters evicted before the reader ever saw them; reported once. */
  drainLost(): number {
    const lost = this.lost;
    this.lost = 0;
    return lost;
  }
}

/** One spawned command, alive or finished. `Sessions.create` makes it; the manager adopts it
 *  only when `exec` actually hands the caller a handle, so a fast command never becomes one. */
export class Session {
  readonly id: string;
  readonly command: string;
  readonly cwd: string;
  readonly startedAt = Date.now();

  /** Resolves when the process is gone: exited, killed, or never started. */
  readonly exited: Promise<void>;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly out = new Ring();
  private readonly err = new Ring();
  private ended!: () => void;
  private deadline: NodeJS.Timeout | null = null;
  private done = false;
  private code: number | null = null;
  private signal: string | null = null;
  private timedOut = false;
  private spawnError: string | null = null;

  /** @param id this node's handle for the session (`s1`, `s2`, …).
   *  @param timeoutMs an optional hard deadline; without it only `SESSION_MAX_MS` applies.
   *  @param extraEnv named additions a capability makes on purpose (`run-node`'s bus URL/token).
   *  @param argv the words `/bin/sh -c` is given after the script: `$0`, then `$1`, `$2`, … They
   *    reach the script as separate argv entries — a caller's argument is never text the shell parses,
   *    which is the one way a parameter can stay a parameter. */
  constructor(
    id: string,
    command: string,
    cwd: string,
    timeoutMs?: number,
    extraEnv: Record<string, string> = {},
    argv: readonly string[] = [],
  ) {
    this.id = id;
    this.command = command;
    this.cwd = cwd;

    // detached: the child leads its own process group, so a kill can take its children too —
    // otherwise `sh -c 'sleep 100'` leaves the sleep behind. `env` is filtered (see `childEnv`):
    // without it the child would inherit the bus token and every key this node was given.
    this.child = spawn('/bin/sh', ['-c', command, ...argv], {
      cwd,
      detached: true,
      env: { ...childEnv(), ...extraEnv },
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.out.push(chunk));
    this.child.stderr.on('data', (chunk: string) => this.err.push(chunk));
    // Writing to a pipeline whose reader is gone is not news; the exit code already says so.
    this.child.stdin.on('error', () => {});

    this.exited = new Promise<void>((ok) => {
      this.ended = ok;
    });
    this.child.once('error', (error: Error) => this.finish(null, null, error.message));
    this.child.once('close', (code, signal) => this.finish(code, signal));

    // A deadline of its own, so nothing lives forever even if nobody ever kills it.
    const cap = Math.min(timeoutMs ?? SESSION_MAX_MS, SESSION_MAX_MS);
    this.deadline = setTimeout(() => {
      this.timedOut = true;
      this.signalGroup('SIGKILL');
    }, cap);
  }

  /** SIGTERM by default; anything the process has not left from gets SIGKILL after the grace. */
  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.done) return;
    this.signalGroup(signal);
    if (signal === 'SIGKILL') return;

    const timer = setTimeout(() => this.signalGroup('SIGKILL'), GRACE_MS);
    timer.unref?.();
  }

  /** Shutdown path: no grace period, because whoever would wait for it is going away. */
  destroy(): void {
    if (this.deadline !== null) clearTimeout(this.deadline);
    if (!this.done) this.signalGroup('SIGKILL');
  }

  /** Send characters to the process's stdin. */
  write(chars: string): void {
    if (!this.done) this.child.stdin.write(chars);
  }

  /** Close stdin, for programs that read until EOF. */
  endInput(): void {
    if (!this.done) this.child.stdin.end();
  }

  /** Resolve when the process is gone, or after `ms` — whichever happens first. */
  async wait(ms: number): Promise<void> {
    if (this.done) return;
    const timer = new Promise<void>((ok) => {
      setTimeout(ok, ms).unref?.();
    });
    await Promise.race([this.exited, timer]);
  }

  status(): SessionStatus {
    return {
      id: this.id,
      command: this.command,
      cwd: this.cwd,
      pid: this.child.pid,
      running: !this.done,
      code: this.code,
      signal: this.signal,
      timedOut: this.timedOut,
      spawnError: this.spawnError,
      startedAt: this.startedAt,
      ageMs: Date.now() - this.startedAt,
    };
  }

  /** Everything new since the previous poll, capped at `max` characters per stream. */
  poll(max: number): Poll {
    return {
      status: this.status(),
      stdout: this.out.take(max),
      stderr: this.err.take(max),
      dropped: this.out.drainLost() + this.err.drainLost(),
    };
  }

  private finish(code: number | null, signal: string | null, error?: string): void {
    if (this.done) return;
    this.done = true;
    this.code = code;
    this.signal = signal;
    if (error !== undefined) this.spawnError = error;
    if (this.deadline !== null) clearTimeout(this.deadline);
    this.ended();
  }

  private signalGroup(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        this.child.kill(signal);
      } catch {
        // Already gone.
      }
    }
  }
}

/** The node's sessions: what `exec` started and handed back. */
export class Sessions {
  private seq = 0;
  private readonly running = new Map<string, Session>();
  private readonly finished = new Map<string, Session>();

  /** Spawn one command. It is not listed until `adopt()` — a command that finishes inside the
   *  first yield is answered inline and never needs a handle. */
  create(
    command: string,
    cwd: string,
    timeoutMs?: number,
    extraEnv: Record<string, string> = {},
    argv: readonly string[] = [],
  ): Session {
    if (this.running.size >= MAX_SESSIONS_RUNNING)
      throw new Error(
        `at most ${MAX_SESSIONS_RUNNING} long commands at once: stop one with shell.kill-session first`,
      );

    return new Session(`s${++this.seq}`, command, cwd, timeoutMs, extraEnv, argv);
  }

  /** Keep this session, so `write-stdin` / `sessions` / `kill-session` can find it later. */
  adopt(session: Session): void {
    this.running.set(session.id, session);
    void session.exited.then(() => this.retire(session.id));
  }

  /** One session by id, running or finished. */
  get(id: string): Session {
    const session = this.running.get(id) ?? this.finished.get(id);
    if (session === undefined)
      throw new Error(`no session "${id}": see what there is with shell.sessions`);
    return session;
  }

  /** Running first, then the finished ones still being kept. */
  list(): SessionStatus[] {
    return [...this.running.values(), ...this.finished.values()].map((session) => session.status());
  }

  /** Node shutdown: kill the process groups outright. */
  destroyAll(): void {
    for (const session of this.running.values()) session.destroy();
  }

  private retire(id: string): void {
    const session = this.running.get(id);
    if (session === undefined) return;

    this.running.delete(id);
    this.finished.set(id, session);
    const timer = setTimeout(() => this.finished.delete(id), SESSION_TTL_MS);
    timer.unref?.();

    while (this.finished.size > MAX_SESSIONS_FINISHED) {
      this.finished.delete(this.finished.keys().next().value as string);
    }
  }
}
