export class CacheDataIntegrityError extends Error {
  readonly code = "CACHE_DATA_INTEGRITY";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CacheDataIntegrityError";
  }
}

export class UnsupportedCacheSchemaVersionError extends Error {
  constructor(
    readonly currentVersion: number,
    readonly supportedVersion: number,
  ) {
    super(
      `Cache schema version ${currentVersion} is newer than supported version ${supportedVersion}`,
    );
    this.name = "UnsupportedCacheSchemaVersionError";
  }
}
