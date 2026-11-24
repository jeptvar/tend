/** The files in a package's tarball, by their path inside it. */
export function readTarball(tarball: Buffer): Map<string, Buffer>;

/** Starts a registry with these tarballs in it, all published at that moment. */
export function startRegistry(options: {
  tarballs: string[];
  publishedAt: number;
  /** Where it gets everything else. */
  upstream?: string;
}): Promise<{ url: string; close(): Promise<void> }>;
