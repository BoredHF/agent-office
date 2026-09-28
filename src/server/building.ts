import { execFile, execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FLOOR_PALETTES, MAX_FLOORS, normalizeRepo, sameRepo } from '../shared/floors.js';
import type { ProjectsDirState, RepoChoice } from '../shared/protocol.js';
import { gh } from './github.js';
import { atomicJson, backupLegacy } from './persistence.js';

/** A floor as floors.json keeps it. */
export interface FloorDef {
  id: string;
  name: string;
  /** owner/name on GitHub. */
  repo?: string;
  dir: string;
  palette: number;
  addedBy: string;
  addedAt: number;
  archivedAt?: number;
}

/** A projects folder picked in ⚙️ Settings (or with --projects), as projects-folder.json keeps it. */
interface PickedDir {
  dir: string;
  by: string;
  at: number;
}

/** How long the list of repositories `gh` can see is reused before it's asked again. */
const REPOS_TTL_MS = 5 * 60_000;
const MAX_REPOS = 1000;
const CLONE_TIMEOUT_MS = 30 * 60_000;

/**
 * The floors of the building, saved in <office>/.agent-office/floors.json: which projects there are,
 * where their checkouts live, and how each floor is painted. New floors are cloned with the office
 * machine's `gh` login into <projects>/<owner>/<repo>; the projects folder can be picked in ⚙️ Settings
 * (kept in projects-folder.json).
 */
export class Building {
  private defs: FloorDef[] = [];
  private file: string;
  private pickedFile: string;
  private picked?: PickedDir;
  /** Floors being cloned, by lower-cased repo. Not saved until the clone is there. */
  private cloning = new Map<string, FloorDef>();
  private repoCache?: { at: number; repos: Promise<RepoChoice[]> };

  constructor(
    /** The office's own data folder; `gh` runs there, since the projects folder may not exist yet. */
    private dataDir: string,
    /** Where new floors are cloned unless another folder was picked. */
    private defaultProjectsDir: string,
  ) {
    this.file = path.join(dataDir, 'floors.json');
    this.pickedFile = path.join(dataDir, 'projects-folder.json');
    this.load();
    this.loadPicked();
  }

  /** Where new floors are cloned. Floors already there stay where they are when it moves. */
  get projectsDir(): string {
    return this.picked?.dir ?? this.defaultProjectsDir;
  }

  projectsDirState(): ProjectsDirState {
    return { dir: tildify(this.projectsDir), custom: !!this.picked, by: this.picked?.by, at: this.picked?.at };
  }

  /** Clones new floors into `raw` from now on ('~' is the home folder; '' goes back to the default). Returns why it can't, if it can't. */
  setProjectsDir(raw: string, by: string): string | undefined {
    const text = raw.trim();
    let dir = this.defaultProjectsDir;
    if (text) {
      const typed = untildify(text);
      if (!path.isAbsolute(typed)) return 'Use a full path, like ~/Workspace';
      dir = path.resolve(typed);
    }
    if (dir !== this.defaultProjectsDir) {
      const why = unwritable(dir);
      if (why) return why;
      // Cloning into a project would nest checkouts inside its git tree.
      const inside = this.defs.find((d) => within(dir, path.resolve(d.dir)));
      if (inside) return `${tildify(dir)} is inside ${inside.name}'s checkout — pick a folder outside every project`;
    }
    this.picked = dir === this.defaultProjectsDir ? undefined : { dir, by, at: Date.now() };
    try {
      writeFileSync(this.pickedFile, JSON.stringify(this.picked ?? {}, null, 2), { mode: 0o600 });
    } catch (err) {
      console.error(`agent-office: couldn't save the projects folder: ${(err as Error).message}`);
    }
    return undefined;
  }

  create(name: string, by: string): FloorDef {
    if (!name.trim()) throw new Error('Give the office a name');
    if (this.defs.length >= MAX_FLOORS) throw new Error('The building is full');
    const def = this.newDef(name.trim().slice(0, 100), undefined, '', by);
    // Independent local offices do not share a checkout or mutable storage root.
    def.dir = path.join(this.dataDir, 'offices', def.id);
    mkdirSync(def.dir, { recursive: true, mode: 0o700 });
    // Establish a git boundary even when the building lives inside an existing checkout.
    execFileSync('git', ['init', '--quiet', def.dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.defs.push(def);
    try { this.save(); } catch (err) { this.defs.pop(); throw err; }
    return def;
  }

  rename(id: string, name: string) {
    const def = this.defs.find((d) => d.id === id);
    if (!def || !name.trim()) throw new Error('Give an existing office a name');
    const old = def.name;
    def.name = name.trim().slice(0, 100);
    try { this.save(); } catch (err) { def.name = old; throw err; }
  }

  archive(id: string, archived: boolean) {
    const def = this.defs.find((d) => d.id === id);
    if (!def) throw new Error('No such office');
    const old = def.archivedAt;
    def.archivedAt = archived ? Date.now() : undefined;
    try { this.save(); } catch (err) { def.archivedAt = old; throw err; }
  }

  list(): FloorDef[] {
    return this.defs;
  }

  /** Floors on their way: shown in the elevator, but nobody can ride there yet. */
  pending(): FloorDef[] {
    return [...this.cloning.values()];
  }

  /**
   * Makes the checkout the office was started in a floor, if it isn't one yet. It's the office's own
   * project: `agent-office <dir>` has always meant that one.
   */
  ensureLocal(dir: string, by: string): FloorDef {
    const abs = path.resolve(dir);
    const known = this.defs.find((d) => path.resolve(d.dir) === abs);
    if (known) return known;
    // Named after its folder, as the office always called it.
    const def = this.newDef(path.basename(abs), originRepo(abs), abs, by);
    this.defs.unshift(def);
    try { this.save(); } catch (err) { this.defs.shift(); throw err; }
    return def;
  }

  /**
   * Clones a repository into the projects folder and adds it as a floor. `started` hears about the
   * floor as soon as the clone begins; resolves to the finished floor, or to why there's none. A
   * checkout that's already where the clone would go is used as it is.
   */
  async add(input: string, by: string, started: (def: FloorDef) => void): Promise<FloorDef | string> {
    const wanted = normalizeRepo(input);
    if (!wanted) return 'Pick a repository, or type it as owner/name';
    if (this.defs.some((d) => sameRepo(d.repo, wanted))) return `${wanted} already has a floor`;
    if (this.cloning.has(wanted.toLowerCase())) return `${wanted} is already being cloned`;
    if (this.defs.length + this.cloning.size >= MAX_FLOORS) return `The building is full (${MAX_FLOORS} floors)`;
    // Asking GitHub first says whether this login can see it at all, and gets the name's real case.
    let repo: string;
    try {
      const view = JSON.parse(await gh(['repo', 'view', wanted, '--json', 'nameWithOwner'], this.dataDir, 30_000)) as { nameWithOwner?: string };
      repo = normalizeRepo(view.nameWithOwner) ?? wanted;
    } catch (err) {
      return `Couldn't find ${wanted} on GitHub: ${(err as Error).message}`;
    }
    const key = repo.toLowerCase();
    if (this.defs.some((d) => sameRepo(d.repo, repo))) return `${repo} already has a floor`;
    if (this.cloning.has(key)) return `${repo} is already being cloned`;
    const [owner, name] = repo.split('/');
    const dest = path.join(this.projectsDir, owner, name);
    if (this.defs.some((d) => path.resolve(d.dir) === dest)) return `${dest} is already a floor`;
    const def = this.newDef(name, repo, dest, by);
    this.cloning.set(key, def);
    started(def);
    try {
      const err = await cloneInto(repo, dest);
      if (err) return err;
    } finally {
      this.cloning.delete(key);
    }
    this.defs.push(def);
    try { this.save(); } catch (err) { this.defs.pop(); throw err; }
    return def;
  }

  /** Repositories the office's `gh` login can clone, most recently pushed first. */
  async repos(refresh = false): Promise<RepoChoice[]> {
    const cached = this.repoCache;
    if (cached && !refresh && Date.now() - cached.at < REPOS_TTL_MS) return cached.repos;
    const repos = listRepos(this.dataDir);
    this.repoCache = { at: Date.now(), repos };
    // A failure is worth asking again next time, not keeping for five minutes.
    repos.catch(() => {
      if (this.repoCache?.repos === repos) this.repoCache = undefined;
    });
    return repos;
  }

  private newDef(name: string, repo: string | undefined, dir: string, by: string): FloorDef {
    const taken = new Set([...this.defs, ...this.cloning.values()].map((d) => d.id));
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'floor';
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    // The first look nobody has, so floors side by side never match; then round again.
    const used = new Set([...this.defs, ...this.cloning.values()].map((d) => d.palette));
    const free = FLOOR_PALETTES.findIndex((_, i) => !used.has(i));
    const palette = free >= 0 ? free : (this.defs.length + this.cloning.size) % FLOOR_PALETTES.length;
    return { id, name, repo, dir, palette, addedBy: by, addedAt: Date.now() };
  }

  private load() {
    if (!existsSync(this.file)) return;
    const raw = JSON.parse(readFileSync(this.file, 'utf8'));
    const legacy = Array.isArray(raw);
    if (!legacy && raw.version !== 1) throw new Error('Unsupported office store version');
    const saved = legacy ? raw : raw.offices;
    if (!Array.isArray(saved)) throw new Error('Invalid office store');
    const ids = new Set<string>();
    const dirs = new Set<string>();
    for (const d of saved) {
      if (!d || typeof d.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(d.id) || ids.has(d.id)
        || typeof d.dir !== 'string' || !path.isAbsolute(d.dir) || dirs.has(existsSync(d.dir) ? realpathSync(d.dir) : path.resolve(d.dir))
        || typeof d.name !== 'string') throw new Error('Invalid or overlapping office storage');
      ids.add(d.id);
      dirs.add(existsSync(d.dir) ? realpathSync(d.dir) : path.resolve(d.dir));
      this.defs.push(d);
    }
    if (legacy) { backupLegacy(this.file); this.save(); }
  }

  private loadPicked() {
    try {
      const saved = JSON.parse(readFileSync(this.pickedFile, 'utf8')) as Partial<PickedDir>;
      if (typeof saved.dir === 'string' && path.isAbsolute(saved.dir)) {
        this.picked = { dir: saved.dir, by: typeof saved.by === 'string' ? saved.by : '?', at: typeof saved.at === 'number' ? saved.at : Date.now() };
      }
    } catch {
      // never picked: the default
    }
  }

  private save() {
    atomicJson(this.file, { version: 1, offices: this.defs });
  }
}

/** A path under the home folder as ~/…, for showing people. */
export function tildify(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

function untildify(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** `dir` is `parent` or somewhere under it. */
function within(dir: string, parent: string): boolean {
  const rel = path.relative(parent, dir);
  return !rel || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Why the office couldn't make checkouts under `dir`, if it couldn't. It's made on the first clone, so it needn't exist yet. */
function unwritable(dir: string): string | undefined {
  let at = dir;
  while (!existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
  try {
    if (!statSync(at).isDirectory()) return `${tildify(at)} isn't a folder`;
    accessSync(at, constants.W_OK);
  } catch {
    return `The office can't write in ${tildify(at)}`;
  }
  return undefined;
}

/** The GitHub repository a checkout's origin points at. */
export function originRepo(dir: string): string | undefined {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
    return /github\.com[/:]/i.test(url) ? normalizeRepo(url) : undefined;
  } catch {
    return undefined;
  }
}

/** Clones `repo` to `dest`, or checks that what's already there is that repository. Resolves to an error, if any. */
async function cloneInto(repo: string, dest: string): Promise<string | undefined> {
  if (existsSync(dest)) {
    if (!statSync(dest).isDirectory()) return `${dest} is already there and isn't a folder`;
    if (readdirSync(dest).length) {
      // Cloned before (a floor that was taken off the list, or by hand): move back in.
      return sameRepo(originRepo(dest), repo) ? undefined : `${dest} already exists and isn't a checkout of ${repo} — move it out of the way first`;
    }
  }
  try {
    mkdirSync(path.dirname(dest), { recursive: true });
  } catch (err) {
    return `Couldn't make ${path.dirname(dest)}: ${(err as Error).message}`;
  }
  return new Promise((resolve) => {
    execFile('gh', ['repo', 'clone', repo, dest], { cwd: path.dirname(dest), timeout: CLONE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, _out, stderr) => {
      if (!err) return resolve(undefined);
      const why = String(stderr || err.message).trim().split('\n').filter(Boolean).slice(-2).join(' ');
      resolve(`Couldn't clone ${repo}: ${why || 'gh failed'}`);
    });
  });
}

async function listRepos(cwd: string): Promise<RepoChoice[]> {
  const out = await gh(
    [
      'api',
      '--paginate',
      'user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member',
      '--jq',
      '.[] | {name: .full_name, description: (.description // ""), private: .private, pushedAt: .pushed_at}',
    ],
    cwd,
    90_000,
  );
  const repos: RepoChoice[] = [];
  const seen = new Set<string>();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { name?: unknown; description?: unknown; private?: unknown; pushedAt?: unknown };
      const name = normalizeRepo(r.name);
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      repos.push({
        name,
        description: typeof r.description === 'string' && r.description ? r.description.slice(0, 200) : undefined,
        private: r.private === true,
        pushedAt: typeof r.pushedAt === 'string' ? r.pushedAt : undefined,
      });
    } catch {
      // not a line of ours
    }
    if (repos.length >= MAX_REPOS) break;
  }
  return repos.sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''));
}
