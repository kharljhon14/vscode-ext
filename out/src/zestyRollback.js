"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildRollbackVersionEndpointCandidates = exports.extractRollbackVersionCode = void 0;
function extractRollbackVersionCode(payload) {
    if (!payload || typeof payload !== 'object') {
        return undefined;
    }
    const record = payload;
    const direct = record['code'];
    if (typeof direct === 'string') {
        return direct;
    }
    const data = record['data'];
    if (data && typeof data === 'object' && !Array.isArray(data)) {
        const nested = data['code'];
        if (typeof nested === 'string') {
            return nested;
        }
    }
    return undefined;
}
exports.extractRollbackVersionCode = extractRollbackVersionCode;
function buildRollbackVersionEndpointCandidates(resourceType, fileZuid, versionEntry) {
    const values = new Set();
    const identifierKeys = ['ZUID', 'zuid', 'versionZUID', 'version_zuid', 'versionZuid', 'id'];
    for (const key of identifierKeys) {
        const value = versionEntry[key];
        if (typeof value === 'string' && value.trim()) {
            values.add(value.trim());
        }
    }
    const versionNumber = versionEntry['version'] ?? versionEntry['version_num'] ?? versionEntry['versionNumber'];
    if (typeof versionNumber === 'number' && Number.isFinite(versionNumber)) {
        values.add(String(versionNumber));
    }
    if (typeof versionNumber === 'string' && versionNumber.trim()) {
        values.add(versionNumber.trim());
    }
    const hrefKeys = ['href', 'url', 'uri'];
    for (const key of hrefKeys) {
        const value = versionEntry[key];
        if (typeof value === 'string' && value.includes('/versions/')) {
            values.add(value.trim());
        }
    }
    const candidates = [];
    for (const value of values) {
        if (value.startsWith('http://') || value.startsWith('https://')) {
            try {
                const url = new URL(value);
                const pathname = url.pathname.startsWith('/v1') ? url.pathname.slice(3) : url.pathname;
                const search = url.search || '';
                candidates.push(`${pathname}${search}`);
            }
            catch {
                continue;
            }
            continue;
        }
        if (value.startsWith('/')) {
            candidates.push(value.startsWith('/v1') ? value.slice(3) : value);
            continue;
        }
        candidates.push(`/web/${resourceType}/${encodeURIComponent(fileZuid)}/versions/${encodeURIComponent(value)}`);
    }
    return [...new Set(candidates)];
}
exports.buildRollbackVersionEndpointCandidates = buildRollbackVersionEndpointCandidates;
//# sourceMappingURL=zestyRollback.js.map