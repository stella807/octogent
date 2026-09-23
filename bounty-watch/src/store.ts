import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Port: the poller only needs to know which bounty ids it has already reported. */
export interface SeenStore {
  load(): Promise<Set<string>>;
  save(ids: Iterable<string>): Promise<void>;
}

interface SeenFile {
  readonly version: 1;
  readonly ids: string[];
}

/**
 * Without persistence every poll would re-report the whole board as new, so the
 * "is this bounty fresh?" decision depends entirely on this surviving restarts.
 */
export class FileSeenStore implements SeenStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async load(): Promise<Set<string>> {
    try {
      const raw = await readFile(this.#path, "utf8");
      const parsed = JSON.parse(raw) as Partial<SeenFile>;
      return new Set(
        Array.isArray(parsed.ids) ? parsed.ids.filter((id) => typeof id === "string") : [],
      );
    } catch (error) {
      // A missing or corrupt file must not stall the poller; treat it as a cold start.
      if (isMissing(error)) return new Set();
      if (error instanceof SyntaxError) return new Set();
      throw error;
    }
  }

  async save(ids: Iterable<string>): Promise<void> {
    const payload: SeenFile = { version: 1, ids: [...ids].sort() };
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
  );
}

export class MemorySeenStore implements SeenStore {
  #ids: Set<string>;

  constructor(ids: Iterable<string> = []) {
    this.#ids = new Set(ids);
  }

  async load(): Promise<Set<string>> {
    return new Set(this.#ids);
  }

  async save(ids: Iterable<string>): Promise<void> {
    this.#ids = new Set(ids);
  }
}
