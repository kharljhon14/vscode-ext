"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseRollbackSnapshotPayload = exports.isRollbackSnapshotPath = exports.buildRollbackSnapshotPrefix = exports.buildRollbackSnapshotFileName = void 0;
const SNAPSHOT_ROOT = '/_zesty/rollbacks';
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
        const parsed = JSON.parse(code);
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
    }
    catch {
        return undefined;
    }
}
exports.parseRollbackSnapshotPayload = parseRollbackSnapshotPayload;
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