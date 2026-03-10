"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildZestyManagerUrl = void 0;
function buildZestyManagerUrl(input) {
    return `https://${encodeURIComponent(input.instanceZuid)}.manager.zesty.io/code/file/${encodeURIComponent(input.resourceType)}/${encodeURIComponent(input.fileZuid)}`;
}
exports.buildZestyManagerUrl = buildZestyManagerUrl;
//# sourceMappingURL=zestyManager.js.map