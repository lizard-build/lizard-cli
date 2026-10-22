/**
 * A Lizard Git working copy (after Scion: lizard.build/git keeps no repositories as files and
 * makes every commit on the server).
 *
 * A checkout is files plus .lizard-git/checkout.json (named like .git: a repository's own
 * .lizard/ folder holds its CI workflows): which repository and branch, the changeset
 * the files came from (base), and each file's hash. Nothing else is local: no history, no
 * object database. Contents come from the server by hash, through a cache shared by every
 * checkout on this machine (~/.cache/lizard/git; immutable, so it never needs invalidating),
 * and a sparse checkout only ever fetches the folders it covers.
 *
 * `commit` records a commit here (pending, with copies of its contents under
 * .lizard-git/objects/); `push` sends every pending commit: the server is asked which contents
 * it lacks, those are uploaded, then one request makes the commits on the branch and moves it
 * once (one CI run, one deploy). If the branch moved since they were made, the server places
 * them on the new tip (merging the same files line by line); only a real conflict comes back.
 */
export declare const STATE_DIR = ".lizard-git";
export interface FileState {
    h: string;
    m: string;
    s?: number;
    t?: number;
}
/** A commit made here and not pushed yet: its files' states (full contents, by hash). */
export interface PendingCommit {
    message: string;
    time: number;
    files: ({
        path: string;
        hash: string;
        mode: string;
    } | {
        path: string;
        delete: true;
    })[];
}
export interface Pending {
    base: string;
    newBranch?: boolean;
    fromBranch?: string;
    commits: PendingCommit[];
    orig: Record<string, FileState | null>;
}
export interface Checkout {
    version: 1;
    url: string;
    repo: string;
    branch: string;
    base: string;
    root: string;
    sparse: string[] | null;
    files: Record<string, FileState>;
    pending?: Pending;
    conflicts?: Conflict[];
}
export interface Conflict {
    path: string;
    reason: string;
}
interface WireEntry {
    name: string;
    mode: string;
    type: "tree" | "blob" | "commit";
    hash: string;
    size: number;
}
/** The checkout containing dir (walking up), or null. */
export declare function findCheckout(dir?: string): string | null;
export declare function loadCheckout(root: string): Checkout;
export declare function saveCheckout(root: string, c: Checkout): void;
export declare const sha256: (b: Buffer | string) => string;
/** Trees by hash (cached forever: a tree never changes). */
export declare function getTrees(repo: string, hashes: string[]): Promise<Map<string, WireEntry[]>>;
/** File contents by hash: small ones batched, big ones one by one, all cached. */
export declare function getBlobs(repo: string, hashes: string[], onProgress?: (done: number) => void): Promise<Map<string, Buffer>>;
/**
 * Every file under root (within sparse), walked one level per request: the client never says
 * what it has, it asks for the trees it walks into (Scion's negotiation).
 */
export declare function listFiles(repo: string, root: string, sparse: string[] | null): Promise<Map<string, {
    h: string;
    m: string;
    size: number;
}>>;
export declare function removeFileAt(root: string, p: string): void;
export interface LocalFile {
    h: string;
    m: string;
    s: number;
    t: number;
}
/** The working files within the sparse set, hashed (unchanged ones skipped by size and mtime). */
export declare function scanWorking(root: string, c: Checkout): Map<string, LocalFile>;
export interface Changes {
    added: string[];
    modified: string[];
    deleted: string[];
}
export declare function changesOf(c: Checkout, local: Map<string, LocalFile>): Changes;
/** Make an existing folder the checkout of an empty repository: its files become the first commit. */
export declare function initHere(repo: string, dir: string): Promise<Checkout>;
/** Point a fresh checkout at a branch's tip and write its files. */
export declare function clone(repo: string, dir: string, branch: string | undefined, sparse: string[] | null, onProgress?: (msg: string) => void): Promise<Checkout>;
export interface SyncResult {
    from: string;
    to: string;
    updated: string[];
    removed: string[];
    merged?: string[];
    conflicts?: Conflict[];
}
/**
 * Bring the files to the branch's tip (or another branch: switching). Local changes are kept.
 * A file changed here and on the branch is merged here line by line, as the server merges:
 * what both changed differently is written between conflict markers for a person to choose,
 * and listed in the result (and in status until the next commit).
 */
export declare function sync(root: string, c: Checkout, toBranch?: string): Promise<SyncResult>;
/** Refuse what would move this checkout's base while commits wait to be pushed. */
export declare function needNoPending(c: Checkout): void;
export interface LocalCommitResult {
    branch: string;
    files: number;
    pending: number;
}
/** Record a commit of the changed files (all, or those under paths) here; push sends it. */
export declare function commitLocal(root: string, c: Checkout, message: string, paths: string[], newBranch?: string, force?: boolean): LocalCommitResult;
/** Turn the commits not pushed back into changes in the files (their messages are dropped). */
export declare function uncommit(root: string, c: Checkout): number;
export interface PushResult {
    pushed: boolean;
    shas: string[];
    sha: string;
    branch: string;
    uploaded: number;
    sync: SyncResult;
    messages?: string[];
}
/** Send the commits not pushed: one branch move; then bring in others' commits if there were any. */
export declare function push(root: string, c: Checkout): Promise<PushResult>;
export interface CommitResult {
    sha: string;
    branch: string;
    uploaded: number;
    files: number;
    sync: SyncResult;
}
/**
 * Commit the changed files (all, or those under paths) on the server, then sync to the result:
 * if the branch had moved, the server put the change on top and the new tip has both.
 */
export declare function commit(root: string, c: Checkout, message: string, paths: string[], newBranch?: string): Promise<CommitResult>;
/** Line diff (Myers), for `lizard git diff`. */
export declare function unifiedDiff(a: string, b: string, path: string, context?: number): string;
export {};
