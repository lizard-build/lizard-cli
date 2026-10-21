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
 * `commit` sends what changed: the server is asked which contents it lacks, those are
 * uploaded, then one request makes the commit on the branch. If the branch moved since base,
 * the server places the change on the new tip (merging the same files line by line); only a
 * real conflict comes back.
 */
export declare const STATE_DIR = ".lizard-git";
export interface FileState {
    h: string;
    m: string;
    s?: number;
    t?: number;
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
}
/**
 * Bring the files to the branch's tip (or another branch: switching). Local changes are kept;
 * if the tip changed the same files, nothing is touched and the conflict comes back: commit
 * first, and the server merges.
 */
export declare function sync(root: string, c: Checkout, toBranch?: string): Promise<SyncResult>;
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
