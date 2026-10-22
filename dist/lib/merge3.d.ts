/**
 * Three-way line merge, as Lizard Git's server merges (lizard-git-server internal/store/merge.go,
 * merge3): the changes each side made to base are combined; changes to different lines (even
 * neighbouring ones) merge, the same change on both sides is taken once, and only lines both
 * sides changed differently conflict. Where the server refuses, this writes both versions
 * between conflict markers, for a person to choose, as git does.
 */
export declare const MARK_OURS = "<<<<<<< yours";
export declare const MARK_SEP = "=======";
export declare const MARK_THEIRS = ">>>>>>>";
/** Lines with their line endings kept (the last one may have none). */
export declare function splitLines(s: string): string[];
interface Op {
    k: " " | "-" | "+";
    a: number;
    b: number;
}
/** Myers' diff of two line lists. */
export declare function diffLines(A: string[], B: string[]): Op[];
export interface MergeResult {
    text: string;
    conflicts: number;
}
/** Merge ours and theirs over base; conflicting regions are written with markers. */
export declare function merge3(base: string, ours: string, theirs: string, theirsLabel?: string): MergeResult;
/** Whether text still holds conflict markers (a whole marker line from merge3). */
export declare function hasConflictMarkers(text: string): boolean;
export {};
