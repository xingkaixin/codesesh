export class CacheDataIntegrityError extends Error {
  readonly code = "CACHE_DATA_INTEGRITY";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CacheDataIntegrityError";
  }
}
