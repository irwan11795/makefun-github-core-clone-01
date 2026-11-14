// app.ts — github-core-clone-01 v1 forge.
// A standalone GitHub-compatible git forge in ONE process (Node 22+, stdlib only).
// Serves four interfaces from one in-memory store:
//   (1) git smart HTTP (clone + push, protocol v2 upload-pack + v0 receive-pack),
//   (2) REST v3 API (repos, issues, pull requests, contents),
//   (3) GraphQL (the shapes gh and github-mcp-server send),
//   (4) MCP (JSON-RPC 2.0 Streamable HTTP tools).
// No git binary, no package manager, no outside service, no network at runtime.
// Deterministic: no wall-clock timestamps in state; commit timestamps come from a
// monotonic counter, so identical request sequences produce identical state.
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------------------------

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const STRANGER_LOGIN = 'olgabauer';
export const DEFAULT_BRANCH = 'main';
const SERVER_NAME = 'github-core-clone-01-forge/1.0.0';

// ---------------------------------------------------------------------------------------------
// git objects
// ---------------------------------------------------------------------------------------------

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's raw bytes into entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Build a tree object's raw bytes from entries (sorted git order: dirs sort as name + '/'). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd < 0 ? text : text.slice(0, headEnd);
  const message = headEnd < 0 ? '' : text.slice(headEnd + 2);
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) view.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) view.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) view.author = line.slice(7);
    else if (line.startsWith('committer ')) view.committer = line.slice(10);
  }
  return view;
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd < 0 ? text : text.slice(0, headEnd);
  const message = headEnd < 0 ? '' : text.slice(headEnd + 2);
  const view: TagView = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) view.object = line.slice(7).trim();
    else if (line.startsWith('type ')) view.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) view.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) view.tagger = line.slice(7);
  }
  return view;
}

export function buildTag(fields: { object: string; type: string; tag: string; tagger: string; message: string }): Buffer {
  const lines = [
    `object ${fields.object}`,
    `type ${fields.type}`,
    `tag ${fields.tag}`,
    `tagger ${fields.tagger}`,
  ];
  return Buffer.from(`${lines.join('\n')}\n\n${fields.message}`, 'utf8');
}

/** Build a nested tree from a flat file map (path -> blob oid), creating intermediate trees. */
export function treeFromFiles(repo: Repo, files: Map<string, string>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, oid] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i];
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1], oid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Flatten a commit's tree into a path -> blob oid map. */
export function filesFromTree(repo: Repo, treeOid: string, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') {
      for (const [p, o] of filesFromTree(repo, entry.oid, path)) out.set(p, o);
    } else {
      out.set(path, entry.oid);
    }
  }
  return out;
}

/** Collect every object reachable from a set of oids (commits, trees, blobs, tags). */
export function collectReachable(repo: Repo, roots: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/**
 * Reachable objects from `roots`, not descending past any commit in `boundaries`: a shallow
 * boundary commit contributes itself and its tree/blobs, but not its parents — the client holds
 * the boundary, not the history behind it. Without this, a deepen fetch computes an empty pack:
 * "have third" would wrongly imply "has everything behind third".
 */
export function collectReachableBounded(repo: Repo, roots: readonly string[], boundaries: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      if (!boundaries.has(oid)) {
        for (const p of c.parents) stack.push(p);
      }
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** Is `ancestor` an ancestor of `descendant` (or equal)? Walks commit parents only. */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (p === ancestor) return true;
      stack.push(p);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// pack files
// ---------------------------------------------------------------------------------------------

const PACK_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_IDS: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Apply a git delta (copy/insert instructions) to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error(`delta base size ${baseSize} != ${base.length}`);
  const resultSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const opcode = delta[offset];
    offset += 1;
    if (opcode & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (opcode & (1 << i)) {
          copyOffset |= delta[offset] << (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (opcode & (0x10 << i)) {
          copySize |= delta[offset] << (8 * i);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (opcode !== 0) {
      out.push(delta.subarray(offset, offset + opcode));
      offset += opcode;
      produced += opcode;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize || produced !== resultSize) {
    throw new Error(`delta result size ${result.length} != ${resultSize}`);
  }
  return result;
}

/** Inflate exactly one zlib stream starting at `offset`; return its data and the offset just past it.
 * Node's inflateSync ignores trailing bytes, so the consumed length is found by binary search
 * for the smallest prefix that inflates cleanly (the predicate is monotonic in prefix length). */
export function inflateAt(pack: Buffer, offset: number): { data: Buffer; next: number } {
  const max = pack.length - offset;
  let low = 0; // known-bad (too short)
  let high = max; // known-good (the whole remainder inflates, or throws if corrupt)
  // Confirm the remainder inflates at all; if not, the pack is corrupt and we throw here.
  inflateSync(pack.subarray(offset));
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    try {
      inflateSync(pack.subarray(offset, offset + mid));
      high = mid;
    } catch {
      low = mid;
    }
  }
  return { data: inflateSync(pack.subarray(offset, offset + high)), next: offset + high };
}

/** Read a packfile (v2/v3), resolving OFS_DELTA and REF_DELTA against the pack itself and `base`. */
export function readPack(pack: Buffer, base?: Map<string, GitObject>): Map<string, GitObject> {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let offset = 12;
  const readSizeAndType = (): { type: number; size: number } => {
    const first = pack[offset];
    offset += 1;
    const type = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    while (first & 0x80) {
      const byte = pack[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return { type, size };
  };
  for (let i = 0; i < count; i += 1) {
    const startOffset = offset;
    const { type, size } = readSizeAndType();
    if (type === 6) {
      // OFS_DELTA: negative offset to the base object.
      let byte = pack[offset];
      offset += 1;
      let baseOffset = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset];
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      const baseObjOffset = startOffset - baseOffset;
      const { data: inflated, next } = inflateAt(pack, offset);
      offset = next;
      const baseObj = byOffset.get(baseObjOffset);
      if (!baseObj) throw new Error('ofs-delta base not found');
      const data = applyDelta(baseObj.data, inflated);
      const obj: GitObject = { type: baseObj.type, data };
      const oid = hashObject(obj.type, obj.data);
      objects.set(oid, obj);
      byOffset.set(startOffset, obj);
    } else if (type === 7) {
      // REF_DELTA: base object id.
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const { data: inflated, next } = inflateAt(pack, offset);
      offset = next;
      const baseObj = objects.get(baseOid) ?? base?.get(baseOid);
      if (!baseObj) throw new Error(`ref-delta base ${baseOid} not found`);
      const data = applyDelta(baseObj.data, inflated);
      const obj: GitObject = { type: baseObj.type, data };
      const oid = hashObject(obj.type, obj.data);
      objects.set(oid, obj);
      byOffset.set(startOffset, obj);
    } else {
      const objType = PACK_TYPES[type];
      if (!objType) throw new Error(`unknown pack object type ${type}`);
      const { data: inflated, next } = inflateAt(pack, offset);
      offset = next;
      if (inflated.length !== size) throw new Error(`object size ${inflated.length} != ${size}`);
      const obj: GitObject = { type: objType, data: inflated };
      const oid = hashObject(obj.type, obj.data);
      objects.set(oid, obj);
      byOffset.set(startOffset, obj);
    }
  }
  return objects;
}

/** Write a packfile (v2) of full (non-delta) objects. Deterministic order: sorted by oid. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects].sort((a, b) => {
    const ha = hashObject(a.type, a.data);
    const hb = hashObject(b.type, b.data);
    return ha < hb ? -1 : ha > hb ? 1 : 0;
  });
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  for (const obj of list) {
    const typeId = PACK_TYPE_IDS[obj.type];
    const size = obj.data.length;
    // Type/size varint: first byte holds type (3 bits) + low 4 size bits + continuation.
    const bytes: number[] = [];
    let remaining = size >> 4;
    let first = (typeId << 4) | (size & 0x0f);
    if (remaining > 0) first |= 0x80;
    bytes.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      bytes.push(byte);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(obj.data, { level: 6 }));
  }
  const body = Buffer.concat(parts);
  const checksum = createHash('sha1').update(body).digest();
  return Buffer.concat([body, checksum]);
}

// ---------------------------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const header = Buffer.alloc(4);
  header.write(len.toString(16).padStart(4, '0'), 0, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/** Encode a list of lines / flush / delim into pkt-lines. */
export function encodePktLines(lines: Array<string | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktFlush());
    else if (line === 'delim') parts.push(pktDelim());
    else if (line === 'response-end') parts.push(pktResponseEnd());
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/** Decode a whole buffer of pkt-lines. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line header');
    const lenHex = buf.subarray(offset, offset + 4).toString('ascii');
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len)) throw new Error(`bad pkt-line length ${JSON.stringify(lenHex)}`);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (len === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
    } else {
      if (offset + len > buf.length) throw new Error('truncated pkt-line payload');
      out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
      offset += len;
    }
  }
  return out;
}

/** Wrap data in a sideband band-1 packet (band 2 = progress, band 3 = error). */
export function sideband(band: 1 | 2 | 3, data: Buffer | string): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return pktLine(Buffer.concat([Buffer.from([band]), body]));
}

// ---------------------------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------------------------

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  seq: number; // creation order (deterministic; used for CREATED_AT ordering)
}

export interface Comment {
  id: number;
  body: string;
  seq: number;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  mergeable: boolean;
  files: PullFile[];
  seq: number;
}

export interface Repo {
  databaseId: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>; // refname -> oid
  objects: Map<string, GitObject>;
  issues: Map<number, Issue>;
  nextIssue: number;
  pulls: Map<number, Pull>;
  nextPull: number;
  labels: Map<string, Label>;
  comments: Map<number, Comment[]>;
  nextComment: number;
  nextLabel: number;
  seq: number;
}

export interface Store {
  repos: Map<string, Repo>; // "owner/name" -> Repo
  nextRepoId: number;
  nextIssueId: number;
  nextPullId: number;
  nextCommentId: number;
  nextLabelId: number;
  seq: number; // global monotonic counter for deterministic timestamps / ordering
  token: string; // the bearer token the suite presents (MAKEFUN_SHOP_TOKEN)
}

export function createStore(token: string): Store {
  return {
    repos: new Map(),
    nextRepoId: 1,
    nextIssueId: 1,
    nextPullId: 1,
    nextCommentId: 1,
    nextLabelId: 1,
    seq: 0,
    token,
  };
}

/** Deterministic "now" for commits this forge creates: a fixed epoch plus a monotonic counter. */
export function forgeTimestamp(store: Store): { epoch: number; ident: string } {
  store.seq += 1;
  const epoch = 1_700_000_000 + store.seq;
  const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${epoch} +0000`;
  return { epoch, ident };
}

/** Opaque global id, stable across reads: base64url of "Kind:databaseId:number". */
export function globalId(kind: string, databaseId: number, number?: number): string {
  const raw = number === undefined ? `${kind}:${databaseId}` : `${kind}:${databaseId}:${number}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/** Decode a global id back into its parts (null when not one of ours). */
export function parseGlobalId(id: string): { kind: string; databaseId: number; number?: number } | null {
  try {
    const raw = Buffer.from(id, 'base64url').toString('utf8');
    const parts = raw.split(':');
    if (parts.length < 2) return null;
    const kind = parts[0];
    const databaseId = Number(parts[1]);
    if (!Number.isInteger(databaseId) || databaseId <= 0) return null;
    if (parts.length === 2) return { kind, databaseId };
    const number = Number(parts[2]);
    if (!Number.isInteger(number) || number <= 0) return null;
    return { kind, databaseId, number };
  } catch {
    return null;
  }
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function getRepo(store: Store, owner: string, name: string): Repo | undefined {
  return store.repos.get(repoKey(owner, name));
}

export function createRepoRecord(store: Store, name: string, isPrivate: boolean, description: string): Repo {
  const databaseId = store.nextRepoId;
  store.nextRepoId += 1;
  const repo: Repo = {
    databaseId,
    name,
    owner: VIEWER_LOGIN,
    private: isPrivate,
    description,
    defaultBranch: DEFAULT_BRANCH,
    refs: new Map(),
    objects: new Map(),
    issues: new Map(),
    nextIssue: 1,
    pulls: new Map(),
    nextPull: 1,
    labels: new Map(),
    comments: new Map(),
    nextComment: 1,
    nextLabel: 1,
    seq: 0,
  };
  store.repos.set(repoKey(VIEWER_LOGIN, name), repo);
  return repo;
}

/** The REST shape of a repository (id + databaseId match the GraphQL node). */
export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: globalId('Repository', repo.databaseId),
    databaseId: repo.databaseId,
    node_id: globalId('Repository', repo.databaseId),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_pull_requests: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: globalId('Label', label.id),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.databaseId, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function commentJson(repo: Repo, issueNumber: number, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', repo.databaseId, comment.id),
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issueNumber}/comments/${comment.id}`,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', repo.databaseId, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? isMergeable(repo, pull) : pull.mergeable,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** The most recent common ancestor of two commits (first common commit walking back from both). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsA = new Map<string, number>();
  const queueA: Array<{ oid: string; depth: number }> = [{ oid: a, depth: 0 }];
  while (queueA.length) {
    const { oid, depth } = queueA.shift()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.set(oid, depth);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queueA.push({ oid: p, depth: depth + 1 });
  }
  let best: string | null = null;
  let bestDepth = Number.POSITIVE_INFINITY;
  const queueB: Array<{ oid: string; depth: number }> = [{ oid: b, depth: 0 }];
  const seenB = new Set<string>();
  while (queueB.length) {
    const { oid, depth } = queueB.shift()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsA.has(oid) && depth < bestDepth) {
      best = oid;
      bestDepth = depth;
    }
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queueB.push({ oid: p, depth: depth + 1 });
  }
  return best;
}

/** Three-way merge of `pull`'s head onto its base. Returns null on conflict. */
export function threeWayMerge(repo: Repo, pull: Pull): Map<string, string> | null {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!baseTip) return null;
  const base = mergeBase(repo, pull.headSha, baseTip) ?? pull.baseSha;
  const baseFiles = filesAtCommit(repo, base);
  const headFiles = filesAtCommit(repo, pull.headSha);
  const currentFiles = filesAtCommit(repo, baseTip);
  const merged = new Map<string, string>();
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...currentFiles.keys()]);
  for (const path of paths) {
    const baseV = baseFiles.get(path);
    const headV = headFiles.get(path);
    const curV = currentFiles.get(path);
    if (headV === baseV) {
      if (curV !== undefined) merged.set(path, curV);
    } else if (curV === baseV) {
      if (headV !== undefined) merged.set(path, headV);
    } else if (headV === curV) {
      if (headV !== undefined) merged.set(path, headV);
    } else {
      return null; // both changed it differently: conflict
    }
  }
  return merged;
}

function filesAtCommit(repo: Repo, commitOid: string): Map<string, string> {
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.type !== 'commit') return new Map();
  return filesFromTree(repo, parseCommit(commit.data).tree);
}

export function isMergeable(repo: Repo, pull: Pull): boolean {
  return threeWayMerge(repo, pull) !== null;
}

/** Compute the changed files between two trees (for pull.files). */
export function diffFiles(repo: Repo, baseTreeOid: string, headTreeOid: string): PullFile[] {
  const base = filesFromTree(repo, baseTreeOid);
  const head = filesFromTree(repo, headTreeOid);
  const files: PullFile[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b === h) continue;
    if (b === undefined) {
      files.push({ filename: path, status: 'added', additions: 1, deletions: 0, changes: 1 });
    } else if (h === undefined) {
      files.push({ filename: path, status: 'removed', additions: 0, deletions: 1, changes: 1 });
    } else {
      files.push({ filename: path, status: 'modified', additions: 1, deletions: 1, changes: 2 });
    }
  }
  return files;
}

/** Create a commit on a branch from a file map (used by PUT /contents and merges). */
export function commitFiles(
  store: Store,
  repo: Repo,
  branch: string,
  files: Map<string, string>,
  message: string,
): string {
  const treeOid = treeFromFiles(repo, files);
  const parentOid = repo.refs.get(`refs/heads/${branch}`);
  const parents = parentOid ? [parentOid] : [];
  const { ident } = forgeTimestamp(store);
  const commitOid = putObject(
    repo,
    'commit',
    buildCommit({ tree: treeOid, parents, author: ident, committer: ident, message }),
  );
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return commitOid;
}

/** The file map at the tip of a branch (empty when the branch is unborn). */
export function filesAtBranch(repo: Repo, branch: string): Map<string, string> {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip) return new Map();
  const commit = repo.objects.get(tip);
  if (!commit || commit.type !== 'commit') return new Map();
  return filesFromTree(repo, parseCommit(commit.data).tree);
}

// ---------------------------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------------------------

let requestCounter = 0;

export interface Ctx {
  store: Store;
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  url: URL;
  pathname: string;
  query: URLSearchParams;
  body: Buffer;
  token: string | null;
}

function sendJson(ctx: Ctx, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  requestCounter += 1;
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': `req-${requestCounter.toString(16).padStart(8, '0')}`,
    ...extraHeaders,
  };
  ctx.res.writeHead(status, headers);
  ctx.res.end(body);
}

function sendRaw(ctx: Ctx, status: number, contentType: string, body: Buffer): void {
  requestCounter += 1;
  ctx.res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': `req-${requestCounter.toString(16).padStart(8, '0')}`,
  });
  ctx.res.end(body);
}

function sendError(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

/** The bearer token on this request, or null when absent/malformed. */
function bearerToken(ctx: Ctx): string | null {
  const auth = ctx.req.headers.authorization;
  if (!auth) return null;
  const match = /^Bearer\s+(.+)$/.exec(auth);
  return match ? match[1] : null;
}

/** Require a token for the REST/GraphQL/MCP surfaces (any non-empty token is the viewer). */
function requireAuth(ctx: Ctx): boolean {
  const token = bearerToken(ctx);
  if (!token) {
    sendError(ctx, 401, 'Requires authentication');
    return false;
  }
  ctx.token = token;
  return true;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body; on failure, answer 400 and return null. */
function parseJsonBody(ctx: Ctx): Record<string, unknown> | unknown[] | null {
  if (ctx.body.length === 0) return {};
  try {
    return JSON.parse(ctx.body.toString('utf8')) as Record<string, unknown> | unknown[];
  } catch {
    sendError(ctx, 400, 'Problems parsing JSON');
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function intParam(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ---------------------------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------------------------

function gitRepoPath(ctx: Ctx): { owner: string; name: string } | null {
  // /{owner}/{repo}.git/...
  const match = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(ctx.pathname);
  if (!match) return null;
  return { owner: decodeSegment(match[1]), name: decodeSegment(match[2]) };
}

/** Ref lines for an advertisement (v0), first line carries capabilities after NUL. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-receive-pack'
    ? `report-status side-band-64k delete-refs ofs-delta agent=${SERVER_NAME}`
    : `symref=HEAD:${DEFAULT_BRANCH} side-band-64k agent=${SERVER_NAME} object-format=sha1 thin-pack ofs-delta`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const [name, oid] of refs) {
      parts.push(pktLine(`${oid} ${name}\n`));
      const peeled = peelTag(repo, oid);
      if (peeled) parts.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Refs sorted by name (deterministic order). */
function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** If `oid` is an annotated tag object, return the commit it points at. */
function peelTag(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  return parseTag(obj.data).object;
}

function v2Advertisement(): Buffer {
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    pktFlush(),
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${SERVER_NAME}\n`),
    pktFlush(),
  ];
  return Buffer.concat(parts);
}

function handleInfoRefs(ctx: Ctx): void {
  const path = gitRepoPath(ctx);
  if (!path) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const service = ctx.query.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const repo = getRepo(ctx.store, path.owner, path.name);
  if (!repo) {
    ctx.res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    ctx.res.end('Not Found');
    return;
  }
  const wantsV2 = service === 'git-upload-pack' && ctx.req.headers['git-protocol'] === 'version=2';
  if (wantsV2) {
    sendRaw(ctx, 200, 'application/x-git-upload-pack-advertisement', v2Advertisement());
    return;
  }
  sendRaw(ctx, 200, `application/x-${service}-advertisement`, v0Advertisement(repo, service));
}

/** The ref lines for a v2 ls-refs answer. */
function lsRefsLines(
  repo: Repo,
  opts: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] },
): string[] {
  const lines: string[] = [];
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const headBorn = headOid !== undefined && headOid !== ZERO_OID;
  const wantHead = opts.prefixes.length === 0 || opts.prefixes.some((p) => 'HEAD'.startsWith(p));
  if (wantHead && opts.symrefs) {
    if (headBorn) {
      lines.push(`${headOid} HEAD symref-target:refs/heads/${repo.defaultBranch}`);
    } else if (opts.unborn) {
      lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}`);
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (opts.prefixes.length > 0 && !opts.prefixes.some((p) => name.startsWith(p))) continue;
    let line = `${oid} ${name}`;
    if (opts.peel) {
      const peeled = peelTag(repo, oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  return lines;
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  thinPack: boolean;
}

/** Depth-limited reachable object set: commits within `depth` generations of `wants`
 * (depth 1 = the wants themselves), plus their trees/blobs. Returns the object set and the
 * shallow boundary commits (generation == depth). */
function depthLimitedReachable(
  repo: Repo,
  wants: readonly string[],
  depth: number | null,
): { objects: Set<string>; shallow: string[] } {
  const objects = new Set<string>();
  const shallow: string[] = [];
  // BFS over commits by generation.
  const queue: Array<{ oid: string; generation: number }> = wants.map((oid) => ({ oid, generation: 1 }));
  const seenCommit = new Set<string>();
  while (queue.length) {
    const { oid, generation } = queue.shift()!;
    if (seenCommit.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      seenCommit.add(oid);
      // The commit itself and its tree/blobs are always included (up to the depth limit).
      if (depth !== null && generation > depth) continue;
      objects.add(oid);
      const commit = parseCommit(obj.data);
      const treeObjects = collectReachable(repo, [commit.tree]);
      for (const o of treeObjects) objects.add(o);
      if (depth !== null && generation === depth) {
        shallow.push(oid);
        continue; // do not descend past the boundary
      }
      for (const parent of commit.parents) queue.push({ oid: parent, generation: generation + 1 });
    } else {
      // A want that is not a commit (e.g. a tag): include it and everything it points at.
      for (const o of collectReachable(repo, [oid])) objects.add(o);
    }
  }
  return { objects, shallow };
}

function handleUploadPack(ctx: Ctx): void {
  const path = gitRepoPath(ctx);
  if (!path) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const repo = getRepo(ctx.store, path.owner, path.name);
  if (!repo) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const isV2 = ctx.req.headers['git-protocol'] === 'version=2';
  let packets: Pkt[];
  try {
    packets = decodePktLines(ctx.body);
  } catch (err) {
    sendError(ctx, 400, `bad pkt-line stream: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  if (isV2) {
    handleUploadPackV2(ctx, repo, lines);
  } else {
    handleUploadPackV0(ctx, repo, lines);
  }
}

function handleUploadPackV2(ctx: Ctx, repo: Repo, lines: string[]): void {
  const commandLine = lines[0] ?? '';
  if (commandLine.startsWith('command=ls-refs')) {
    const opts = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
    for (const line of lines.slice(1)) {
      const text = line.replace(/\n$/, '');
      if (text === 'peel') opts.peel = true;
      else if (text === 'symrefs') opts.symrefs = true;
      else if (text === 'unborn') opts.unborn = true;
      else if (text.startsWith('ref-prefix ')) opts.prefixes.push(text.slice('ref-prefix '.length));
    }
    const out: Buffer[] = [];
    for (const line of lsRefsLines(repo, opts)) out.push(pktLine(`${line}\n`));
    out.push(pktFlush());
    sendRaw(ctx, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
    return;
  }
  if (!commandLine.startsWith('command=fetch')) {
    sendError(ctx, 400, `unknown v2 command ${JSON.stringify(commandLine)}`);
    return;
  }
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, thinPack: true };
  for (const line of lines.slice(1)) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) req.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) req.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) req.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) req.depth = Number.parseInt(text.slice(7), 10);
    else if (text === 'thin-pack') req.thinPack = true;
  }
  // Compute what to send.
  const { objects: reachable, shallow: newShallow } = depthLimitedReachable(repo, req.wants, req.depth);
  // What the client already holds: its haves, but never past a shallow boundary it named.
  const haveReachable = collectReachableBounded(repo, req.haves, new Set(req.shallow));
  const toSend = new Set<string>();
  for (const oid of reachable) {
    if (!haveReachable.has(oid)) toSend.add(oid);
  }
  // Acknowledgments: ACK any have that is an ancestor-or-equal of a want; else NAK.
  const acks: string[] = [];
  for (const have of req.haves) {
    if (req.wants.some((want) => isAncestor(repo, have, want))) acks.push(have);
  }
  const out: Buffer[] = [];
  out.push(pktLine('acknowledgments\n'));
  if (acks.length) {
    for (const ack of acks) out.push(pktLine(`ACK ${ack}\n`));
    out.push(pktLine('ready\n'));
  } else {
    out.push(pktLine('NAK\n'));
  }
  out.push(pktDelim());
  // Shallow-info: new boundaries, plus old boundaries that are now fully included
  // (an old boundary is unshallowed when it sits inside the new reachable set, is not
  // itself a new boundary, and at least one of its parents is now included).
  const unshallow = req.shallow.filter((oid) => {
    if (newShallow.includes(oid)) return false;
    if (!reachable.has(oid)) return false;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') return false;
    return parseCommit(obj.data).parents.some((p) => reachable.has(p));
  });
  const shallowToReport = newShallow.filter((oid) => toSend.has(oid) || req.depth !== null);
  if (shallowToReport.length || unshallow.length) {
    out.push(pktLine('shallow-info\n'));
    for (const oid of shallowToReport) out.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) out.push(pktLine(`unshallow ${oid}\n`));
    out.push(pktDelim());
  }
  // Packfile section.
  out.push(pktLine('packfile\n'));
  const packObjects: GitObject[] = [];
  for (const oid of toSend) {
    const obj = repo.objects.get(oid);
    if (obj) packObjects.push(obj);
  }
  const pack = writePack(packObjects);
  // Chunk the pack into sideband band-1 packets (max 65515 pack bytes each).
  const CHUNK = 65515;
  for (let i = 0; i < pack.length; i += CHUNK) {
    out.push(sideband(1, pack.subarray(i, Math.min(i + CHUNK, pack.length))));
  }
  out.push(pktFlush());
  sendRaw(ctx, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
}

function handleUploadPackV0(ctx: Ctx, repo: Repo, lines: string[]): void {
  // v0 fetch: want/have/done/deepen lines, no command prefix.
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, thinPack: true };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) req.wants.push(text.slice(5).trim().split(' ')[0]);
    else if (text.startsWith('have ')) req.haves.push(text.slice(5).trim());
    else if (text.startsWith('deepen ')) req.depth = Number.parseInt(text.slice(7), 10);
    else if (text === 'done') break;
  }
  const { objects: reachable } = depthLimitedReachable(repo, req.wants, req.depth);
  // v0 has no shallow lines: with a deepen request the haves themselves are the shallow
  // boundary (their parents are not held); without one they are ordinary full haves.
  const haveReachable = collectReachableBounded(repo, req.haves, req.depth !== null ? new Set(req.haves) : new Set());
  const packObjects: GitObject[] = [];
  for (const oid of reachable) {
    if (!haveReachable.has(oid)) {
      const obj = repo.objects.get(oid);
      if (obj) packObjects.push(obj);
    }
  }
  const pack = writePack(packObjects);
  const out: Buffer[] = [pktLine('NAK\n')];
  const CHUNK = 65515;
  for (let i = 0; i < pack.length; i += CHUNK) {
    out.push(sideband(1, pack.subarray(i, Math.min(i + CHUNK, pack.length))));
  }
  out.push(pktFlush());
  sendRaw(ctx, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(ctx: Ctx): void {
  const path = gitRepoPath(ctx);
  if (!path) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const repo = getRepo(ctx.store, path.owner, path.name);
  if (!repo) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  // Split the body into the pkt-line command list and the trailing pack.
  let offset = 0;
  const commands: PushCommand[] = [];
  let packStart = ctx.body.length;
  try {
    while (offset < ctx.body.length) {
      const lenHex = ctx.body.subarray(offset, offset + 4).toString('ascii');
      const len = parseInt(lenHex, 16);
      if (Number.isNaN(len)) throw new Error('bad pkt-line length in push');
      if (len === 0) {
        packStart = offset + 4;
        break;
      }
      const payload = ctx.body.subarray(offset + 4, offset + len).toString('utf8');
      const nul = payload.indexOf('\0');
      const line = (nul >= 0 ? payload.slice(0, nul) : payload).replace(/\n$/, '');
      const parts = line.split(' ');
      if (parts.length >= 3) {
        commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
      }
      offset += len;
    }
  } catch (err) {
    sendError(ctx, 400, `bad push stream: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const updatesRef = commands.some((c) => c.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (updatesRef || packStart < ctx.body.length) {
    const pack = ctx.body.subarray(packStart);
    if (pack.length > 0) {
      try {
        const objects = readPack(pack, repo.objects);
        for (const [oid, obj] of objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : String(err);
      }
    }
  }
  // Validate and apply each ref update (only when the unpack succeeded).
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const cmd of commands) {
    if (!unpackOk) {
      results.push({ ref: cmd.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'ref does not exist' });
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        results.push({ ref: cmd.ref, ok: false, reason: 'old value does not match' });
      } else {
        repo.refs.delete(cmd.ref);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!repo.objects.has(cmd.newOid)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'ref already exists' });
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Update: old must match, and new must be a fast-forward of old.
    if (current === undefined) {
      results.push({ ref: cmd.ref, ok: false, reason: 'ref does not exist' });
    } else if (cmd.oldOid !== current) {
      results.push({ ref: cmd.ref, ok: false, reason: 'old value does not match' });
    } else if (cmd.newOid === cmd.oldOid) {
      results.push({ ref: cmd.ref, ok: true, reason: '' });
    } else if (!isAncestor(repo, cmd.oldOid, cmd.newOid)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
    } else {
      repo.refs.set(cmd.ref, cmd.newOid);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
    }
  }
  // Report-status inside sideband band 1 (each report line its own sideband packet).
  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const r of results) {
    reportLines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  }
  const out: Buffer[] = [];
  for (const line of reportLines) out.push(sideband(1, pktLine(line)));
  out.push(sideband(1, pktFlush()));
  out.push(pktFlush());
  sendRaw(ctx, 200, 'application/x-git-receive-pack-result', Buffer.concat(out));
}

// ---------------------------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------------------------

function linkHeader(base: string, page: number, perPage: number, total: number): string | null {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (page >= totalPages) return null;
  const nextUrl = `${base}?per_page=${perPage}&page=${page + 1}`;
  const lastUrl = `${base}?per_page=${perPage}&page=${totalPages}`;
  return `<${nextUrl}>; rel="next", <${lastUrl}>; rel="last"`;
}

function paginate<T>(ctx: Ctx, items: T[]): { page: T[]; link: string | null } {
  const perPage = Math.min(100, Math.max(1, intParam(ctx.query.get('per_page'), 30)));
  const page = Math.max(1, intParam(ctx.query.get('page'), 1));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const base = `${ctx.url.origin}${ctx.url.pathname}`;
  const link = linkHeader(base, page, perPage, items.length);
  return { page: slice, link };
}

function repoOr404(ctx: Ctx, owner: string, name: string): Repo | null {
  const repo = getRepo(ctx.store, owner, name);
  if (!repo) {
    sendError(ctx, 404, 'Not Found');
    return null;
  }
  return repo;
}

function handleRestRoot(ctx: Ctx): void {
  sendJson(ctx, 200, {
    current_user_url: '/api/v3/user',
    repository_url: '/api/v3/repos/{owner}/{repo}',
    user_url: '/api/v3/users/{username}',
    meta: { installed_version: '1.0.0' },
  }, { 'x-oauth-scopes': 'repo, read:user' });
}

function handleRestMeta(ctx: Ctx): void {
  sendJson(ctx, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
}

function handleRestUser(ctx: Ctx): void {
  sendJson(ctx, 200, {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: globalId('User', VIEWER_ID),
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    type: 'User',
    html_url: `https://example.invalid/${VIEWER_LOGIN}`,
    url: '/api/v3/user',
  });
}

function handleListUserRepos(ctx: Ctx): void {
  const repos = [...ctx.store.repos.values()]
    .filter((r) => r.owner === VIEWER_LOGIN)
    .sort((a, b) => a.databaseId - b.databaseId);
  const { page, link } = paginate(ctx, repos.map(repoJson));
  const extra = link ? { link } : {};
  sendJson(ctx, 200, page, extra);
}

function handleCreateUserRepo(ctx: Ctx): void {
  const body = parseJsonBody(ctx);
  if (body === null || !isRecord(body)) return;
  const name = str(body.name);
  if (!name) {
    sendError(ctx, 422, 'name is required');
    return;
  }
  if (getRepo(ctx.store, VIEWER_LOGIN, name)) {
    sendError(ctx, 422, 'Repository creation failed. name already exists on this account.');
    return;
  }
  const repo = createRepoRecord(ctx.store, name, body.private === true, str(body.description));
  sendJson(ctx, 201, repoJson(repo));
}

function handleGetRepo(ctx: Ctx, owner: string, name: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (!repo) return;
  sendJson(ctx, 200, repoJson(repo));
}

function handlePatchRepo(ctx: Ctx, owner: string, name: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (!repo) return;
  const body = parseJsonBody(ctx);
  if (body === null || !isRecord(body)) return;
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.default_branch === 'string' && body.default_branch) repo.defaultBranch = body.default_branch;
  sendJson(ctx, 200, repoJson(repo));
}

function handleDeleteRepo(ctx: Ctx, owner: string, name: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (!repo) return;
  ctx.store.repos.delete(repoKey(owner, name));
  ctx.res.writeHead(204, { 'x-github-request-id': `req-${(++requestCounter).toString(16).padStart(8, '0')}` });
  ctx.res.end();
}

function handleListBranches(ctx: Ctx, owner: string, name: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (!repo) return;
  const branches = sortedRefs(repo)
    .filter(([ref]) => ref.startsWith('refs/heads/'))
    .map(([ref, oid]) => ({
      name: ref.slice('refs/heads/'.length),
      commit: { sha: oid, url: `/api/v3/repos/${owner}/${name}/commits/${oid}` },
      protected: false,
    }));
  sendJson(ctx, 200, branches);
}

function handleGetBranch(ctx: Ctx, owner: string, name: string, branch: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (!repo) return;
  const oid = repo.refs.get(`refs/heads/${branch}`);
  if (!oid) {
    sendError(ctx, 404, 'Branch not found');
    return;
  }
  sendJson(ctx, 200, {
    name: branch,
    commit: { sha: oid, url: `/api/v3/repos/${owner}/${name}/commits/${oid}` },
    protected: false,
  });
}

function listCommits(repo: Repo, branchOrSha: string | undefined): Array<Record<string, unknown>> {
  const tip = branchOrSha ? repo.refs.get(`refs/heads/${branchOrSha}`) ?? branchOrSha : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (!tip) return [];
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    out.push({
      sha: oid,
      commit: { message: commit.message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL } },
      parents: commit.parents.map((p) => ({ sha: p })),
    });
    for (const parent of commit.parents) stack.push(parent);
  }
  return out;
}

function handleListCommits(ctx: Ctx, owner: string, name: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (!repo) return;
  const sha = ctx.query.get('sha') ?? undefined;
  sendJson(ctx, 200, listCommits(repo, sha));
}

function handleCreateRef(ctx: Ctx, owner: string, name: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (!repo) return;
  const body = parseJsonBody(ctx);
  if (body === null || !isRecord(body)) return;
  const ref = str(body.ref);
  const sha = str(body.sha);
  if (!ref || !sha) {
    sendError(ctx, 422, 'ref and sha are required');
    return;
  }
  if (repo.refs.has(ref)) {
    sendError(ctx, 422, 'Reference already exists');
    return;
  }
  if (!repo.objects.has(sha)) {
    sendError(ctx, 422, 'Object does not exist');
    return;
  }
  repo.refs.set(ref, sha);
  sendJson(ctx, 201, { ref, object: { sha, type: 'commit' }, url: `/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}` });
}

function handleGetRef(ctx: Ctx, owner: string, name: string, refPath: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (!repo) return;
  const ref = `refs/${refPath}`;
  const oid = repo.refs.get(ref);
  if (!oid) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  sendJson(ctx, 200, { ref, object: { sha: oid, type: 'commit' }, url: `/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}` });
}

function handleListRefs(ctx: Ctx, owner: string, name: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (!repo) return;
  const refs = sortedRefs(repo).map(([ref, oid]) => ({
    ref,
    object: { sha: oid, type: 'commit' },
    url: `/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}`,
  }));
  sendJson(ctx, 200, refs);
}

function handleGetContents(ctx: Ctx, owner: string, name: string, path: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (!repo) return;
  const ref = ctx.query.get('ref') ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (!tip) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const commit = repo.objects.get(tip);
  if (!commit || commit.type !== 'commit') {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const files = filesFromTree(repo, parseCommit(commit.data).tree);
  const blobOid = files.get(path);
  if (blobOid) {
    const blob = repo.objects.get(blobOid);
    if (!blob) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    sendJson(ctx, 200, {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name: path.split('/').pop(),
      path,
      content: blob.data.toString('base64'),
      sha: blobOid,
      url: `/api/v3/repos/${owner}/${name}/contents/${path}`,
      html_url: `https://example.invalid/${owner}/${name}/blob/${ref}/${path}`,
    });
    return;
  }
  // Directory listing: entries directly under `path` (or the root when path is empty).
  const prefix = path === '' ? '' : `${path}/`;
  const children = new Map<string, { type: string; oid: string; size: number }>();
  for (const [filePath, oid] of files) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      const blob = repo.objects.get(oid);
      children.set(rest, { type: 'file', oid, size: blob ? blob.data.length : 0 });
    } else {
      children.set(rest.slice(0, slash), { type: 'dir', oid: '', size: 0 });
    }
  }
  if (children.size === 0) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const entries = [...children.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([childName, child]) => ({
      type: child.type,
      size: child.size,
      name: childName,
      path: prefix + childName,
      sha: child.oid,
      url: `/api/v3/repos/${owner}/${name}/contents/${prefix}${childName}`,
      html_url: `https://example.invalid/${owner}/${name}/tree/${ref}/${prefix}${childName}`,
    }));
  sendJson(ctx, 200, entries);
}

function handlePutContents(ctx: Ctx, owner: string, name: string, path: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (!repo) return;
  const body = parseJsonBody(ctx);
  if (body === null || !isRecord(body)) return;
  const message = str(body.message, 'Update file');
  const contentB64 = str(body.content);
  if (!contentB64) {
    sendError(ctx, 422, 'content is required');
    return;
  }
  let content: Buffer;
  try {
    content = Buffer.from(contentB64, 'base64');
  } catch {
    sendError(ctx, 422, 'content is not valid base64');
    return;
  }
  const branch = str(body.branch, repo.defaultBranch) || repo.defaultBranch;
  const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
  const files = filesAtBranch(repo, branch);
  const existingOid = files.get(path);
  if (givenSha !== undefined) {
    if (existingOid === undefined || existingOid !== givenSha) {
      sendError(ctx, 409, 'sha does not match the current file');
      return;
    }
  }
  const isUpdate = existingOid !== undefined;
  const blobOid = putObject(repo, 'blob', content);
  files.set(path, blobOid);
  const commitOid = commitFiles(ctx.store, repo, branch, files, message);
  sendJson(ctx, isUpdate ? 200 : 201, {
    content: { name: path.split('/').pop(), path, sha: blobOid, size: content.length, encoding: 'base64', type: 'file' },
    commit: { sha: commitOid, message },
  });
}

function handleDeleteContents(ctx: Ctx, owner: string, name: string, path: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (!repo) return;
  const body = parseJsonBody(ctx);
  if (body === null || !isRecord(body)) return;
  const message = str(body.message, 'Delete file');
  const branch = str(body.branch, repo.defaultBranch) || repo.defaultBranch;
  const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
  const files = filesAtBranch(repo, branch);
  const existingOid = files.get(path);
  if (existingOid === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  if (givenSha !== undefined && givenSha !== existingOid) {
    sendError(ctx, 409, 'sha does not match the current file');
    return;
  }
  files.delete(path);
  const commitOid = commitFiles(ctx.store, repo, branch, files, message);
  sendJson(ctx, 200, { commit: { sha: commitOid, message } });
}

function handleCreateLabel(ctx: Ctx, owner: string, name: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (!repo) return;
  const body = parseJsonBody(ctx);
  if (body === null || !isRecord(body)) return;
  const labelName = str(body.name);
  if (!labelName) {
    sendError(ctx, 422, 'name is required');
    return;
  }
  const existing = repo.labels.get(labelName);
  if (existing) {
    sendJson(ctx, 200, labelJson(existing));
    return;
  }
  const label: Label = {
    id: ctx.store.nextLabelId,
    name: labelName,
    color: str(body.color, 'ededed'),
    description: str(body.description),
  };
  ctx.store.nextLabelId += 1;
  repo.labels.set(labelName, label);
  sendJson(ctx, 201, labelJson(label));
}

function handleListLabels(ctx: Ctx, owner: string, name: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (!repo) return;
  sendJson(ctx, 200, [...repo.labels.values()].map(labelJson));
}

function handleCreateIssue(ctx: Ctx, owner: string, name: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (!repo) return;
  const body = parseJsonBody(ctx);
  if (body === null || !isRecord(body)) return;
  const title = str(body.title);
  if (!title) {
    sendError(ctx, 422, 'title is required');
    return;
  }
  const labelNames = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
  const labels: Label[] = [];
  for (const labelName of labelNames) {
    const label = repo.labels.get(labelName);
    if (!label) {
      sendError(ctx, 422, `Label does not exist: ${labelName}`);
      return;
    }
    labels.push(label);
  }
  const number = repo.nextIssue;
  repo.nextIssue += 1;
  const issue: Issue = {
    id: ctx.store.nextIssueId,
    number,
    title,
    body: str(body.body),
    state: 'open',
    labels,
    seq: ++ctx.store.seq,
  };
  ctx.store.nextIssueId += 1;
  repo.issues.set(number, issue);
  sendJson(ctx, 201, issueJson(repo, issue));
}

function listIssuesSorted(repo: Repo, ctx: Ctx): Issue[] {
  const state = ctx.query.get('state') ?? 'open';
  const sort = ctx.query.get('sort') ?? 'created';
  const direction = ctx.query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state !== 'all') issues = issues.filter((i) => i.state === state);
  if (sort === 'created') {
    issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  } else {
    issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  }
  return issues;
}

function handleListIssues(ctx: Ctx, owner: string, name: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (!repo) return;
  const { page, link } = paginate(ctx, listIssuesSorted(repo, ctx).map((i) => issueJson(repo, i)));
  sendJson(ctx, 200, page, link ? { link } : {});
}

function handleGetIssue(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = repoOr404(ctx, owner, name);
  if (!repo) return;
  const issue = repo.issues.get(number);
  if (!issue) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  sendJson(ctx, 200, issueJson(repo, issue));
}

function handlePatchIssue(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = repoOr404(ctx, owner, name);
  if (!repo) return;
  const issue = repo.issues.get(number);
  if (!issue) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const body = parseJsonBody(ctx);
  if (body === null || !isRecord(body)) return;
  if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  sendJson(ctx, 200, issueJson(repo, issue));
}

function handleCreateComment(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = repoOr404(ctx, owner, name);
  if (!repo) return;
  const issue = repo.issues.get(number);
  if (!issue) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const body = parseJsonBody(ctx);
  if (body === null || !isRecord(body)) return;
  const text = str(body.body);
  if (!text) {
    sendError(ctx, 422, 'body is required');
    return;
  }
  const comment: Comment = { id: ctx.store.nextCommentId, body: text, seq: ++ctx.store.seq };
  ctx.store.nextCommentId += 1;
  const list = repo.comments.get(number) ?? [];
  list.push(comment);
  repo.comments.set(number, list);
  sendJson(ctx, 201, commentJson(repo, number, comment));
}

function handleListComments(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = repoOr404(ctx, owner, name);
  if (!repo) return;
  const issue = repo.issues.get(number);
  if (!issue) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const comments = repo.comments.get(number) ?? [];
  sendJson(ctx, 200, comments.map((c) => commentJson(repo, number, c)));
}

function handleCreatePull(ctx: Ctx, owner: string, name: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (!repo) return;
  const body = parseJsonBody(ctx);
  if (body === null || !isRecord(body)) return;
  const headRef = str(body.head);
  const baseRef = str(body.base);
  const title = str(body.title);
  if (!headRef || !baseRef || !title) {
    sendError(ctx, 422, 'head, base and title are required');
    return;
  }
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (!headSha) {
    sendError(ctx, 422, `head branch ${headRef} does not exist`);
    return;
  }
  if (!baseSha) {
    sendError(ctx, 422, `base branch ${baseRef} does not exist`);
    return;
  }
  const headCommit = repo.objects.get(headSha);
  const baseCommit = repo.objects.get(baseSha);
  const headTree = headCommit && headCommit.type === 'commit' ? parseCommit(headCommit.data).tree : '';
  const baseTree = baseCommit && baseCommit.type === 'commit' ? parseCommit(baseCommit.data).tree : '';
  const number = repo.nextPull;
  repo.nextPull += 1;
  const pull: Pull = {
    id: ctx.store.nextPullId,
    number,
    title,
    body: str(body.body),
    state: 'open',
    headRef,
    headSha,
    baseRef,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    mergeable: true,
    files: diffFiles(repo, baseTree, headTree),
    seq: ++ctx.store.seq,
  };
  ctx.store.nextPullId += 1;
  repo.pulls.set(number, pull);
  sendJson(ctx, 201, pullJson(repo, pull));
}

function handleListPulls(ctx: Ctx, owner: string, name: string): void {
  const repo = repoOr404(ctx, owner, name);
  if (!repo) return;
  const state = ctx.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
  pulls.sort((a, b) => b.seq - a.seq);
  const { page, link } = paginate(ctx, pulls.map((p) => pullJson(repo, p)));
  sendJson(ctx, 200, page, link ? { link } : {});
}

function handleGetPull(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = repoOr404(ctx, owner, name);
  if (!repo) return;
  const pull = repo.pulls.get(number);
  if (!pull) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  sendJson(ctx, 200, pullJson(repo, pull));
}

function handleListPullFiles(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = repoOr404(ctx, owner, name);
  if (!repo) return;
  const pull = repo.pulls.get(number);
  if (!pull) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  sendJson(ctx, 200, pull.files);
}

function handleMergePull(ctx: Ctx, owner: string, name: string, number: number): void {
  const repo = repoOr404(ctx, owner, name);
  if (!repo) return;
  const pull = repo.pulls.get(number);
  if (!pull) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const body = parseJsonBody(ctx);
  if (body === null) return;
  if (pull.state === 'closed') {
    sendError(ctx, 405, 'Pull request is already closed');
    return;
  }
  // Squash merge via a three-way merge of the head onto the base branch.
  const mergedFiles = threeWayMerge(repo, pull);
  if (mergedFiles === null) {
    sendError(ctx, 405, 'Merge conflict');
    return;
  }
  const mergeMethod = isRecord(body) ? str(body.merge_method, 'squash') : 'squash';
  void mergeMethod;
  const commitOid = commitFiles(ctx.store, repo, pull.baseRef, mergedFiles, `${pull.title} (#${pull.number})`);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = '2026-01-01T00:00:00Z';
  pull.mergeCommitSha = commitOid;
  // The base ref now points at the merge commit.
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  sendJson(ctx, 200, {
    merged: true,
    sha: commitOid,
    message: `Pull request successfully merged`,
  });
}

// ---------------------------------------------------------------------------------------------
// GraphQL (the shapes gh and github-mcp-server send)
// ---------------------------------------------------------------------------------------------

interface GqlSelection {
  alias: string | null;
  name: string;
  args: Record<string, unknown>;
  selections: GqlSelection[] | null;
  inlineType: string | null; // for `... on Type { ... }`
}

interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: GqlSelection[];
}

/** A minimal recursive-descent parser for the GraphQL subset the suite sends. */
class GqlParser {
  private pos = 0;
  private readonly src: string;
  constructor(src: string) {
    this.src = src;
  }

  parse(): GqlOperation[] {
    const ops: GqlOperation[] = [];
    this.skipWs();
    while (this.pos < this.src.length) {
      ops.push(this.parseOperation());
      this.skipWs();
    }
    return ops;
  }

  private skipWs(): void {
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',') {
        this.pos += 1;
      } else if (ch === '#') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1;
      } else break;
    }
  }

  private peek(): string {
    return this.src[this.pos] ?? '';
  }

  private readName(): string {
    this.skipWs();
    const start = this.pos;
    while (this.pos < this.src.length && /[_A-Za-z0-9]/.test(this.src[this.pos])) this.pos += 1;
    return this.src.slice(start, this.pos);
  }

  private expect(ch: string): void {
    this.skipWs();
    if (this.src[this.pos] !== ch) throw new Error(`expected ${JSON.stringify(ch)} at ${this.pos}, got ${JSON.stringify(this.src[this.pos])}`);
    this.pos += 1;
  }

  private parseOperation(): GqlOperation {
    this.skipWs();
    let kind: 'query' | 'mutation' = 'query';
    if (this.src.startsWith('mutation', this.pos)) {
      kind = 'mutation';
      this.pos += 'mutation'.length;
    } else if (this.src.startsWith('query', this.pos)) {
      this.pos += 'query'.length;
    }
    this.skipWs();
    let name: string | null = null;
    if (/[_A-Za-z]/.test(this.peek())) name = this.readName();
    // Variable definitions: ($x: Type!, ...)
    this.skipWs();
    if (this.peek() === '(') {
      let depth = 0;
      while (this.pos < this.src.length) {
        const ch = this.src[this.pos];
        if (ch === '(') depth += 1;
        else if (ch === ')') {
          depth -= 1;
          this.pos += 1;
          if (depth === 0) break;
          continue;
        }
        this.pos += 1;
      }
    }
    const selections = this.parseSelectionSet();
    return { kind, name, selections };
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const selections: GqlSelection[] = [];
    for (;;) {
      this.skipWs();
      if (this.peek() === '}') {
        this.pos += 1;
        break;
      }
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): GqlSelection {
    this.skipWs();
    if (this.src.startsWith('...', this.pos)) {
      this.pos += 3;
      this.skipWs();
      let inlineType: string | null = null;
      if (this.src.startsWith('on', this.pos)) {
        this.pos += 2;
        inlineType = this.readName();
      }
      const inner = this.parseSelectionSet();
      return { alias: null, name: '', args: {}, selections: inner, inlineType };
    }
    const first = this.readName();
    this.skipWs();
    let alias: string | null = null;
    let name = first;
    if (this.peek() === ':') {
      this.pos += 1;
      alias = first;
      name = this.readName();
    }
    const args: Record<string, unknown> = {};
    this.skipWs();
    if (this.peek() === '(') {
      this.pos += 1;
      for (;;) {
        this.skipWs();
        if (this.peek() === ')') {
          this.pos += 1;
          break;
        }
        const argName = this.readName();
        this.skipWs();
        this.expect(':');
        args[argName] = this.parseValue();
      }
    }
    this.skipWs();
    const selections = this.peek() === '{' ? this.parseSelectionSet() : null;
    return { alias, name, args, selections, inlineType: null };
  }

  private parseValue(): unknown {
    this.skipWs();
    const ch = this.peek();
    if (ch === '$') {
      this.pos += 1;
      return { __var: this.readName() };
    }
    if (ch === '"') {
      this.pos += 1;
      let out = '';
      while (this.pos < this.src.length && this.src[this.pos] !== '"') {
        if (this.src[this.pos] === '\\') {
          this.pos += 1;
          const esc = this.src[this.pos];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          this.pos += 1;
        } else {
          out += this.src[this.pos];
          this.pos += 1;
        }
      }
      this.pos += 1;
      return out;
    }
    if (ch === '[') {
      this.pos += 1;
      const items: unknown[] = [];
      for (;;) {
        this.skipWs();
        if (this.peek() === ']') {
          this.pos += 1;
          break;
        }
        items.push(this.parseValue());
      }
      return items;
    }
    if (ch === '{') {
      this.pos += 1;
      const obj: Record<string, unknown> = {};
      for (;;) {
        this.skipWs();
        if (this.peek() === '}') {
          this.pos += 1;
          break;
        }
        const key = this.readName();
        this.skipWs();
        this.expect(':');
        obj[key] = this.parseValue();
      }
      return obj;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const start = this.pos;
      if (ch === '-') this.pos += 1;
      while (this.pos < this.src.length && /[0-9.]/.test(this.src[this.pos])) this.pos += 1;
      return Number(this.src.slice(start, this.pos));
    }
    if (this.src.startsWith('true', this.pos)) {
      this.pos += 4;
      return true;
    }
    if (this.src.startsWith('false', this.pos)) {
      this.pos += 5;
      return false;
    }
    if (this.src.startsWith('null', this.pos)) {
      this.pos += 4;
      return null;
    }
    return this.readName(); // enum
  }
}

function resolveVariables(value: unknown, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) return value.map((v) => resolveVariables(v, variables));
    const rec = value as Record<string, unknown>;
    if ('__var' in rec && typeof rec.__var === 'string') return variables[rec.__var];
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) out[k] = resolveVariables(v, variables);
    return out;
  }
  return value;
}

function resolveArgs(sel: GqlSelection, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sel.args)) out[k] = resolveVariables(v, variables);
  return out;
}

// --- introspection schema (the types gh feature-detects) ---

const GQL_SCHEMA: Record<string, { fields: string[]; enumValues?: string[] }> = {
  Issue: {
    fields: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'closed', 'closedAt', 'repository'],
  },
  PullRequest: {
    fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'url', 'createdAt', 'updatedAt', 'author', 'repository', 'mergeCommit', 'isDraft'],
  },
  Repository: {
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'isPrivate', 'createdAt', 'updatedAt'],
  },
  SearchType: { fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  User: { fields: ['id', 'login', 'name', 'email', 'url'] },
  IssueConnection: { fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  Ref: { fields: ['id', 'name', 'target'] },
  IssueComment: { fields: ['id', 'body', 'author', 'createdAt', 'updatedAt'] },
  PullRequestChangedFile: { fields: ['path', 'additions', 'deletions', 'changeType'] },
};

type GqlNode =
  | { __typename: 'Query' }
  | { __typename: 'Mutation' }
  | { __typename: 'User'; login: string; id: number; name: string }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'IssueConnection'; repo: Repo; issues: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { __typename: 'PullRequestConnection'; repo: Repo; pulls: Pull[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { __typename: 'FileConnection'; files: PullFile[] }
  | { __typename: 'IssueComment'; repo: Repo; issueNumber: number; comment: Comment }
  | { __typename: 'Type'; name: string }
  | { __typename: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __typename: 'ChangedFile'; file: PullFile }
  | { __typename: 'CreateIssuePayload'; repo: Repo; issue: Issue }
  | { __typename: 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { __typename: 'CreatePullRequestPayload'; repo: Repo; pull: Pull }
  | { __typename: 'MergePullRequestPayload'; repo: Repo; pull: Pull }
  | { __typename: 'AddCommentPayload'; repo: Repo; issueNumber: number; comment: Comment }
  | { __typename: 'CommentEdge'; repo: Repo; issueNumber: number; comment: Comment };

function gqlState(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullGqlState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueCursor(issue: Issue): string {
  return Buffer.from(`cursor:${issue.number}`, 'utf8').toString('base64');
}

function cursorToNumber(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(raw);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/** Resolve a selection set against a node; returns the object, or throws a GqlError. */
class GqlError extends Error {}

function resolveSelections(
  ctx: Ctx,
  node: GqlNode,
  selections: GqlSelection[],
  variables: Record<string, unknown>,
  errors: Array<{ message: string; path?: string[] }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.inlineType !== null) {
      // Inline fragment: apply only when the node's type matches.
      if (sel.inlineType !== node.__typename) continue;
      const inner = resolveSelections(ctx, node, sel.selections ?? [], variables, errors);
      Object.assign(out, inner);
      continue;
    }
    const key = sel.alias ?? sel.name;
    try {
      out[key] = resolveField(ctx, node, sel, variables, errors);
    } catch (err) {
      if (err instanceof GqlError) {
        errors.push({ message: err.message, path: [key] });
        out[key] = null;
      } else {
        throw err;
      }
    }
  }
  return out;
}

function resolveField(
  ctx: Ctx,
  node: GqlNode,
  sel: GqlSelection,
  variables: Record<string, unknown>,
  errors: Array<{ message: string; path?: string[] }>,
): unknown {
  const args = resolveArgs(sel, variables);
  const sub = sel.selections ?? [];
  const store = ctx.store;

  switch (node.__typename) {
    case 'Query': {
      if (sel.name === 'viewer') {
        const user: GqlNode = { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME };
        return resolveSelections(ctx, user, sub, variables, errors);
      }
      if (sel.name === 'repository') {
        const repo = getRepo(store, str(args.owner), str(args.name));
        if (!repo) return null;
        return resolveSelections(ctx, { __typename: 'Repository', repo }, sub, variables, errors);
      }
      if (sel.name === 'node') {
        const parsed = parseGlobalId(str(args.id));
        if (!parsed) return null;
        if (parsed.kind === 'Repository') {
          const repo = [...store.repos.values()].find((r) => r.databaseId === parsed.databaseId);
          if (!repo) return null;
          return resolveSelections(ctx, { __typename: 'Repository', repo }, sub, variables, errors);
        }
        if (parsed.kind === 'Issue' && parsed.number !== undefined) {
          const repo = [...store.repos.values()].find((r) => r.databaseId === parsed.databaseId);
          const issue = repo?.issues.get(parsed.number);
          if (!repo || !issue) return null;
          return resolveSelections(ctx, { __typename: 'Issue', repo, issue }, sub, variables, errors);
        }
        if (parsed.kind === 'PullRequest' && parsed.number !== undefined) {
          const repo = [...store.repos.values()].find((r) => r.databaseId === parsed.databaseId);
          const pull = repo?.pulls.get(parsed.number);
          if (!repo || !pull) return null;
          return resolveSelections(ctx, { __typename: 'PullRequest', repo, pull }, sub, variables, errors);
        }
        return null;
      }
      if (sel.name === '__type') {
        const typeName = str(args.name);
        const typeDef = GQL_SCHEMA[typeName];
        if (!typeDef) return null;
        return resolveSelections(ctx, { __typename: 'Type', name: typeName }, sub, variables, errors);
      }
      throw new GqlError(`Cannot query field "${sel.name}" on type "Query".`);
    }
    case 'Mutation': {
      if (sel.name === 'createIssue') {
        const input = isRecord(args.input) ? args.input : {};
        const parsed = parseGlobalId(str(input.repositoryId));
        if (!parsed || parsed.kind !== 'Repository') throw new GqlError('createIssue: repositoryId is not a repository');
        const repo = [...store.repos.values()].find((r) => r.databaseId === parsed.databaseId);
        if (!repo) throw new GqlError('createIssue: repository not found');
        const title = str(input.title);
        if (!title) throw new GqlError('createIssue: title is required');
        const number = repo.nextIssue;
        repo.nextIssue += 1;
        const issue: Issue = { id: store.nextIssueId, number, title, body: str(input.body), state: 'open', labels: [], seq: ++store.seq };
        store.nextIssueId += 1;
        repo.issues.set(number, issue);
        return resolveSelections(ctx, { __typename: 'CreateIssuePayload', repo, issue }, sub, variables, errors);
      }
      if (sel.name === 'closeIssue') {
        const input = isRecord(args.input) ? args.input : {};
        const parsed = parseGlobalId(str(input.issueId));
        if (!parsed || parsed.kind !== 'Issue' || parsed.number === undefined) throw new GqlError('closeIssue: issueId is not an issue');
        const repo = [...store.repos.values()].find((r) => r.databaseId === parsed.databaseId);
        const issue = repo?.issues.get(parsed.number);
        if (!repo || !issue) throw new GqlError('closeIssue: issue not found');
        issue.state = 'closed';
        return resolveSelections(ctx, { __typename: 'CloseIssuePayload', repo, issue }, sub, variables, errors);
      }
      if (sel.name === 'createPullRequest') {
        const input = isRecord(args.input) ? args.input : {};
        const parsed = parseGlobalId(str(input.repositoryId));
        if (!parsed || parsed.kind !== 'Repository') throw new GqlError('createPullRequest: repositoryId is not a repository');
        const repo = [...store.repos.values()].find((r) => r.databaseId === parsed.databaseId);
        if (!repo) throw new GqlError('createPullRequest: repository not found');
        const headRef = str(input.headRefName);
        const baseRef = str(input.baseRefName);
        const headSha = repo.refs.get(`refs/heads/${headRef}`);
        const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
        if (!headSha || !baseSha) throw new GqlError('createPullRequest: head or base branch does not exist');
        const headCommit = repo.objects.get(headSha);
        const baseCommit = repo.objects.get(baseSha);
        const headTree = headCommit && headCommit.type === 'commit' ? parseCommit(headCommit.data).tree : '';
        const baseTree = baseCommit && baseCommit.type === 'commit' ? parseCommit(baseCommit.data).tree : '';
        const number = repo.nextPull;
        repo.nextPull += 1;
        const pull: Pull = {
          id: store.nextPullId, number, title: str(input.title), body: str(input.body), state: 'open',
          headRef, headSha, baseRef, baseSha, merged: false, mergedAt: null, mergeCommitSha: null,
          mergeable: true, files: diffFiles(repo, baseTree, headTree), seq: ++store.seq,
        };
        store.nextPullId += 1;
        repo.pulls.set(number, pull);
        return resolveSelections(ctx, { __typename: 'CreatePullRequestPayload', repo, pull }, sub, variables, errors);
      }
      if (sel.name === 'mergePullRequest') {
        const input = isRecord(args.input) ? args.input : {};
        const parsed = parseGlobalId(str(input.pullRequestId));
        if (!parsed || parsed.kind !== 'PullRequest' || parsed.number === undefined) throw new GqlError('mergePullRequest: pullRequestId is not a pull request');
        const repo = [...store.repos.values()].find((r) => r.databaseId === parsed.databaseId);
        const pull = repo?.pulls.get(parsed.number);
        if (!repo || !pull) throw new GqlError('mergePullRequest: pull request not found');
        if (pull.state === 'closed') throw new GqlError('mergePullRequest: pull request is already closed');
        const mergedFiles = threeWayMerge(repo, pull);
        if (mergedFiles === null) throw new GqlError('mergePullRequest: merge conflict');
        const commitOid = commitFiles(store, repo, pull.baseRef, mergedFiles, `${pull.title} (#${pull.number})`);
        pull.merged = true;
        pull.state = 'closed';
        pull.mergedAt = '2026-01-01T00:00:00Z';
        pull.mergeCommitSha = commitOid;
        repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
        return resolveSelections(ctx, { __typename: 'MergePullRequestPayload', repo, pull }, sub, variables, errors);
      }
      if (sel.name === 'addComment') {
        const input = isRecord(args.input) ? args.input : {};
        const parsed = parseGlobalId(str(input.subjectId));
        if (!parsed || parsed.kind !== 'Issue' || parsed.number === undefined) throw new GqlError('addComment: subjectId is not an issue');
        const repo = [...store.repos.values()].find((r) => r.databaseId === parsed.databaseId);
        const issue = repo?.issues.get(parsed.number);
        if (!repo || !issue) throw new GqlError('addComment: issue not found');
        const comment: Comment = { id: store.nextCommentId, body: str(input.body), seq: ++store.seq };
        store.nextCommentId += 1;
        const list = repo.comments.get(parsed.number) ?? [];
        list.push(comment);
        repo.comments.set(parsed.number, list);
        return resolveSelections(ctx, { __typename: 'AddCommentPayload', repo, issueNumber: parsed.number, comment }, sub, variables, errors);
      }
      throw new GqlError(`Cannot query field "${sel.name}" on type "Mutation".`);
    }
    case 'User': {
      if (sel.name === 'login') return node.login;
      if (sel.name === 'id') return globalId('User', node.id);
      if (sel.name === 'name') return node.name;
      if (sel.name === 'email') return VIEWER_EMAIL;
      if (sel.name === 'url') return `https://example.invalid/${node.login}`;
      throw new GqlError(`Cannot query field "${sel.name}" on type "User".`);
    }
    case 'Repository': {
      const repo = node.repo;
      if (sel.name === 'id') return globalId('Repository', repo.databaseId);
      if (sel.name === 'databaseId') return repo.databaseId;
      if (sel.name === 'name') return repo.name;
      if (sel.name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (sel.name === 'owner') {
        return resolveSelections(ctx, { __typename: 'User', login: repo.owner, id: VIEWER_ID, name: VIEWER_NAME }, sub, variables, errors);
      }
      if (sel.name === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (!tip) return null;
        return resolveSelections(ctx, { __typename: 'Ref', name: repo.defaultBranch }, sub, variables, errors);
      }
      if (sel.name === 'viewerPermission') return 'ADMIN';
      if (sel.name === 'hasIssuesEnabled') return true;
      if (sel.name === 'description') return repo.description;
      if (sel.name === 'isPrivate') return repo.private;
      if (sel.name === 'url') return `https://example.invalid/${repo.owner}/${repo.name}`;
      if (sel.name === 'issue') {
        const issue = repo.issues.get(Number(args.number));
        if (!issue) return null;
        return resolveSelections(ctx, { __typename: 'Issue', repo, issue }, sub, variables, errors);
      }
      if (sel.name === 'issues') {
        const first = typeof args.first === 'number' ? args.first : 10;
        const afterNum = cursorToNumber(typeof args.after === 'string' ? args.after : null);
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
        let issues = [...repo.issues.values()];
        if (states) {
          const wanted = new Set(states.map((s) => String(s).toLowerCase()));
          issues = issues.filter((i) => wanted.has(i.state));
        }
        const direction = str(orderBy.direction, 'DESC');
        issues.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
        if (afterNum !== null) {
          issues = issues.filter((i) => (direction === 'ASC' ? i.number > afterNum : i.number < afterNum));
        }
        const page = issues.slice(0, first);
        const hasNextPage = issues.length > first;
        const endCursor = page.length ? issueCursor(page[page.length - 1]) : null;
        const conn: GqlNode = { __typename: 'IssueConnection', repo, issues: page, pageInfo: { hasNextPage, endCursor } };
        return resolveSelections(ctx, conn, sub, variables, errors);
      }
      if (sel.name === 'pullRequests') {
        const first = typeof args.first === 'number' ? args.first : 10;
        const afterNum = cursorToNumber(typeof args.after === 'string' ? args.after : null);
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        let pulls = [...repo.pulls.values()];
        if (states) {
          const wanted = new Set(states.map((s) => String(s).toUpperCase()));
          pulls = pulls.filter((p) => wanted.has(pullGqlState(p)));
        }
        pulls.sort((a, b) => b.number - a.number);
        if (afterNum !== null) pulls = pulls.filter((p) => p.number < afterNum);
        const page = pulls.slice(0, first);
        const hasNextPage = pulls.length > first;
        const endCursor = page.length ? Buffer.from(`cursor:${page[page.length - 1].number}`, 'utf8').toString('base64') : null;
        const conn: GqlNode = { __typename: 'PullRequestConnection', repo, pulls: page, pageInfo: { hasNextPage, endCursor } };
        return resolveSelections(ctx, conn, sub, variables, errors);
      }
      if (sel.name === 'pullRequest') {
        const pull = repo.pulls.get(Number(args.number));
        if (!pull) return null;
        return resolveSelections(ctx, { __typename: 'PullRequest', repo, pull }, sub, variables, errors);
      }
      throw new GqlError(`Cannot query field "${sel.name}" on type "Repository".`);
    }
    case 'Issue': {
      const issue = node.issue;
      if (sel.name === 'id') return globalId('Issue', node.repo.databaseId, issue.number);
      if (sel.name === 'number') return issue.number;
      if (sel.name === 'title') return issue.title;
      if (sel.name === 'state') return gqlState(issue.state);
      if (sel.name === 'body') return issue.body;
      if (sel.name === 'url') return `https://example.invalid/${node.repo.owner}/${node.repo.name}/issues/${issue.number}`;
      if (sel.name === 'closed') return issue.state === 'closed';
      if (sel.name === 'repository') {
        return resolveSelections(ctx, { __typename: 'Repository', repo: node.repo }, sub, variables, errors);
      }
      throw new GqlError(`Cannot query field "${sel.name}" on type "Issue".`);
    }
    case 'PullRequest': {
      const pull = node.pull;
      if (sel.name === 'id') return globalId('PullRequest', node.repo.databaseId, pull.number);
      if (sel.name === 'number') return pull.number;
      if (sel.name === 'title') return pull.title;
      if (sel.name === 'body') return pull.body;
      if (sel.name === 'state') return pullGqlState(pull);
      if (sel.name === 'merged') return pull.merged;
      if (sel.name === 'mergeable') {
        // GraphQL's mergeable is an enum (MERGEABLE / CONFLICTING / UNKNOWN); REST's is a boolean.
        const ok = pull.state === 'open' ? isMergeable(node.repo, pull) : pull.mergeable;
        return ok ? 'MERGEABLE' : 'CONFLICTING';
      }
      if (sel.name === 'headRefName') return pull.headRef;
      if (sel.name === 'baseRefName') return pull.baseRef;
      if (sel.name === 'headRefOid') return pull.headSha;
      if (sel.name === 'baseRefOid') return pull.baseSha;
      if (sel.name === 'url') return `https://example.invalid/${node.repo.owner}/${node.repo.name}/pull/${pull.number}`;
      if (sel.name === 'repository') {
        return resolveSelections(ctx, { __typename: 'Repository', repo: node.repo }, sub, variables, errors);
      }
      if (sel.name === 'files') {
        const first = typeof args.first === 'number' ? args.first : 10;
        const files = pull.files.slice(0, first);
        return resolveSelections(ctx, { __typename: 'FileConnection', files }, sub, variables, errors);
      }
      throw new GqlError(`Cannot query field "${sel.name}" on type "PullRequest".`);
    }
    case 'Ref': {
      if (sel.name === 'name') return node.name;
      if (sel.name === 'id') return globalId('Ref', 1);
      throw new GqlError(`Cannot query field "${sel.name}" on type "Ref".`);
    }
    case 'IssueConnection': {
      if (sel.name === 'nodes') {
        return node.issues.map((issue) => resolveSelections(ctx, { __typename: 'Issue', repo: node.repo, issue }, sub, variables, errors));
      }
      if (sel.name === 'edges') {
        return node.issues.map((issue) => ({ node: resolveSelections(ctx, { __typename: 'Issue', repo: node.repo, issue }, sub, variables, errors), cursor: issueCursor(issue) }));
      }
      if (sel.name === 'pageInfo') {
        return resolveSelections(ctx, { __typename: 'PageInfo', hasNextPage: node.pageInfo.hasNextPage, endCursor: node.pageInfo.endCursor }, sub, variables, errors);
      }
      if (sel.name === 'totalCount') return node.issues.length;
      throw new GqlError(`Cannot query field "${sel.name}" on type "IssueConnection".`);
    }
    case 'PullRequestConnection': {
      if (sel.name === 'nodes') {
        return node.pulls.map((pull) => resolveSelections(ctx, { __typename: 'PullRequest', repo: node.repo, pull }, sub, variables, errors));
      }
      if (sel.name === 'edges') {
        return node.pulls.map((pull) => ({ node: resolveSelections(ctx, { __typename: 'PullRequest', repo: node.repo, pull }, sub, variables, errors), cursor: Buffer.from(`cursor:${pull.number}`, 'utf8').toString('base64') }));
      }
      if (sel.name === 'pageInfo') {
        return resolveSelections(ctx, { __typename: 'PageInfo', hasNextPage: node.pageInfo.hasNextPage, endCursor: node.pageInfo.endCursor }, sub, variables, errors);
      }
      if (sel.name === 'totalCount') return node.pulls.length;
      throw new GqlError(`Cannot query field "${sel.name}" on type "PullRequestConnection".`);
    }
    case 'FileConnection': {
      if (sel.name === 'nodes') {
        return node.files.map((file) => resolveSelections(ctx, { __typename: 'ChangedFile', file }, sub, variables, errors));
      }
      if (sel.name === 'pageInfo') {
        return resolveSelections(ctx, { __typename: 'PageInfo', hasNextPage: false, endCursor: null }, sub, variables, errors);
      }
      if (sel.name === 'totalCount') return node.files.length;
      throw new GqlError(`Cannot query field "${sel.name}" on type "PullRequestChangedFileConnection".`);
    }
    case 'ChangedFile': {
      if (sel.name === 'path') return node.file.filename;
      if (sel.name === 'additions') return node.file.additions;
      if (sel.name === 'deletions') return node.file.deletions;
      if (sel.name === 'changeType') return node.file.status.toUpperCase();
      throw new GqlError(`Cannot query field "${sel.name}" on type "PullRequestChangedFile".`);
    }
    case 'PageInfo': {
      if (sel.name === 'hasNextPage') return node.hasNextPage;
      if (sel.name === 'endCursor') return node.endCursor;
      if (sel.name === 'hasPreviousPage') return false;
      if (sel.name === 'startCursor') return node.endCursor;
      throw new GqlError(`Cannot query field "${sel.name}" on type "PageInfo".`);
    }
    case 'Type': {
      const def = GQL_SCHEMA[node.name];
      if (sel.name === 'fields') {
        const includeDeprecated = args.includeDeprecated === true;
        void includeDeprecated;
        return (def?.fields ?? []).map((f) => ({ name: f }));
      }
      if (sel.name === 'enumValues') {
        return (def?.enumValues ?? []).map((v) => ({ name: v }));
      }
      if (sel.name === 'name') return node.name;
      if (sel.name === 'kind') return def?.enumValues ? 'ENUM' : 'OBJECT';
      throw new GqlError(`Cannot query field "${sel.name}" on type "__Type".`);
    }
    case 'CreateIssuePayload': {
      if (sel.name === 'issue') {
        return resolveSelections(ctx, { __typename: 'Issue', repo: node.repo, issue: node.issue }, sub, variables, errors);
      }
      throw new GqlError(`Cannot query field "${sel.name}" on type "CreateIssuePayload".`);
    }
    case 'CloseIssuePayload': {
      if (sel.name === 'issue') {
        return resolveSelections(ctx, { __typename: 'Issue', repo: node.repo, issue: node.issue }, sub, variables, errors);
      }
      throw new GqlError(`Cannot query field "${sel.name}" on type "CloseIssuePayload".`);
    }
    case 'CreatePullRequestPayload': {
      if (sel.name === 'pullRequest') {
        return resolveSelections(ctx, { __typename: 'PullRequest', repo: node.repo, pull: node.pull }, sub, variables, errors);
      }
      throw new GqlError(`Cannot query field "${sel.name}" on type "CreatePullRequestPayload".`);
    }
    case 'MergePullRequestPayload': {
      if (sel.name === 'pullRequest') {
        return resolveSelections(ctx, { __typename: 'PullRequest', repo: node.repo, pull: node.pull }, sub, variables, errors);
      }
      throw new GqlError(`Cannot query field "${sel.name}" on type "MergePullRequestPayload".`);
    }
    case 'AddCommentPayload': {
      if (sel.name === 'commentEdge') {
        return resolveSelections(ctx, { __typename: 'CommentEdge', repo: node.repo, issueNumber: node.issueNumber, comment: node.comment }, sub, variables, errors);
      }
      throw new GqlError(`Cannot query field "${sel.name}" on type "AddCommentPayload".`);
    }
    case 'CommentEdge': {
      if (sel.name === 'node') {
        return resolveSelections(ctx, { __typename: 'IssueComment', repo: node.repo, issueNumber: node.issueNumber, comment: node.comment }, sub, variables, errors);
      }
      if (sel.name === 'cursor') return Buffer.from(`cursor:${node.comment.id}`, 'utf8').toString('base64');
      throw new GqlError(`Cannot query field "${sel.name}" on type "IssueCommentEdge".`);
    }
    case 'IssueComment': {
      if (sel.name === 'id') return globalId('IssueComment', node.repo.databaseId, node.comment.id);
      if (sel.name === 'body') return node.comment.body;
      throw new GqlError(`Cannot query field "${sel.name}" on type "IssueComment".`);
    }
    default:
      throw new GqlError(`Cannot query field "${sel.name}" on type "${(node as GqlNode).__typename}".`);
  }
}

function executeGraphQLOperation(ctx: Ctx, op: GqlOperation, variables: Record<string, unknown>): Record<string, unknown> {
  const errors: Array<{ message: string; path?: string[] }> = [];
  const root: GqlNode = op.kind === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  const data = resolveSelections(ctx, root, op.selections, variables, errors);
  const body: Record<string, unknown> = { data };
  if (errors.length) body.errors = errors;
  return body;
}

function handleGraphQL(ctx: Ctx): void {
  if (!requireAuth(ctx)) return;
  const body = parseJsonBody(ctx);
  if (body === null) return;
  // Batched: a JSON array of operations -> an array of responses in order.
  if (Array.isArray(body)) {
    const responses: unknown[] = [];
    for (const entry of body) {
      if (!isRecord(entry) || typeof entry.query !== 'string') {
        responses.push({ data: null, errors: [{ message: 'Invalid operation' }] });
        continue;
      }
      responses.push(executeOneGraphQL(ctx, entry.query, isRecord(entry.variables) ? entry.variables : {}));
    }
    sendJson(ctx, 200, responses);
    return;
  }
  if (!isRecord(body) || typeof body.query !== 'string') {
    sendJson(ctx, 200, { data: null, errors: [{ message: 'A query is required' }] });
    return;
  }
  sendJson(ctx, 200, executeOneGraphQL(ctx, body.query, isRecord(body.variables) ? body.variables : {}));
}

function executeOneGraphQL(ctx: Ctx, query: string, variables: Record<string, unknown>): Record<string, unknown> {
  let operations: GqlOperation[];
  try {
    operations = new GqlParser(query).parse();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }
  if (operations.length === 0) {
    return { data: null, errors: [{ message: 'Empty document' }] };
  }
  // Multiple operations in one document: execute each and merge (the suite sends one op per doc,
  // except batched-operations which uses the array form).
  const merged: Record<string, unknown> = {};
  const allErrors: Array<{ message: string; path?: string[] }> = [];
  for (const op of operations) {
    const result = executeGraphQLOperation(ctx, op, variables);
    if (isRecord(result.data)) Object.assign(merged, result.data);
    if (Array.isArray(result.errors)) allErrors.push(...(result.errors as Array<{ message: string; path?: string[] }>));
  }
  const body: Record<string, unknown> = { data: merged };
  if (allErrors.length) body.errors = allErrors;
  return body;
}

// ---------------------------------------------------------------------------------------------
// MCP (JSON-RPC 2.0 Streamable HTTP at /mcp)
// ---------------------------------------------------------------------------------------------

const MCP_TOOLS: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function mcpToolResult(value: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError,
  };
}

function mcpToolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function findMcpTool(name: string): (typeof MCP_TOOLS)[number] | null {
  const lower = name.toLowerCase();
  for (const tool of MCP_TOOLS) {
    if (tool.name.toLowerCase() === lower) return tool;
    // A server prefix is allowed (e.g. github__create_issue); match by suffix.
    const suffix = lower.split('__').pop() ?? lower;
    if (tool.name.toLowerCase() === suffix) return tool;
  }
  return null;
}

function handleMcpCall(ctx: Ctx, toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const store = ctx.store;
  const tool = findMcpTool(toolName);
  if (!tool) {
    throw { code: -32602, message: `unknown tool: ${toolName}` };
  }
  const required = (tool.inputSchema.required as string[]) ?? [];
  for (const prop of required) {
    if (args[prop] === undefined || args[prop] === null || args[prop] === '') {
      return mcpToolError(`missing required argument: ${prop}`);
    }
  }
  switch (tool.name) {
    case 'create_repo': {
      const name = str(args.name);
      if (getRepo(store, VIEWER_LOGIN, name)) {
        return mcpToolError(`Repository ${name} already exists`);
      }
      const repo = createRepoRecord(store, name, args.private === true, str(args.description));
      return mcpToolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = getRepo(store, str(args.owner), str(args.repo));
      if (!repo) return mcpToolError(`Repository ${str(args.owner)}/${str(args.repo)} not found`);
      return mcpToolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = getRepo(store, str(args.owner), str(args.repo));
      if (!repo) return mcpToolError(`Repository ${str(args.owner)}/${str(args.repo)} not found`);
      const title = str(args.title);
      const number = repo.nextIssue;
      repo.nextIssue += 1;
      const issue: Issue = { id: store.nextIssueId, number, title, body: str(args.body), state: 'open', labels: [], seq: ++store.seq };
      store.nextIssueId += 1;
      repo.issues.set(number, issue);
      return mcpToolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = getRepo(store, str(args.owner), str(args.repo));
      if (!repo) return mcpToolError(`Repository ${str(args.owner)}/${str(args.repo)} not found`);
      const state = str(args.state, 'open') || 'open';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((i) => i.state === state);
      issues.sort((a, b) => b.seq - a.seq);
      return mcpToolResult(issues.map((i) => issueJson(repo, i)));
    }
    case 'create_pull_request': {
      const repo = getRepo(store, str(args.owner), str(args.repo));
      if (!repo) return mcpToolError(`Repository ${str(args.owner)}/${str(args.repo)} not found`);
      const headRef = str(args.head);
      const baseRef = str(args.base);
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (!headSha || !baseSha) return mcpToolError(`head or base branch does not exist`);
      const headCommit = repo.objects.get(headSha);
      const baseCommit = repo.objects.get(baseSha);
      const headTree = headCommit && headCommit.type === 'commit' ? parseCommit(headCommit.data).tree : '';
      const baseTree = baseCommit && baseCommit.type === 'commit' ? parseCommit(baseCommit.data).tree : '';
      const number = repo.nextPull;
      repo.nextPull += 1;
      const pull: Pull = {
        id: store.nextPullId, number, title: str(args.title), body: str(args.body), state: 'open',
        headRef, headSha, baseRef, baseSha, merged: false, mergedAt: null, mergeCommitSha: null,
        mergeable: true, files: diffFiles(repo, baseTree, headTree), seq: ++store.seq,
      };
      store.nextPullId += 1;
      repo.pulls.set(number, pull);
      return mcpToolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = getRepo(store, str(args.owner), str(args.repo));
      if (!repo) return mcpToolError(`Repository ${str(args.owner)}/${str(args.repo)} not found`);
      const number = Number(args.pull_number);
      const pull = repo.pulls.get(number);
      if (!pull) return mcpToolError(`Pull request #${number} not found`);
      if (pull.state === 'closed') return mcpToolError(`Pull request #${number} is already closed`);
      const mergedFiles = threeWayMerge(repo, pull);
      if (mergedFiles === null) return mcpToolError(`Pull request #${number} has a merge conflict`);
      const commitOid = commitFiles(store, repo, pull.baseRef, mergedFiles, `${pull.title} (#${pull.number})`);
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = '2026-01-01T00:00:00Z';
      pull.mergeCommitSha = commitOid;
      repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
      return mcpToolResult(pullJson(repo, pull));
    }
    default:
      throw { code: -32601, message: `unknown tool: ${toolName}` };
  }
}

function handleMcp(ctx: Ctx): void {
  // Auth: a tools/call with no Authorization header is a 401 (and so is every other call).
  if (!bearerToken(ctx)) {
    sendJson(ctx, 401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Requires authentication' } });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    sendJson(ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    sendJson(ctx, 400, { jsonrpc: '2.0', id: isRecord(parsed) ? (parsed.id ?? null) : null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const id = parsed.id ?? null;
  const method = parsed.method as string;
  const params = isRecord(parsed.params) ? parsed.params : {};
  // Notifications (no id) get no response.
  const isNotification = parsed.id === undefined;
  const respond = (result: unknown): void => {
    if (isNotification) {
      ctx.res.writeHead(202, { 'content-type': 'application/json' });
      ctx.res.end('');
      return;
    }
    sendJson(ctx, 200, { jsonrpc: '2.0', id, result });
  };
  const respondError = (code: number, message: string): void => {
    if (isNotification) {
      ctx.res.writeHead(202, { 'content-type': 'application/json' });
      ctx.res.end('');
      return;
    }
    sendJson(ctx, 200, { jsonrpc: '2.0', id, error: { code, message } });
  };
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    respond(null);
    return;
  }
  if (method === 'server/discover') {
    respond({
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-clone-01-forge', version: '1.0.0' },
    });
    return;
  }
  if (method === 'initialize') {
    const requested = str(isRecord(params) ? params.protocolVersion : undefined, '2026-07-28');
    const supported = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    respond({
      protocolVersion: supported.includes(requested) ? requested : '2026-07-28',
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-clone-01-forge', version: '1.0.0' },
    });
    return;
  }
  if (method === 'tools/list') {
    // Deterministic: the same array, byte for byte, on every call.
    respond({ tools: MCP_TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const toolName = str(params.name);
    const args = isRecord(params.arguments) ? params.arguments : {};
    if (!toolName) {
      respondError(-32602, 'tools/call requires a tool name');
      return;
    }
    try {
      const result = handleMcpCall(ctx, toolName, args);
      respond(result);
    } catch (err) {
      if (err !== null && typeof err === 'object' && 'code' in err && 'message' in err) {
        const e = err as { code: number; message: string };
        respondError(e.code, e.message);
      } else {
        respondError(-32603, err instanceof Error ? err.message : String(err));
      }
    }
    return;
  }
  respondError(-32601, `Method not found: ${method}`);
}

// ---------------------------------------------------------------------------------------------
// router + server
// ---------------------------------------------------------------------------------------------

async function route(ctx: Ctx): Promise<void> {
  const { method, pathname } = ctx;

  // Health (no auth).
  if (pathname === '/healthz' && method === 'GET') {
    sendJson(ctx, 200, { ok: true });
    return;
  }

  // Git smart HTTP (no auth required; the client may send a token anyway).
  if (pathname.endsWith('/info/refs') && method === 'GET' && pathname.includes('.git/')) {
    handleInfoRefs(ctx);
    return;
  }
  if (pathname.endsWith('/git-upload-pack') && method === 'POST') {
    handleUploadPack(ctx);
    return;
  }
  if (pathname.endsWith('/git-receive-pack') && method === 'POST') {
    handleReceivePack(ctx);
    return;
  }

  // MCP.
  if (pathname === '/mcp' && method === 'POST') {
    handleMcp(ctx);
    return;
  }

  // GraphQL.
  if (pathname === '/api/graphql' && method === 'POST') {
    handleGraphQL(ctx);
    return;
  }

  // REST v3 (all require a token).
  if (pathname === '/api/v3/' || pathname === '/api/v3') {
    if (!requireAuth(ctx)) return;
    handleRestRoot(ctx);
    return;
  }
  if (pathname.startsWith('/api/v3/')) {
    if (!requireAuth(ctx)) return;
    routeRest(ctx);
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

function routeRest(ctx: Ctx): void {
  const { method, pathname } = ctx;
  const rest = pathname.slice('/api/v3/'.length);
  const segments = rest.split('/').map(decodeSegment);

  if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') {
    handleRestMeta(ctx);
    return;
  }
  if (segments[0] === 'user' && segments.length === 1 && method === 'GET') {
    handleRestUser(ctx);
    return;
  }
  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (segments.length === 2 && method === 'GET') {
      handleListUserRepos(ctx);
      return;
    }
    if (segments.length === 2 && method === 'POST') {
      handleCreateUserRepo(ctx);
      return;
    }
  }
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1];
    const name = segments[2];
    const tail = segments.slice(3);
    if (tail.length === 0) {
      if (method === 'GET') {
        handleGetRepo(ctx, owner, name);
        return;
      }
      if (method === 'PATCH') {
        handlePatchRepo(ctx, owner, name);
        return;
      }
      if (method === 'DELETE') {
        handleDeleteRepo(ctx, owner, name);
        return;
      }
    }
    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        handleListBranches(ctx, owner, name);
        return;
      }
      if (tail.length === 2 && method === 'GET') {
        handleGetBranch(ctx, owner, name, tail[1]);
        return;
      }
    }
    if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
      handleListCommits(ctx, owner, name);
      return;
    }
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (tail.length === 2 && method === 'GET') {
        handleListRefs(ctx, owner, name);
        return;
      }
      if (tail.length === 2 && method === 'POST') {
        handleCreateRef(ctx, owner, name);
        return;
      }
      if (tail.length > 2 && method === 'GET') {
        handleGetRef(ctx, owner, name, tail.slice(2).join('/'));
        return;
      }
    }
    if (tail[0] === 'contents') {
      const filePath = tail.slice(1).join('/');
      if (method === 'GET') {
        handleGetContents(ctx, owner, name, filePath);
        return;
      }
      if (method === 'PUT') {
        handlePutContents(ctx, owner, name, filePath);
        return;
      }
      if (method === 'DELETE') {
        handleDeleteContents(ctx, owner, name, filePath);
        return;
      }
    }
    if (tail[0] === 'labels') {
      if (tail.length === 1 && method === 'GET') {
        handleListLabels(ctx, owner, name);
        return;
      }
      if (tail.length === 1 && method === 'POST') {
        handleCreateLabel(ctx, owner, name);
        return;
      }
    }
    if (tail[0] === 'issues') {
      if (tail.length === 1 && method === 'GET') {
        handleListIssues(ctx, owner, name);
        return;
      }
      if (tail.length === 1 && method === 'POST') {
        handleCreateIssue(ctx, owner, name);
        return;
      }
      const issueNumber = Number(tail[1]);
      if (Number.isInteger(issueNumber) && issueNumber > 0) {
        if (tail.length === 2 && method === 'GET') {
          handleGetIssue(ctx, owner, name, issueNumber);
          return;
        }
        if (tail.length === 2 && method === 'PATCH') {
          handlePatchIssue(ctx, owner, name, issueNumber);
          return;
        }
        if (tail.length === 3 && tail[2] === 'comments' && method === 'GET') {
          handleListComments(ctx, owner, name, issueNumber);
          return;
        }
        if (tail.length === 3 && tail[2] === 'comments' && method === 'POST') {
          handleCreateComment(ctx, owner, name, issueNumber);
          return;
        }
      }
    }
    if (tail[0] === 'pulls') {
      if (tail.length === 1 && method === 'GET') {
        handleListPulls(ctx, owner, name);
        return;
      }
      if (tail.length === 1 && method === 'POST') {
        handleCreatePull(ctx, owner, name);
        return;
      }
      const pullNumber = Number(tail[1]);
      if (Number.isInteger(pullNumber) && pullNumber > 0) {
        if (tail.length === 2 && method === 'GET') {
          handleGetPull(ctx, owner, name, pullNumber);
          return;
        }
        if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
          handleListPullFiles(ctx, owner, name, pullNumber);
          return;
        }
        if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
          handleMergePull(ctx, owner, name, pullNumber);
          return;
        }
      }
    }
  }

  // Unknown /api/v3 route: a JSON 404 (never HTML).
  sendError(ctx, 404, 'Not Found');
}

/** Create the forge HTTP server for a store. */
export function createForgeServer(store: Store): ReturnType<typeof createServer> {
  const server = createServer(async (req, res) => {
    const ctx: Ctx = {
      store,
      req,
      res,
      method: req.method ?? 'GET',
      url: new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`),
      pathname: '',
      query: new URLSearchParams(),
      body: Buffer.alloc(0),
      token: null,
    };
    ctx.pathname = ctx.url.pathname;
    ctx.query = ctx.url.searchParams;
    try {
      ctx.body = await readBody(req);
    } catch {
      sendError(ctx, 400, 'Could not read request body');
      return;
    }
    try {
      await route(ctx);
    } catch (err) {
      // Never crash on a request: answer 500 JSON and keep serving.
      if (!res.headersSent) {
        sendError(ctx, 500, err instanceof Error ? err.message : String(err));
      } else {
        res.end();
      }
    }
  });
  // Keep-alive is on by default; the read workload reuses one connection.
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;
  return server;
}

// ---------------------------------------------------------------------------------------------
// entry point helper (what main.ts imports)
// ---------------------------------------------------------------------------------------------

/** Build the forge server: one store, one HTTP server. The bearer token the suite presents
 * (MAKEFUN_SHOP_TOKEN) is read for the record; any non-empty token is the viewer. */
export function createApp(): ReturnType<typeof createServer> {
  const store = createStore(process.env.MAKEFUN_SHOP_TOKEN ?? '');
  return createForgeServer(store);
}
