/**
 * Discriminant carried by every persisted canonical document (Session,
 * Transcript, Settings, Artifact). Versioned independently of the package's
 * semver: bump it only on breaking shape changes to a persisted entity.
 */
export const SCHEMA_VERSION = 1;
