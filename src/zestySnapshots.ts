export type ZestySnapshotResourceType = 'views' | 'stylesheets' | 'scripts';

export interface ZestyRollbackSnapshotPayload {
  schemaVersion: 1;
  kind: 'zesty-webengine-rollback-snapshot';
  createdAt: string;
  snapshotName?: string;
  source: {
    instanceZuid: string;
    resourceType: ZestySnapshotResourceType;
    relativePath: string;
    filename: string;
    fileZuid?: string;
    currentVersion?: number;
    liveVersion?: number;
  };
  snapshot: {
    code: string;
  };
}

export type ZestyRollbackSnapshotArchive = ZestyRollbackSnapshotPayload[];

const SNAPSHOT_ROOT = '/_zesty/rollbacks';

export function buildRollbackSnapshotArchiveFileName(
  resourceType: ZestySnapshotResourceType,
  relativePath: string
): string {
  return `${SNAPSHOT_ROOT}/${resourceType}/${encodePathSegment(relativePath)}.json`;
}

export function buildRollbackSnapshotFileName(
  resourceType: ZestySnapshotResourceType,
  relativePath: string,
  createdAt: string,
  snapshotName?: string
): string {
  const namePart = snapshotName ? `${slugifySnapshotName(snapshotName)}--` : '';
  return `${buildRollbackSnapshotPrefix(resourceType, relativePath)}${namePart}${encodeTimestamp(createdAt)}.json`;
}

export function buildRollbackSnapshotPrefix(
  resourceType: ZestySnapshotResourceType,
  relativePath: string
): string {
  return `${SNAPSHOT_ROOT}/${resourceType}/${encodePathSegment(relativePath)}/`;
}

export function isRollbackSnapshotPath(fileName: string): boolean {
  return fileName.startsWith(`${SNAPSHOT_ROOT}/`);
}

export function parseRollbackSnapshotPayload(
  code: string
): ZestyRollbackSnapshotPayload | undefined {
  try {
    return coerceRollbackSnapshotPayload(JSON.parse(code));
  } catch {
    return undefined;
  }
}

export function parseRollbackSnapshotArchive(code: string): ZestyRollbackSnapshotArchive | undefined {
  try {
    const parsed = JSON.parse(code) as unknown;
    if (Array.isArray(parsed)) {
      const snapshots = parsed
        .map((entry) => coerceRollbackSnapshotPayload(entry))
        .filter((entry): entry is ZestyRollbackSnapshotPayload => Boolean(entry));
      return snapshots;
    }

    const single = coerceRollbackSnapshotPayload(parsed);
    return single ? [single] : undefined;
  } catch {
    return undefined;
  }
}

function coerceRollbackSnapshotPayload(
  value: unknown
): ZestyRollbackSnapshotPayload | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const parsed = value as ZestyRollbackSnapshotPayload;
  if (parsed.kind !== 'zesty-webengine-rollback-snapshot') {
    return undefined;
  }
  if (parsed.schemaVersion !== 1) {
    return undefined;
  }
  if (typeof parsed.snapshot?.code !== 'string') {
    return undefined;
  }
  if (typeof parsed.createdAt !== 'string' || parsed.createdAt.length === 0) {
    return undefined;
  }
  return parsed;
}

function encodePathSegment(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function encodeTimestamp(value: string): string {
  return value.replace(/[^0-9A-Za-z_-]+/g, '-');
}

function slugifySnapshotName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}
