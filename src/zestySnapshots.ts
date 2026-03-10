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

const SNAPSHOT_ROOT = '/_zesty/rollbacks';

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
    const parsed = JSON.parse(code) as ZestyRollbackSnapshotPayload;
    if (parsed?.kind !== 'zesty-webengine-rollback-snapshot') {
      return undefined;
    }
    if (parsed?.schemaVersion !== 1) {
      return undefined;
    }
    if (typeof parsed?.snapshot?.code !== 'string') {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
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
