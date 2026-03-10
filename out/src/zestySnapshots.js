"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseRollbackSnapshotArchive = exports.parseRollbackSnapshotPayload = exports.isRollbackSnapshotPath = exports.buildRollbackSnapshotPrefix = exports.buildRollbackSnapshotFileName = exports.buildRollbackSnapshotArchiveFileName = void 0;
const SNAPSHOT_ROOT = '/_zesty/rollbacks';
function buildRollbackSnapshotArchiveFileName(resourceType, relativePath) {
    return `${SNAPSHOT_ROOT}/${resourceType}/${encodePathSegment(relativePath)}.json`;
}
exports.buildRollbackSnapshotArchiveFileName = buildRollbackSnapshotArchiveFileName;
function buildRollbackSnapshotFileName(resourceType, relativePath, createdAt, snapshotName) {
    const namePart = snapshotName ? `${slugifySnapshotName(snapshotName)}--` : '';
    return `${buildRollbackSnapshotPrefix(resourceType, relativePath)}${namePart}${encodeTimestamp(createdAt)}.json`;
}
exports.buildRollbackSnapshotFileName = buildRollbackSnapshotFileName;
function buildRollbackSnapshotPrefix(resourceType, relativePath) {
    return `${SNAPSHOT_ROOT}/${resourceType}/${encodePathSegment(relativePath)}/`;
}
exports.buildRollbackSnapshotPrefix = buildRollbackSnapshotPrefix;
function isRollbackSnapshotPath(fileName) {
    return fileName.startsWith(`${SNAPSHOT_ROOT}/`);
}
exports.isRollbackSnapshotPath = isRollbackSnapshotPath;
function parseRollbackSnapshotPayload(code) {
    try {
        return coerceRollbackSnapshotPayload(JSON.parse(code));
    }
    catch {
        return undefined;
    }
}
exports.parseRollbackSnapshotPayload = parseRollbackSnapshotPayload;
function parseRollbackSnapshotArchive(code) {
    try {
        const parsed = JSON.parse(code);
        if (Array.isArray(parsed)) {
            const snapshots = parsed
                .map((entry) => coerceRollbackSnapshotPayload(entry))
                .filter((entry) => Boolean(entry));
            return snapshots;
        }
        const single = coerceRollbackSnapshotPayload(parsed);
        return single ? [single] : undefined;
    }
    catch {
        return undefined;
    }
}
exports.parseRollbackSnapshotArchive = parseRollbackSnapshotArchive;
function coerceRollbackSnapshotPayload(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    const parsed = value;
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
function encodePathSegment(value) {
    return Buffer.from(value, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}
function encodeTimestamp(value) {
    return value.replace(/[^0-9A-Za-z_-]+/g, '-');
}
function slugifySnapshotName(value) {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
}
//# sourceMappingURL=zestySnapshots.js.map