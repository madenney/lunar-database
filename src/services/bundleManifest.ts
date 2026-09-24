/**
 * Manifest written into every export bundle, next to the .slpz files. It lets a
 * client (Clipper) recognise replays it already has across overlapping bundles:
 * entry filenames are per-bundle, but replayId and fileHash are stable.
 *
 * Part of the database -> Clipper contract (see packages/contracts/README.md).
 * Keep this file import-free so the root contract test can load it.
 */
export const BUNDLE_MANIFEST_NAME = "lunar-manifest.json";
export const BUNDLE_MANIFEST_VERSION = 1;

export type BundleManifest = {
  version: typeof BUNDLE_MANIFEST_VERSION;
  replays: {
    /** Entry name inside the zip, e.g. "12_Game_20240101T000000.slpz". */
    file: string;
    /** Database replay _id. */
    replayId: string;
    /** Content hash of the original .slp (the database's fileHash). */
    fileHash: string;
  }[];
};
