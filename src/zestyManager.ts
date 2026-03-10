export type ZestyManagerResourceType = 'views' | 'stylesheets' | 'scripts';

export interface ZestyManagerLinkInput {
  instanceZuid: string;
  resourceType: ZestyManagerResourceType;
  fileZuid: string;
}

export function buildZestyManagerUrl(input: ZestyManagerLinkInput): string {
  return `https://${encodeURIComponent(input.instanceZuid)}.manager.zesty.io/code/file/${encodeURIComponent(
    input.resourceType
  )}/${encodeURIComponent(input.fileZuid)}`;
}
