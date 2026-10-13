import { Command } from "commander";
/**
 * A SigV4 presigned GET for one object (path style, the way the S3 gateway expects it).
 * The link works for `expiresIn` seconds without any credentials, so it is safe to hand
 * to someone who must not get the addon's keys.
 */
export declare function presignGet(o: {
    endpoint: string;
    accessKeyId: string;
    secretKey: string;
    region: string;
    bucket: string;
    key: string;
    expiresIn: number;
    now?: Date;
}): string;
export declare function registerS3(program: Command): void;
