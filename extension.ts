import * as vscode from 'vscode';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { buildZestyManagerUrl } from './src/zestyManager';
import {
  buildRollbackSnapshotArchiveFileName,
  buildRollbackSnapshotPrefix,
  parseRollbackSnapshotArchive,
  parseRollbackSnapshotPayload,
  type ZestyRollbackSnapshotPayload
} from './src/zestySnapshots';

type BlockType = 'if' | 'each';

interface ParsleySegment {
  fullText: string;
  innerRaw: string;
  fullStartOffset: number;
  fullEndOffset: number;
  innerStartOffset: number;
}

interface OffsetRange {
  start: number;
  end: number;
}

interface ArgumentSlice {
  raw: string;
  start: number;
  end: number;
}

interface AutoLayoutCall {
  argsStart: number;
  firstArg?: ArgumentSlice;
}

interface OpenBlock {
  type: BlockType;
  range: vscode.Range;
  loopAlias?: string;
}

type WebengineNodeKind = 'workspace' | 'folder' | 'file' | 'message';

interface ZestyFileRecord {
  zuid?: string;
  type?: string;
  updatedAt?: string;
  createdAt?: string;
  lastSyncedAt?: string;
}

interface ZestyConfigFile {
  instance_zuid?: string;
  instance?: {
    views?: Record<string, ZestyFileRecord>;
    styles?: Record<string, ZestyFileRecord>;
    scripts?: Record<string, ZestyFileRecord>;
  };
}

type WebengineResourceType = 'views' | 'stylesheets' | 'scripts';
type WebengineDetailsNodeKind = 'message' | 'section' | 'item';

interface WebengineFileRef {
  uri: vscode.Uri;
  workspaceFolder: vscode.WorkspaceFolder;
}

interface WebengineCommandTarget {
  uri: vscode.Uri;
  workspaceFolder: vscode.WorkspaceFolder;
}

interface ResolvedWebengineResource {
  type: WebengineResourceType;
  filename: string;
  relativePath: string;
  record?: ZestyFileRecord;
}

interface ZestyApiResult {
  ok: boolean;
  statusCode?: number;
  data?: unknown;
  error?: string;
}

interface WebengineFileDetails {
  file: WebengineFileRef;
  resource: ResolvedWebengineResource;
  instanceZuid?: string;
  tokenPresent: boolean;
  currentData?: Record<string, unknown>;
  publishedData?: Record<string, unknown>;
  versions: Array<Record<string, unknown>>;
  publishedVersions: Array<Record<string, unknown>>;
  warning?: string;
  error?: string;
}

interface WebengineRollbackContext {
  target: WebengineCommandTarget;
  resource: ResolvedWebengineResource;
  instanceZuid: string;
  token: string;
  currentVersion?: number;
  liveVersion?: number;
  versions: Array<Record<string, unknown>>;
}

interface WebengineSnapshotPickItem extends vscode.QuickPickItem {
  payload: ZestyRollbackSnapshotPayload;
  snapshotFileName: string;
  snapshotCreatedAt?: string;
  snapshotName?: string;
}

interface RollbackSnapshotViewRecord {
  snapshotZuid: string;
  snapshotFileName: string;
  snapshotType?: string;
  updatedAt?: string;
}

class WebengineTreeNode extends vscode.TreeItem {
  constructor(
    public readonly kind: WebengineNodeKind,
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly uri?: vscode.Uri,
    public readonly workspaceFolder?: vscode.WorkspaceFolder
  ) {
    super(label, collapsibleState);
  }
}

class WebengineDetailsNode extends vscode.TreeItem {
  constructor(
    public readonly kind: WebengineDetailsNodeKind,
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly children?: WebengineDetailsNode[]
  ) {
    super(label, collapsibleState);
  }
}

interface WebengineDetailsActionOptions {
  command: vscode.Command;
  iconId?: string;
  tooltip?: string;
}

class WebengineFileDetailsProvider
  implements vscode.TreeDataProvider<WebengineDetailsNode>, vscode.Disposable
{
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    WebengineDetailsNode | undefined | void
  >();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private selectedFile?: WebengineFileRef;
  private details?: WebengineFileDetails;
  private loading = false;
  private requestCounter = 0;

  constructor() {}

  dispose(): void {
    this.onDidChangeTreeDataEmitter.dispose();
  }

  async setSelection(node?: WebengineTreeNode): Promise<void> {
    if (!node || node.kind !== 'file' || !node.uri || !node.workspaceFolder) {
      this.selectedFile = undefined;
      this.details = undefined;
      this.loading = false;
      this.onDidChangeTreeDataEmitter.fire();
      return;
    }

    this.selectedFile = {
      uri: node.uri,
      workspaceFolder: node.workspaceFolder
    };
    const currentRequest = this.requestCounter + 1;
    this.requestCounter = currentRequest;
    this.loading = true;
    this.details = undefined;
    this.onDidChangeTreeDataEmitter.fire();

    const details = await this.loadDetails(this.selectedFile);
    if (this.requestCounter !== currentRequest) {
      return;
    }

    this.loading = false;
    this.details = details;
    this.onDidChangeTreeDataEmitter.fire();
  }

  async refresh(): Promise<void> {
    if (!this.selectedFile) {
      this.onDidChangeTreeDataEmitter.fire();
      return;
    }

    const currentRequest = this.requestCounter + 1;
    this.requestCounter = currentRequest;
    this.loading = true;
    this.onDidChangeTreeDataEmitter.fire();

    const details = await this.loadDetails(this.selectedFile);
    if (this.requestCounter !== currentRequest) {
      return;
    }

    this.loading = false;
    this.details = details;
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: WebengineDetailsNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: WebengineDetailsNode): Promise<WebengineDetailsNode[]> {
    if (element?.children) {
      return element.children;
    }

    if (!this.selectedFile) {
      return [this.createMessageNode('Select a file in "WebEngine Files" to view details.')];
    }

    if (this.loading) {
      return [this.createMessageNode('Loading file details from Zesty API...')];
    }

    if (!this.details) {
      return [this.createMessageNode('No details available for the selected file.')];
    }

    if (this.details.error) {
      return [this.createMessageNode(this.details.error)];
    }

    const sections: WebengineDetailsNode[] = [];
    const managerUri = this.details.resource.record?.zuid
      ? resolveWebengineManagerUri(this.selectedFile)
      : undefined;
    if (managerUri) {
      sections.push(
        this.createSectionNode('Actions', [
          this.createActionNode('Open in Zesty', {
            command: {
              command: 'zestyParsley.webengine.openInZesty',
              title: 'Open WebEngine File in Zesty',
              arguments: [this.selectedFile]
            },
            iconId: 'link-external',
            tooltip: managerUri.toString()
          })
        ])
      );
    }
    if (
      this.details.instanceZuid &&
      this.details.tokenPresent &&
      this.details.resource.record?.zuid
    ) {
      const actionSection = sections.find((section) => section.label === 'Actions');
      const snapshotActions = [
        this.createActionNode('Create Rollback Snapshot', {
          command: {
            command: 'zestyParsley.webengine.createRollbackSnapshot',
            title: 'Create Rollback Snapshot',
            arguments: [this.selectedFile]
          },
          iconId: 'archive',
          tooltip: 'Append a rollback snapshot to the file archive stored in Zesty.'
        }),
        this.createActionNode('Rollback File', {
          command: {
            command: 'zestyParsley.webengine.rollbackFile',
            title: 'Rollback WebEngine File',
            arguments: [this.selectedFile]
          },
          iconId: 'history',
          tooltip: 'Restore an earlier snapshot as a new dev version.'
        })
      ];

      if (actionSection?.children) {
        actionSection.children.push(...snapshotActions);
      } else {
        sections.push(this.createSectionNode('Actions', snapshotActions));
      }
    }

    const summaryItems: WebengineDetailsNode[] = [];
    summaryItems.push(this.createItemNode('Path', this.details.resource.relativePath));
    summaryItems.push(this.createItemNode('Type', this.details.resource.type));
    summaryItems.push(this.createItemNode('File Name', this.details.resource.filename));
    summaryItems.push(this.createItemNode('ZUID', this.details.resource.record?.zuid ?? 'Not found'));
    summaryItems.push(
      this.createItemNode('Instance ZUID', this.details.instanceZuid ?? 'Missing zesty.config.json value')
    );

    const currentVersion = readNumberLike(
      this.details.currentData,
      ['version', 'version_num', 'versionNumber', 'meta.version']
    );
    const publishedVersion = readNumberLike(
      this.details.publishedData,
      ['version', 'version_num', 'versionNumber', 'meta.version']
    );
    summaryItems.push(this.createItemNode('Current Version (Dev)', currentVersion ?? 'Unavailable'));
    summaryItems.push(this.createItemNode('Published Version (Live)', publishedVersion ?? 'Unavailable'));

    summaryItems.push(
      this.createItemNode(
        'Created At',
        readStringLike(this.details.currentData, ['createdAt', 'created_at']) ??
          readStringLike(this.details.resource.record, ['createdAt']) ??
          'Unavailable'
      )
    );
    summaryItems.push(
      this.createItemNode(
        'Updated At',
        readStringLike(this.details.currentData, ['updatedAt', 'updated_at']) ??
          readStringLike(this.details.resource.record, ['updatedAt']) ??
          'Unavailable'
      )
    );
    summaryItems.push(
      this.createItemNode('Last Synced', this.details.resource.record?.lastSyncedAt ?? 'Unavailable')
    );

    sections.push(this.createSectionNode('Summary', summaryItems));

    const liveVersion = readNumberLike(this.details.publishedData, [
      'version',
      'version_num',
      'versionNumber',
      'meta.version'
    ]);

    const publishingNodes = this.details.publishedVersions.length
      ? this.details.publishedVersions.map((entry) => {
          const version = readNumberLike(entry, ['version', 'version_num', 'versionNumber']);
          const updatedAt = readStringLike(entry, ['updatedAt', 'updated_at', 'createdAt', 'created_at']);
          const isCurrentLive = typeof version === 'number' && typeof liveVersion === 'number' && version === liveVersion;
          const label = isCurrentLive ? 'Current Live' : 'Previously Published';
          const item = this.createItemNode(
            label,
            `v${version ?? '?'}${updatedAt ? ` • ${updatedAt}` : ''}`
          );
          item.tooltip = new vscode.MarkdownString(`\`\`\`json\n${JSON.stringify(entry, null, 2)}\n\`\`\``);
          return item;
        })
      : [this.createMessageNode('No published versions found from the web file version history.')];
    sections.push(this.createSectionNode('Publishing History', publishingNodes));

    if (this.details.warning) {
      sections.push(this.createSectionNode('Notes', [this.createMessageNode(this.details.warning)]));
    }

    return sections;
  }

  private createSectionNode(label: string, children: WebengineDetailsNode[]): WebengineDetailsNode {
    const section = new WebengineDetailsNode(
      'section',
      label,
      vscode.TreeItemCollapsibleState.Expanded,
      children
    );
    section.contextValue = 'zestyWebengineDetailsSection';
    section.iconPath = new vscode.ThemeIcon('list-tree');
    return section;
  }

  private createItemNode(label: string, value: string | number): WebengineDetailsNode {
    const node = new WebengineDetailsNode(
      'item',
      `${label}: ${String(value)}`,
      vscode.TreeItemCollapsibleState.None
    );
    node.contextValue = 'zestyWebengineDetailsItem';
    node.iconPath = new vscode.ThemeIcon('circle-small-filled');
    return node;
  }

  private createActionNode(
    label: string,
    options: WebengineDetailsActionOptions
  ): WebengineDetailsNode {
    const node = new WebengineDetailsNode('item', label, vscode.TreeItemCollapsibleState.None);
    node.contextValue = 'zestyWebengineDetailsAction';
    node.command = options.command;
    node.iconPath = new vscode.ThemeIcon(options.iconId ?? 'play');
    node.tooltip = options.tooltip;
    return node;
  }

  private createMessageNode(message: string): WebengineDetailsNode {
    const node = new WebengineDetailsNode(
      'message',
      message,
      vscode.TreeItemCollapsibleState.None
    );
    node.contextValue = 'zestyWebengineDetailsMessage';
    node.iconPath = new vscode.ThemeIcon('info');
    return node;
  }

  private async loadDetails(file: WebengineFileRef): Promise<WebengineFileDetails> {
    const config = readWorkspaceZestyConfig(file.workspaceFolder);
    const resource = resolveWebengineResource(file.workspaceFolder, file.uri, config);

    if (!resource) {
      return {
        file,
        resource: {
          type: 'views',
          filename: path.basename(file.uri.fsPath),
          relativePath: path
            .relative(file.workspaceFolder.uri.fsPath, file.uri.fsPath)
            .replace(/\\/g, '/')
        },
        tokenPresent: false,
        versions: [],
        publishedVersions: [],
        error: 'Unsupported file location. Select a file under webengine/views, webengine/styles, or webengine/scripts.'
      };
    }

    const token = vscode.workspace.getConfiguration('zesty.editor').get<string>('token') ?? '';
    const instanceZuid = config?.instance_zuid;
    const details: WebengineFileDetails = {
      file,
      resource,
      instanceZuid,
      tokenPresent: token.length > 0,
      versions: [],
      publishedVersions: []
    };

    if (!resource.record?.zuid) {
      details.warning =
        'No ZUID mapping found in zesty.config.json. Run "Zesty: Sync Instance Files" first.';
      return details;
    }

    if (!instanceZuid) {
      details.warning = 'Missing `instance_zuid` in zesty.config.json.';
      return details;
    }

    if (!token) {
      details.warning = 'Missing `zesty.editor.token` setting, API details cannot be loaded.';
      return details;
    }

    const encodedZuid = encodeURIComponent(resource.record.zuid);
    const basePath = `/web/${resource.type}/${encodedZuid}`;

    const [currentResponse, liveResponse, versionsResponse] = await Promise.all([
      zestyApiGet(instanceZuid, token, basePath),
      zestyApiGet(instanceZuid, token, `${basePath}?status=live`),
      zestyApiGet(instanceZuid, token, `${basePath}/versions`)
    ]);

    if (currentResponse.ok) {
      details.currentData = asRecord(extractApiData(currentResponse.data));
    } else if (currentResponse.error) {
      details.warning = `Current file API request failed (${currentResponse.statusCode ?? 'unknown'}): ${
        currentResponse.error
      }`;
    }

    if (liveResponse.ok) {
      details.publishedData = asRecord(extractApiData(liveResponse.data));
    }

    if (versionsResponse.ok) {
      details.versions = extractApiArray(versionsResponse.data)
        .map((entry) => asRecord(entry))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
        .sort((a, b) => {
          const av = Number(readNumberLike(a, ['version', 'version_num', 'versionNumber']) ?? 0);
          const bv = Number(readNumberLike(b, ['version', 'version_num', 'versionNumber']) ?? 0);
          return bv - av;
        });
    }

    details.publishedVersions = buildPublishedVersions(details.versions, details.publishedData);

    if (!details.warning && !versionsResponse.ok && versionsResponse.statusCode) {
      details.warning = `Version history endpoint returned ${versionsResponse.statusCode}.`;
    }

    return details;
  }
}

class WebengineSidebarProvider
  implements vscode.TreeDataProvider<WebengineTreeNode>, vscode.Disposable
{
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    WebengineTreeNode | undefined | void
  >();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private readonly watcherDisposables: vscode.Disposable[] = [];
  private readonly configCache = new Map<string, { mtimeMs: number; config: ZestyConfigFile | null }>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.resetWatchers();
  }

  dispose(): void {
    this.disposeWatchers();
    this.onDidChangeTreeDataEmitter.dispose();
    this.configCache.clear();
  }

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  handleWorkspaceFoldersChanged(): void {
    this.resetWatchers();
    this.refresh();
  }

  getTreeItem(element: WebengineTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: WebengineTreeNode): Promise<WebengineTreeNode[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      return [this.createMessageNode('Open a workspace folder to view WebEngine files.')];
    }

    if (!element) {
      if (folders.length === 1) {
        return this.getWorkspaceChildren(folders[0]);
      }

      return folders
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((folder) => this.createWorkspaceNode(folder));
    }

    if (element.kind === 'workspace' && element.workspaceFolder) {
      return this.getWorkspaceChildren(element.workspaceFolder);
    }

    if (element.kind === 'folder' && element.uri && element.workspaceFolder) {
      return this.getFolderChildren(element.workspaceFolder, element.uri);
    }

    return [];
  }

  private createMessageNode(message: string): WebengineTreeNode {
    const node = new WebengineTreeNode('message', message, vscode.TreeItemCollapsibleState.None);
    node.contextValue = 'zestyWebengineMessage';
    node.iconPath = new vscode.ThemeIcon('info');
    return node;
  }

  private createWorkspaceNode(folder: vscode.WorkspaceFolder): WebengineTreeNode {
    const webengineUri = vscode.Uri.joinPath(folder.uri, 'webengine');
    const exists = this.pathExists(webengineUri.fsPath);
    const node = new WebengineTreeNode(
      'workspace',
      folder.name,
      exists ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
      webengineUri,
      folder
    );
    node.contextValue = 'zestyWebengineWorkspace';
    node.iconPath = new vscode.ThemeIcon('folder-library');
    node.description = exists ? 'webengine' : 'missing webengine/';
    node.tooltip = exists
      ? new vscode.MarkdownString(`**${folder.name}**\n\n${webengineUri.fsPath}`)
      : new vscode.MarkdownString(`**${folder.name}**\n\nNo \`webengine/\` directory found.`);
    return node;
  }

  private async getWorkspaceChildren(
    folder: vscode.WorkspaceFolder
  ): Promise<WebengineTreeNode[]> {
    const webengineUri = vscode.Uri.joinPath(folder.uri, 'webengine');
    if (!this.pathExists(webengineUri.fsPath)) {
      return [this.createMessageNode(`No webengine/ folder in ${folder.name}.`)];
    }

    return this.getFolderChildren(folder, webengineUri);
  }

  private async getFolderChildren(
    workspaceFolder: vscode.WorkspaceFolder,
    folderUri: vscode.Uri
  ): Promise<WebengineTreeNode[]> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(folderUri);
    } catch {
      return [this.createMessageNode('Unable to read this directory.')];
    }

    const directoryNodes: WebengineTreeNode[] = [];
    const fileNodes: WebengineTreeNode[] = [];

    for (const [name, fileType] of entries) {
      if (name.startsWith('.')) {
        continue;
      }

      const childUri = vscode.Uri.joinPath(folderUri, name);
      if (fileType === vscode.FileType.Directory) {
        directoryNodes.push(
          this.createFolderNode(
            name,
            childUri,
            workspaceFolder,
            vscode.TreeItemCollapsibleState.Collapsed
          )
        );
        continue;
      }

      fileNodes.push(this.createFileNode(name, childUri, workspaceFolder));
    }

    directoryNodes.sort((a, b) =>
      String(a.label ?? '').localeCompare(String(b.label ?? ''))
    );
    fileNodes.sort((a, b) => String(a.label ?? '').localeCompare(String(b.label ?? '')));

    return [...directoryNodes, ...fileNodes];
  }

  private createFolderNode(
    name: string,
    folderUri: vscode.Uri,
    workspaceFolder: vscode.WorkspaceFolder,
    collapsibleState: vscode.TreeItemCollapsibleState
  ): WebengineTreeNode {
    const node = new WebengineTreeNode(
      'folder',
      name,
      collapsibleState,
      folderUri,
      workspaceFolder
    );
    node.contextValue = 'zestyWebengineFolder';
    node.iconPath = new vscode.ThemeIcon('folder');
    return node;
  }

  private createFileNode(
    name: string,
    fileUri: vscode.Uri,
    workspaceFolder: vscode.WorkspaceFolder
  ): WebengineTreeNode {
    const node = new WebengineTreeNode(
      'file',
      name,
      vscode.TreeItemCollapsibleState.None,
      fileUri,
      workspaceFolder
    );
    node.contextValue = 'zestyWebengineFile';
    node.resourceUri = fileUri;
    node.command = {
      command: 'zestyParsley.webengine.openFile',
      title: 'Open WebEngine File',
      arguments: [node]
    };

    if (path.extname(name) === '') {
      const parsleyIconPath = this.context.asAbsolutePath(path.join('images', 'parsley-file-icon.svg'));
      node.iconPath = {
        light: parsleyIconPath,
        dark: parsleyIconPath
      };
    }

    const metadata = this.resolveConfigMetadata(workspaceFolder, fileUri);
    if (metadata) {
      node.description = metadata.zuid ?? metadata.type;
      node.tooltip = this.buildFileTooltip(workspaceFolder, fileUri, metadata);
    } else {
      node.tooltip = this.buildFileTooltip(workspaceFolder, fileUri);
    }

    return node;
  }

  private buildFileTooltip(
    workspaceFolder: vscode.WorkspaceFolder,
    fileUri: vscode.Uri,
    metadata?: ZestyFileRecord
  ): vscode.MarkdownString {
    const relative = path
      .relative(workspaceFolder.uri.fsPath, fileUri.fsPath)
      .replace(/\\/g, '/');

    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown(`**${relative}**`);
    if (metadata?.zuid) {
      markdown.appendMarkdown(`\n\nZUID: \`${metadata.zuid}\``);
    }
    if (metadata?.type) {
      markdown.appendMarkdown(`\nType: \`${metadata.type}\``);
    }
    if (metadata?.lastSyncedAt) {
      markdown.appendMarkdown(`\nLast Sync: \`${metadata.lastSyncedAt}\``);
    }
    return markdown;
  }

  private resolveConfigMetadata(
    workspaceFolder: vscode.WorkspaceFolder,
    fileUri: vscode.Uri
  ): ZestyFileRecord | undefined {
    const config = this.readZestyConfig(workspaceFolder);
    return resolveWebengineResource(workspaceFolder, fileUri, config)?.record;
  }

  private readZestyConfig(workspaceFolder: vscode.WorkspaceFolder): ZestyConfigFile | null {
    const configPath = path.join(workspaceFolder.uri.fsPath, 'zesty.config.json');
    if (!this.pathExists(configPath)) {
      this.configCache.delete(configPath);
      return null;
    }

    try {
      const stat = fs.statSync(configPath);
      const cached = this.configCache.get(configPath);
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        return cached.config;
      }

      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw) as ZestyConfigFile;
      this.configCache.set(configPath, { mtimeMs: stat.mtimeMs, config: parsed });
      return parsed;
    } catch {
      this.configCache.set(configPath, { mtimeMs: Date.now(), config: null });
      return null;
    }
  }

  private resetWatchers(): void {
    this.disposeWatchers();

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const webengineWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, 'webengine/**')
      );
      const configWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, 'zesty.config.json')
      );

      const refresh = (): void => this.refresh();
      this.watcherDisposables.push(
        webengineWatcher,
        configWatcher,
        webengineWatcher.onDidCreate(refresh),
        webengineWatcher.onDidDelete(refresh),
        webengineWatcher.onDidChange(refresh),
        configWatcher.onDidCreate(refresh),
        configWatcher.onDidDelete((uri) => {
          this.configCache.delete(uri.fsPath);
          refresh();
        }),
        configWatcher.onDidChange((uri) => {
          this.configCache.delete(uri.fsPath);
          refresh();
        })
      );
    }
  }

  private disposeWatchers(): void {
    while (this.watcherDisposables.length > 0) {
      const disposable = this.watcherDisposables.pop();
      disposable?.dispose();
    }
  }

  private pathExists(filePath: string): boolean {
    return fs.existsSync(filePath);
  }
}

function readWorkspaceZestyConfig(workspaceFolder: vscode.WorkspaceFolder): ZestyConfigFile | null {
  const configPath = path.join(workspaceFolder.uri.fsPath, 'zesty.config.json');
  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw) as ZestyConfigFile;
  } catch {
    return null;
  }
}

function resolveWebengineResource(
  workspaceFolder: vscode.WorkspaceFolder,
  fileUri: vscode.Uri,
  config?: ZestyConfigFile | null
): ResolvedWebengineResource | undefined {
  const webengineRoot = path.join(workspaceFolder.uri.fsPath, 'webengine');
  const relativeFromWebengine = path
    .relative(webengineRoot, fileUri.fsPath)
    .replace(/\\/g, '/');

  if (!relativeFromWebengine || relativeFromWebengine.startsWith('../')) {
    return undefined;
  }

  const segments = relativeFromWebengine.split('/');
  const bucket = segments.shift();
  if (!bucket || segments.length === 0) {
    return undefined;
  }

  const filename = segments.join('/');
  const relativePath = path
    .relative(workspaceFolder.uri.fsPath, fileUri.fsPath)
    .replace(/\\/g, '/');
  let resourceType: WebengineResourceType;
  let record: ZestyFileRecord | undefined;

  switch (bucket) {
    case 'views':
      resourceType = 'views';
      record = lookupWebengineRecord(config?.instance?.views, filename, true);
      break;
    case 'styles':
      resourceType = 'stylesheets';
      record = lookupWebengineRecord(config?.instance?.styles, filename, false);
      break;
    case 'scripts':
      resourceType = 'scripts';
      record = lookupWebengineRecord(config?.instance?.scripts, filename, false);
      break;
    default:
      return undefined;
  }

  return {
    type: resourceType,
    filename,
    relativePath,
    record
  };
}

function lookupWebengineRecord(
  records: Record<string, ZestyFileRecord> | undefined,
  filename: string,
  isView: boolean
): ZestyFileRecord | undefined {
  if (!records) {
    return undefined;
  }

  if (isView) {
    const ext = path.extname(filename).replace('.', '') || undefined;
    const excludeExtList = new Set(['css', 'sass', 'less', 'scss', 'js', undefined]);
    const lookupName = ext && !excludeExtList.has(ext) ? `/${filename}` : filename;
    return records[lookupName] ?? records[filename];
  }

  return records[filename];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function extractApiData(payload: unknown): unknown {
  const root = asRecord(payload);
  if (!root) {
    return payload;
  }

  if (Object.prototype.hasOwnProperty.call(root, 'data')) {
    return root['data'];
  }

  return payload;
}

function extractApiArray(payload: unknown): unknown[] {
  const directData = extractApiData(payload);
  if (Array.isArray(directData)) {
    return directData;
  }

  const record = asRecord(directData);
  if (!record) {
    return [];
  }

  const nested = record['data'];
  return Array.isArray(nested) ? nested : [];
}

function readPathValue(source: unknown, dottedPath: string): unknown {
  if (!source || typeof source !== 'object') {
    return undefined;
  }

  const segments = dottedPath.split('.');
  let current: unknown = source;

  for (const segment of segments) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    const record = current as Record<string, unknown>;
    current = record[segment];
  }

  return current;
}

function readStringLike(source: unknown, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = readPathValue(source, key);
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function readNumberLike(source: unknown, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = readPathValue(source, key);
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function buildPublishedVersions(
  versions: Array<Record<string, unknown>>,
  liveData?: Record<string, unknown>
): Array<Record<string, unknown>> {
  const publishedByVersion = new Map<number, Record<string, unknown>>();
  const liveVersion = readNumberLike(liveData, ['version', 'version_num', 'versionNumber', 'meta.version']);

  for (const versionEntry of versions) {
    const version = readNumberLike(versionEntry, ['version', 'version_num', 'versionNumber']);
    if (typeof version !== 'number') {
      continue;
    }

    const status = readStringLike(versionEntry, ['status'])?.toLowerCase();
    const hasPublishedStatus =
      status === 'live' || status === 'published' || status === 'production' || status === 'active';
    const hasPublishedFlag = readBooleanLike(versionEntry, ['published', 'is_published', 'isPublished']) === true;
    const isCurrentLive = typeof liveVersion === 'number' && version === liveVersion;

    if (!hasPublishedStatus && !hasPublishedFlag && !isCurrentLive) {
      continue;
    }

    if (!publishedByVersion.has(version)) {
      publishedByVersion.set(version, versionEntry);
    }
  }

  if (typeof liveVersion === 'number' && !publishedByVersion.has(liveVersion)) {
    publishedByVersion.set(liveVersion, {
      version: liveVersion,
      status: 'live',
      updatedAt: readStringLike(liveData, ['updatedAt', 'updated_at', 'createdAt', 'created_at'])
    });
  }

  return [...publishedByVersion.entries()]
    .sort((a, b) => b[0] - a[0])
    .map((entry) => entry[1]);
}

function readBooleanLike(source: unknown, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = readPathValue(source, key);
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      if (value.toLowerCase() === 'true') {
        return true;
      }
      if (value.toLowerCase() === 'false') {
        return false;
      }
    }
  }
  return undefined;
}

function zestyApiGet(instanceZuid: string, token: string, endpointPath: string): Promise<ZestyApiResult> {
  return zestyApiRequest(instanceZuid, token, 'GET', endpointPath);
}

function zestyApiRequest(
  instanceZuid: string,
  token: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  endpointPath: string,
  payload?: unknown
): Promise<ZestyApiResult> {
  return new Promise((resolve) => {
    const request = https.request(
      {
        protocol: 'https:',
        hostname: `${instanceZuid}.api.zesty.io`,
        path: `/v1${endpointPath}`,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = rawBody;
          if (rawBody) {
            try {
              parsed = JSON.parse(rawBody);
            } catch {
              parsed = rawBody;
            }
          }

          const statusCode = response.statusCode;
          if (typeof statusCode !== 'number') {
            resolve({ ok: false, error: 'No status code returned from API.' });
            return;
          }

          if (statusCode >= 200 && statusCode < 300) {
            resolve({ ok: true, statusCode, data: parsed });
            return;
          }

          const parsedRecord = asRecord(parsed);
          const errorMessage =
            readStringLike(parsedRecord, ['message', 'error']) ??
            `HTTP ${statusCode}`;
          resolve({ ok: false, statusCode, data: parsed, error: errorMessage });
        });
      }
    );

    request.on('error', (error) => {
      resolve({ ok: false, error: error.message });
    });
    if (typeof payload !== 'undefined' && method !== 'GET') {
      request.write(JSON.stringify(payload));
    }
    request.end();
  });
}

const PARSLEY_LANGUAGE_ID = 'parsley';
const SUPPORTED_LANGUAGE_IDS = new Set<string>([PARSLEY_LANGUAGE_ID, 'html']);
const ROOT_OBJECT_FIELDS: Record<string, string[]> = {
  this: [
    'title',
    'content',
    'meta_title',
    'meta_description',
    'url',
    'zuid',
    'parent_zuid',
    'created_at',
    'updated_at'
  ],
  meta: ['title', 'description', 'keywords', 'image', 'canonical_url'],
  page: ['title', 'url', 'path_part', 'code', 'zuid'],
  globals: ['site_name', 'logo', 'primary_color', 'support_email', 'footer_text'],
  navigation: ['items', 'title', 'url', 'label'],
  instance: [
    'host_env',
    'host_live',
    'host_preview',
    'host_protocol',
    'env',
    'domain',
    'cdn()',
    'date(format)',
    'searchformatted(string,limit)',
    'lorem(number)'
  ],
  site: ['current_lang', 'default_lang', 'lang_available'],
  request: ['path_part(index)', 'query_param(name)', 'queryParam(name)', 'header(name)'],
  get_var: ['start', 'end', 'lang'],
  post_var: ['id', 'slug'],
  settings: ['general', 'social', 'seo'],
  api: ['json', 'xml', 'gbi'],
  json: ['get(url)', 'post(url,payload)'],
  xml: ['get(url)', 'post(url,payload)'],
  gbi: ['search(query)']
};

const VARIABLE_DOCS: Record<string, string> = {
  'this.title': 'Returns the title field of the current content item.',
  'this.content': 'Returns the body/content field of the current content item.',
  'this.meta_title': 'Returns the SEO title for the current content item.',
  'this.meta_description': 'Returns the SEO description for the current content item.',
  'this.url': 'Returns the URL field for the current content item.',
  'this.zuid': 'Returns the unique ZUID identifier for the current content item.',
  'this.parent_zuid': 'Returns the unique parent ZUID identifier for the current content item.',
  'meta.title': 'Returns the meta title value for the current page context.',
  'meta.description': 'Returns the meta description for the current page context.',
  'meta.keywords': 'Returns the meta keywords for the current page context.',
  'meta.image': 'Returns the meta image reference for the current page context.',
  'meta.canonical_url': 'Returns the canonical URL for the current page context.',
  'page.title': 'Returns the current page title.',
  'page.url': 'Returns the current page URL.',
  'page.path_part': 'Returns a URL path segment from the current page path context.',
  'page.code': 'Returns the current page code.',
  'page.zuid': 'Returns the current page ZUID.',
  'globals.site_name': 'Returns the global site name value.',
  'globals.logo': 'Returns the global logo reference.',
  'globals.footer_text': 'Returns global footer text (if configured).',
  'navigation.items': 'Returns the active navigation item collection.',
  'instance.host_env': 'Returns the host for the current environment.',
  'instance.host_live': 'Returns the live host value.',
  'instance.host_preview': 'Returns the preview host value.',
  'instance.host_protocol': 'Returns the configured protocol (http/https).',
  'instance.env': 'Returns the current environment label.',
  'instance.domain': 'Returns the current instance domain.',
  'site.current_lang': 'Returns the currently resolved language code.',
  'site.default_lang': 'Returns the default language code for the instance.',
  'site.lang_available': 'Returns languages enabled for this instance.',
  'get_var.start': 'Returns a `start` URL query variable value.',
  'get_var.end': 'Returns an `end` URL query variable value.',
  'settings.general': 'Returns values from global settings.general fields.'
};

const ROOT_DOCS: Record<string, string> = {
  this: 'Current content item scope.',
  meta: 'Meta object for SEO and page metadata.',
  page: 'Current page context object.',
  globals: 'Global settings accessible to templates.',
  navigation: 'Navigation and menu context object.',
  instance: 'Built-in instance context and instance helper functions.',
  site: 'Multi-language and site-level metadata object.',
  request: 'Request helper object for path/query/header access.',
  get_var: 'GET/URL query variable object.',
  post_var: 'POST variable object.',
  settings: 'Instance settings object (for example: settings.general.site_protocol).',
  api: 'Remote integrations namespace (`api.json`, `api.xml`, `api.gbi`).',
  json: 'Remote JSON integration helper namespace under `api`.',
  xml: 'Remote XML integration helper namespace under `api`.',
  gbi: 'GBI integration helper namespace under `api`.'
};

const RESERVED_IDENTIFIERS = new Set<string>([
  'if',
  'each',
  'else',
  'else-if',
  'else_if',
  'include',
  'meta',
  'set_var',
  'get_var',
  'post_var',
  'api',
  'json',
  'xml',
  'gbi',
  'and',
  'or',
  'not',
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'contains',
  'where',
  'sort',
  'order',
  'by',
  'limit',
  'asc',
  'desc',
  'like',
  'filter',
  'is',
  'as',
  'true',
  'false',
  'null',
  'undefined'
]);

const PREFIXED_VARIABLE_PATTERN = /^[$@][A-Za-z_]\w*$/;
const IDENTIFIER_PATTERN = /[$@][A-Za-z_]\w*|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/g;
const PREFIXED_VARIABLE_DOC =
  'Parsley prefixed variable (`$` local/session or `@` cookie variable). Do not namespace it with `this.`.';
const AUTO_LAYOUT_ALLOWED_MODES = new Set<string>(['auto', 'stacked']);

const KEYWORD_DOCS: Record<string, string> = {
  if: 'Conditional block opener. Supports `!`, comparisons, and logical operators.',
  else: 'Fallback branch inside an open `if` block.',
  'else-if': 'Additional conditional branch inside an open `if` block.',
  each: 'Loop over a model/list. Supports `where`, `sort by`, `group by`, and `limit`.',
  include:
    'Include a snippet/view by path. Includes are processed before Parsley evaluation and can use dynamic values.',
  meta: 'Outputs metadata helper values for SEO in templates.',
  set_var: 'Assigns a variable from request/query/object values.',
  'end-if': 'Legacy closing token for `if` blocks.',
  'end-each': 'Legacy closing token for `each` blocks.'
};

const METHOD_DOCS: Record<string, string> = {
  toJSON: 'Returns the current object as JSON text.',
  json: 'Parses JSON text into a structure usable in Parsley.',
  getDate: 'Formats/parses date values from date-capable fields.',
  date: 'Formats dates using a format string (for example `date(F j, Y)`).',
  truepath: 'Returns the resolved URL path for a content item.',
  filter: 'Filters model data with a condition expression.',
  sortBy: 'Sorts an array/list by a field.',
  orderBy: 'Orders an array/list by a field and direction.',
  contains: 'Checks whether a value contains a substring/item.',
  split: 'Splits a string by delimiter.',
  join: 'Joins array values into a single string.',
  count: 'Returns item count for arrays/lists.',
  first: 'Returns the first item in a collection.',
  last: 'Returns the last item in a collection.',
  length: 'Returns the length of a string/list.',
  lower: 'Transforms text to lowercase.',
  upper: 'Transforms text to uppercase.',
  trim: 'Trims whitespace from both sides of text.',
  reverse: 'Reverses array/string order.',
  random: 'Returns a random item/value from a collection.',
  replace: 'Replaces one substring with another.',
  paragraph: 'Converts text to paragraph HTML.',
  wordCount: 'Returns the number of words in a text value.',
  autoLayout:
    'AutoLayout helper. Allowed mode values are `auto` and `stacked`.',
  urlencode: 'URL-encodes text.',
  urldecode: 'URL-decodes text.',
  html_entity_decode: 'Decodes HTML entities to text.',
  escapeForJs: 'Escapes text so it is safe in JavaScript strings.',
  cleanAndTrim: 'Cleans and trims text.',
  cleanAndLower: 'Cleans text and lowercases it.',
  htmlentities: 'Encodes text as HTML entities.',
  isJSON: 'Checks whether a string is valid JSON.',
  getImage: 'Builds an image URL with optional modifiers (width/height/crop/quality/format).',
  getMediaURL: 'Returns the media URL for a media field.',
  isPublished: 'Returns whether a content item is currently published.',
  remoteProcess: 'Sends text to a remote processor endpoint and returns transformed output.',
  cdn: 'Returns the configured instance CDN URL.',
  lorem: 'Returns lorem ipsum text by word/sentence count.',
  searchformatted: 'Returns a search-friendly formatted string.'
};

const QUALIFIED_METHOD_DOCS: Record<string, string> = {
  'instance.cdn': 'Returns the configured CDN URL for the current instance.',
  'instance.date': 'Formats dates using instance locale/time settings.',
  'instance.searchformatted':
    'Formats text for search indexing with optional length limits.',
  'instance.lorem': 'Returns lorem ipsum placeholder text.',
  'api.json.get': 'Fetches JSON from a remote endpoint.',
  'api.json.post': 'Posts JSON to a remote endpoint.',
  'api.xml.get': 'Fetches XML from a remote endpoint.',
  'api.xml.post': 'Posts XML payload to a remote endpoint.',
  'api.gbi.search': 'Runs a GBI search integration query.'
};

const COMPLETION_BASE_ITEMS: Array<{
  label: string;
  detail: string;
  documentation: string;
  kind?: vscode.CompletionItemKind;
}> = [
  {
    label: 'this.title',
    detail: 'Current content title',
    documentation: VARIABLE_DOCS['this.title']
  },
  {
    label: 'this.content',
    detail: 'Current content body',
    documentation: VARIABLE_DOCS['this.content']
  },
  {
    label: 'this.meta_title',
    detail: 'Current SEO title',
    documentation: VARIABLE_DOCS['this.meta_title']
  },
  {
    label: 'this.meta_description',
    detail: 'Current SEO description',
    documentation: VARIABLE_DOCS['this.meta_description']
  },
  {
    label: 'meta.title',
    detail: 'Meta title',
    documentation: VARIABLE_DOCS['meta.title']
  },
  {
    label: 'page.url',
    detail: 'Current page URL',
    documentation: VARIABLE_DOCS['page.url']
  },
  {
    label: 'globals.site_name',
    detail: 'Global site name',
    documentation: VARIABLE_DOCS['globals.site_name']
  },
  {
    label: 'instance.date(F j, Y)',
    detail: 'Format date with instance helper',
    documentation: QUALIFIED_METHOD_DOCS['instance.date']
  },
  {
    label: 'site.current_lang',
    detail: 'Current language code',
    documentation: VARIABLE_DOCS['site.current_lang']
  },
  {
    label: 'api.json.get(https://example.com/data.json)',
    detail: 'Remote JSON GET helper',
    documentation: QUALIFIED_METHOD_DOCS['api.json.get']
  },
  {
    label: '{{$my_var = {get_var.my_param}}}',
    detail: 'Set local Parsley variable',
    documentation:
      'Assigns a local variable. Also supported: `$_` for session variables and `@` for cookie variables.',
    kind: vscode.CompletionItemKind.Snippet
  },
  {
    label: 'this.autoLayout(auto)',
    detail: 'Parsley AutoLayout helper',
    documentation: METHOD_DOCS.autoLayout
  }
];

const METHOD_COMPLETIONS: Array<{ label: string; detail: string; documentation: string }> = [
  { label: 'toJSON()', detail: 'Serialize to JSON', documentation: METHOD_DOCS.toJSON },
  { label: 'json()', detail: 'Parse JSON', documentation: METHOD_DOCS.json },
  { label: 'getImage()', detail: 'Image URL with modifiers', documentation: METHOD_DOCS.getImage },
  { label: 'getMediaURL()', detail: 'Media URL helper', documentation: METHOD_DOCS.getMediaURL },
  { label: 'date(F j, Y)', detail: 'Date formatter', documentation: METHOD_DOCS.date },
  { label: 'getDate(F j, Y)', detail: 'Date getter/formatter', documentation: METHOD_DOCS.getDate },
  { label: 'truepath()', detail: 'Resolve true path', documentation: METHOD_DOCS.truepath },
  { label: 'isPublished()', detail: 'Published status check', documentation: METHOD_DOCS.isPublished },
  { label: 'filter(condition)', detail: 'Filter model data', documentation: METHOD_DOCS.filter },
  { label: 'sortBy(field)', detail: 'Sort by field', documentation: METHOD_DOCS.sortBy },
  { label: 'orderBy(field, desc)', detail: 'Order by field', documentation: METHOD_DOCS.orderBy },
  { label: 'contains(value)', detail: 'Contains check', documentation: METHOD_DOCS.contains },
  { label: 'split(",")', detail: 'Split string', documentation: METHOD_DOCS.split },
  { label: 'join(", ")', detail: 'Join list', documentation: METHOD_DOCS.join },
  { label: 'count()', detail: 'Count items', documentation: METHOD_DOCS.count },
  { label: 'length()', detail: 'Length helper', documentation: METHOD_DOCS.length },
  { label: 'first()', detail: 'First item', documentation: METHOD_DOCS.first },
  { label: 'last()', detail: 'Last item', documentation: METHOD_DOCS.last },
  { label: 'lower()', detail: 'Lowercase', documentation: METHOD_DOCS.lower },
  { label: 'upper()', detail: 'Uppercase', documentation: METHOD_DOCS.upper },
  { label: 'trim()', detail: 'Trim text', documentation: METHOD_DOCS.trim },
  { label: 'replace("a","b")', detail: 'Replace text', documentation: METHOD_DOCS.replace },
  { label: 'escapeForJs()', detail: 'Escape for JS', documentation: METHOD_DOCS.escapeForJs },
  {
    label: 'html_entity_decode()',
    detail: 'Decode HTML entities',
    documentation: METHOD_DOCS.html_entity_decode
  },
  { label: 'urlencode()', detail: 'URL encode', documentation: METHOD_DOCS.urlencode },
  { label: 'urldecode()', detail: 'URL decode', documentation: METHOD_DOCS.urldecode },
  { label: 'wordCount()', detail: 'Word count', documentation: METHOD_DOCS.wordCount },
  { label: 'paragraph()', detail: 'Paragraph helper', documentation: METHOD_DOCS.paragraph },
  { label: 'autoLayout(auto)', detail: 'AutoLayout helper (auto mode)', documentation: METHOD_DOCS.autoLayout },
  { label: 'autoLayout(stacked)', detail: 'AutoLayout helper (stacked mode)', documentation: METHOD_DOCS.autoLayout },
  { label: 'isJSON()', detail: 'Validate JSON', documentation: METHOD_DOCS.isJSON },
  {
    label: 'remoteProcess("https://...")',
    detail: 'Remote text processor',
    documentation: METHOD_DOCS.remoteProcess
  }
];

const PARSLEY_SELECTOR: vscode.DocumentSelector = [
  { language: PARSLEY_LANGUAGE_ID, scheme: 'file' },
  { language: PARSLEY_LANGUAGE_ID, scheme: 'untitled' },
  { language: 'html', scheme: 'file' },
  { language: 'html', scheme: 'untitled' },
  { language: 'plaintext', scheme: 'file' }
];

let autoCloseInProgress = false;

export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection('zesty-parsley');
  const pendingValidation = new Map<string, NodeJS.Timeout>();
  const webengineSidebarProvider = new WebengineSidebarProvider(context);
  const webengineFileDetailsProvider = new WebengineFileDetailsProvider();
  const webengineTreeView = vscode.window.createTreeView('zestyWebengineFiles', {
    treeDataProvider: webengineSidebarProvider,
    showCollapseAll: true
  });

  context.subscriptions.push(
    diagnostics,
    webengineSidebarProvider,
    webengineFileDetailsProvider,
    webengineTreeView,
    vscode.window.registerTreeDataProvider('zestyWebengineFileDetails', webengineFileDetailsProvider),
    webengineTreeView.onDidChangeSelection((event) => {
      const selectedFileNode = event.selection.find((item) => item.kind === 'file');
      void webengineFileDetailsProvider.setSelection(selectedFileNode);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      webengineSidebarProvider.handleWorkspaceFoldersChanged();
      void webengineFileDetailsProvider.refresh();
    })
  );
  void activateLegacyFileCommands(context);

  const runValidation = (document: vscode.TextDocument): vscode.Diagnostic[] => {
    if (!isSupportedDocument(document)) {
      return [];
    }

    if (!shouldValidateDocument(document)) {
      diagnostics.delete(document.uri);
      return [];
    }

    const items = collectDiagnostics(document);
    diagnostics.set(document.uri, items);
    return items;
  };

  const scheduleValidation = (document: vscode.TextDocument): void => {
    if (!isSupportedDocument(document)) {
      return;
    }

    const uriKey = document.uri.toString();
    const current = pendingValidation.get(uriKey);
    if (current) {
      clearTimeout(current);
    }

    const handle = setTimeout(() => {
      pendingValidation.delete(uriKey);
      runValidation(document);
    }, 180);

    pendingValidation.set(uriKey, handle);
  };

  if (vscode.window.activeTextEditor) {
    runValidation(vscode.window.activeTextEditor.document);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => runValidation(document)),
    vscode.workspace.onDidSaveTextDocument((document) => runValidation(document)),
    vscode.workspace.onDidCloseTextDocument((document) => diagnostics.delete(document.uri)),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const validateOnType = vscode.workspace
        .getConfiguration('zestyParsley')
        .get<boolean>('validateOnType', true);

      if (validateOnType) {
        scheduleValidation(event.document);
      }

      maybeAutoCloseBlock(event);
    })
  );

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      PARSLEY_SELECTOR,
      createCompletionProvider(),
      '.',
      '{'
    ),
    vscode.languages.registerHoverProvider(PARSLEY_SELECTOR, createHoverProvider()),
    vscode.languages.registerDocumentFormattingEditProvider(
      PARSLEY_LANGUAGE_ID,
      createFormattingProvider()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('zestyParsley.validateTemplate', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        await vscode.window.showWarningMessage('Open a Parsley template or HTML file to validate.');
        return;
      }

      const document = editor.document;
      if (!isSupportedDocument(document)) {
        await vscode.window.showWarningMessage(
          'This file type is not supported by Zesty Parsley Tools.'
        );
        return;
      }

      if (!shouldValidateDocument(document)) {
        diagnostics.delete(document.uri);
        await vscode.window.showInformationMessage(
          'No Parsley syntax detected in this document. Validation skipped.'
        );
        return;
      }

      const result = runValidation(document);
      if (result.length === 0) {
        await vscode.window.showInformationMessage('Parsley validation passed with no issues.');
      } else {
        await vscode.window.showWarningMessage(
          `Parsley validation found ${result.length} issue${result.length === 1 ? '' : 's'}.`
        );
      }
    }),
    vscode.commands.registerCommand('zestyParsley.webengine.refresh', () => {
      webengineSidebarProvider.refresh();
      void webengineFileDetailsProvider.refresh();
    }),
    vscode.commands.registerCommand('zestyParsley.webengine.refreshDetails', () => {
      void webengineFileDetailsProvider.refresh();
    }),
    vscode.commands.registerCommand(
      'zestyParsley.webengine.openFile',
      async (node?: WebengineTreeNode) => {
        await openWebengineFileLocally(node);
      }
    ),
    vscode.commands.registerCommand(
      'zestyParsley.webengine.openInZesty',
      async (node?: WebengineTreeNode) => {
        await openWebengineFileInZesty(node, false);
      }
    ),
    vscode.commands.registerCommand(
      'zestyParsley.webengine.createRollbackSnapshot',
      async (node?: WebengineTreeNode | WebengineFileRef | vscode.Uri) => {
        await createRollbackSnapshot(node);
      }
    ),
    vscode.commands.registerCommand(
      'zestyParsley.webengine.rollbackFile',
      async (node?: WebengineTreeNode | WebengineFileRef | vscode.Uri) => {
        await rollbackWebengineFile(node);
      }
    ),
    vscode.commands.registerCommand(
      'zestyParsley.webengine.syncFile',
      async (node?: WebengineTreeNode) => {
        const targetUri = resolveWebengineCommandUri(node);
        if (!targetUri) {
          await vscode.window.showWarningMessage('No WebEngine file selected to sync.');
          return;
        }
        await vscode.commands.executeCommand('zesty-vscode-extension.syncFile', targetUri);
      }
    ),
    vscode.commands.registerCommand(
      'zestyParsley.webengine.pullFile',
      async (node?: WebengineTreeNode) => {
        const targetUri = resolveWebengineCommandUri(node);
        if (!targetUri) {
          await vscode.window.showWarningMessage('No WebEngine file selected to pull.');
          return;
        }
        await vscode.commands.executeCommand('zesty-vscode-extension.pullFile', targetUri);
      }
    ),
    vscode.commands.registerCommand(
      'zestyParsley.webengine.pullPublishedFile',
      async (node?: WebengineTreeNode) => {
        const targetUri = resolveWebengineCommandUri(node);
        if (!targetUri) {
          await vscode.window.showWarningMessage('No WebEngine file selected to pull published.');
          return;
        }
        await vscode.commands.executeCommand(
          'zesty-vscode-extension.pullPublishedFile',
          targetUri
        );
      }
    ),
    vscode.commands.registerCommand(
      'zestyParsley.webengine.publishFile',
      async (node?: WebengineTreeNode) => {
        const targetUri = resolveWebengineCommandUri(node);
        if (!targetUri) {
          await vscode.window.showWarningMessage('No WebEngine file selected to publish.');
          return;
        }
        await vscode.commands.executeCommand('zesty-vscode-extension.publishFile', targetUri);
      }
    )
  );

  context.subscriptions.push({
    dispose: () => {
      for (const timer of pendingValidation.values()) {
        clearTimeout(timer);
      }
      pendingValidation.clear();
    }
  });
}

export function deactivate(): void {
  // No explicit teardown required.
}

function resolveWebengineCommandUri(
  node?: WebengineTreeNode | WebengineFileRef | vscode.Uri
): vscode.Uri | undefined {
  return resolveWebengineCommandTarget(node)?.uri;
}

function resolveWebengineCommandTarget(
  node?: WebengineTreeNode | WebengineFileRef | vscode.Uri
): WebengineCommandTarget | undefined {
  if (
    node &&
    typeof node === 'object' &&
    'kind' in node &&
    node.kind === 'file' &&
    node.uri &&
    node.workspaceFolder &&
    isWebengineFileUri(node.uri)
  ) {
    return {
      uri: node.uri,
      workspaceFolder: node.workspaceFolder
    };
  }

  if (
    node &&
    typeof node === 'object' &&
    'uri' in node &&
    'workspaceFolder' in node &&
    node.uri instanceof vscode.Uri &&
    node.workspaceFolder
  ) {
    return {
      uri: node.uri,
      workspaceFolder: node.workspaceFolder
    };
  }

  if (node instanceof vscode.Uri && isWebengineFileUri(node)) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(node);
    if (!workspaceFolder) {
      return undefined;
    }

    return {
      uri: node,
      workspaceFolder
    };
  }

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (!activeUri || !isWebengineFileUri(activeUri)) {
    return undefined;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(activeUri);
  if (!workspaceFolder) {
    return undefined;
  }

  return {
    uri: activeUri,
    workspaceFolder
  };
}

async function openWebengineFileLocally(
  node?: WebengineTreeNode | WebengineFileRef | vscode.Uri
): Promise<void> {
  const targetUri = resolveWebengineCommandUri(node);
  if (!targetUri) {
    await vscode.window.showWarningMessage('No WebEngine file selected.');
    return;
  }

  const document = await vscode.workspace.openTextDocument(targetUri);
  await vscode.window.showTextDocument(document, { preview: false });
}

async function openWebengineFileInZesty(
  node?: WebengineTreeNode | WebengineFileRef | vscode.Uri,
  fallbackToLocal = false
): Promise<void> {
  const managerUri = resolveWebengineManagerUri(node);
  if (!managerUri) {
    if (fallbackToLocal) {
      await openWebengineFileLocally(node);
      return;
    }

    await vscode.window.showWarningMessage(
      'Unable to build a Zesty manager link for this file. Check zesty.config.json.'
    );
    return;
  }

  const opened = await vscode.env.openExternal(managerUri);
  if (!opened) {
    if (fallbackToLocal) {
      await openWebengineFileLocally(node);
      return;
    }

    await vscode.window.showWarningMessage('VS Code could not open the Zesty manager link.');
  }
}

async function rollbackWebengineFile(
  node?: WebengineTreeNode | WebengineFileRef | vscode.Uri
): Promise<void> {
  const context = await loadWebengineRollbackContext(node);
  if (!context) {
    return;
  }

  const pickItems = await loadRollbackSnapshotPickItems(context);
  if (pickItems.length === 0) {
    await vscode.window.showWarningMessage(
      'No rollback snapshots were found for this file. Create a snapshot first.'
    );
    return;
  }

  const selection = await vscode.window.showQuickPick(pickItems, {
    placeHolder: 'Select a rollback snapshot to restore back into dev'
  });
  if (!selection) {
    return;
  }

  const rollbackCode = selection.payload.snapshot.code;
  const document = await vscode.workspace.openTextDocument(context.target.uri);
  const choice = await promptRollbackAction(document, context.resource.filename, selection);
  if (!choice) {
    return;
  }

  if (choice === 'preview') {
    await showRollbackDiff(document, rollbackCode, context.resource.filename, selection.label);
    const secondChoice = await promptRollbackAction(
      document,
      context.resource.filename,
      selection,
      true
    );
    if (!secondChoice || secondChoice === 'preview') {
      return;
    }
    await applyRollbackChoice(document, rollbackCode, context.target.uri, secondChoice);
    return;
  }

  await applyRollbackChoice(document, rollbackCode, context.target.uri, choice);
}

async function createRollbackSnapshot(
  node?: WebengineTreeNode | WebengineFileRef | vscode.Uri
): Promise<void> {
  const context = await loadWebengineRollbackContext(node);
  if (!context) {
    return;
  }

  const document = await vscode.workspace.openTextDocument(context.target.uri);
  const snapshotName = await vscode.window.showInputBox({
    prompt: 'Name this rollback snapshot',
    placeHolder: 'Before hero refactor',
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value.trim()) {
        return 'Snapshot name is required.';
      }
      return undefined;
    }
  });
  if (!snapshotName?.trim()) {
    return;
  }

  const createdAt = new Date().toISOString();
  const snapshot: ZestyRollbackSnapshotPayload = {
    schemaVersion: 1 as const,
    kind: 'zesty-webengine-rollback-snapshot' as const,
    createdAt,
    snapshotName: snapshotName.trim(),
    source: {
      instanceZuid: context.instanceZuid,
      resourceType: context.resource.type,
      relativePath: context.resource.relativePath,
      filename: context.resource.filename,
      fileZuid: context.resource.record?.zuid,
      currentVersion: context.currentVersion,
      liveVersion: context.liveVersion
    },
    snapshot: {
      code: document.getText()
    }
  };

  const archiveFileName = buildRollbackSnapshotArchiveFileName(
    context.resource.type,
    context.resource.relativePath
  );
  const archiveRecord = await findRollbackSnapshotArchiveRecord(context, archiveFileName);
  const existingSnapshots = archiveRecord
    ? await loadRollbackSnapshotArchivePayload(context, archiveRecord.snapshotZuid)
    : [];
  if (archiveRecord && !existingSnapshots) {
    await vscode.window.showErrorMessage(
      'Unable to parse the existing rollback snapshot archive for this file.'
    );
    return;
  }

  const archivePayload = [...(existingSnapshots ?? []), snapshot];
  const response = archiveRecord
    ? await zestyApiRequest(
        context.instanceZuid,
        context.token,
        'PUT',
        `/web/views/${encodeURIComponent(archiveRecord.snapshotZuid)}`,
        {
          filename: archiveFileName,
          type: archiveRecord.snapshotType ?? 'ajax-json',
          code: JSON.stringify(archivePayload, null, 2)
        }
      )
    : await zestyApiRequest(context.instanceZuid, context.token, 'POST', '/web/views', {
        filename: archiveFileName,
        type: 'ajax-json',
        code: JSON.stringify(archivePayload, null, 2)
      });

  if (!response.ok) {
    await vscode.window.showErrorMessage(
      `Unable to create rollback snapshot in Zesty (${response.statusCode ?? 'unknown'}): ${
        response.error ?? 'Request failed'
      }`
    );
    return;
  }

  await vscode.window.showInformationMessage(
    `Rollback snapshot "${snapshotName.trim()}" saved to ${archiveFileName}.`
  );
}

async function applyRollbackChoice(
  document: vscode.TextDocument,
  rollbackCode: string,
  targetUri: vscode.Uri,
  action: 'rollback' | 'rollback-publish'
): Promise<void> {
  const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
  const fullRange = new vscode.Range(
    document.positionAt(0),
    document.positionAt(document.getText().length)
  );
  const updated = await editor.edit((editBuilder) => {
    editBuilder.replace(fullRange, rollbackCode);
  });
  if (!updated) {
    await vscode.window.showErrorMessage('Unable to update the local file for rollback.');
    return;
  }

  const saved = await document.save();
  if (!saved) {
    await vscode.window.showErrorMessage('Save failed. Rollback cancelled.');
    return;
  }

  if (action === 'rollback-publish') {
    await vscode.commands.executeCommand('zesty-vscode-extension.publishFile', targetUri);
    return;
  }

  await vscode.commands.executeCommand('zesty-vscode-extension.syncFile', targetUri);
}

async function promptRollbackAction(
  document: vscode.TextDocument,
  filename: string,
  selection: Pick<vscode.QuickPickItem, 'label'>,
  afterPreview = false
): Promise<'preview' | 'rollback' | 'rollback-publish' | undefined> {
  const versionLabel = selection.label;
  const warning = document.isDirty
    ? `This will overwrite unsaved local edits in ${filename} with ${versionLabel}.`
    : `This will replace ${filename} with ${versionLabel}.`;
  const detail = afterPreview
    ? 'Restoring it creates a new dev version in Zesty. You can also publish it immediately.'
    : 'You can preview the diff first, then restore it as a new dev version in Zesty.';

  const choice = await vscode.window.showWarningMessage(
    `${warning} ${detail}`,
    { modal: true },
    'Preview Diff',
    'Rollback in Dev',
    'Rollback and Publish'
  );

  switch (choice) {
    case 'Preview Diff':
      return 'preview';
    case 'Rollback in Dev':
      return 'rollback';
    case 'Rollback and Publish':
      return 'rollback-publish';
    default:
      return undefined;
  }
}

async function showRollbackDiff(
  document: vscode.TextDocument,
  rollbackCode: string,
  filename: string,
  versionLabel: string
): Promise<void> {
  const historicalDocument = await vscode.workspace.openTextDocument({
    language: document.languageId,
    content: rollbackCode
  });
  await vscode.commands.executeCommand(
    'vscode.diff',
    historicalDocument.uri,
    document.uri,
    `Zesty: ${versionLabel} ↔ Local (${filename})`
  );
}

async function loadWebengineRollbackContext(
  node?: WebengineTreeNode | WebengineFileRef | vscode.Uri
): Promise<WebengineRollbackContext | undefined> {
  const target = resolveWebengineCommandTarget(node);
  if (!target) {
    await vscode.window.showWarningMessage('No WebEngine file selected to roll back.');
    return undefined;
  }

  const config = readWorkspaceZestyConfig(target.workspaceFolder);
  const resource = resolveWebengineResource(target.workspaceFolder, target.uri, config);
  const instanceZuid = config?.instance_zuid;
  const fileZuid = resource?.record?.zuid;
  const token = vscode.workspace.getConfiguration('zesty.editor').get<string>('token') ?? '';

  if (!resource || !instanceZuid || !fileZuid) {
    await vscode.window.showWarningMessage(
      'This file is not mapped in zesty.config.json. Run "Zesty: Sync Instance Files" first.'
    );
    return undefined;
  }

  if (!token) {
    await vscode.window.showWarningMessage('Missing `zesty.editor.token`, rollback is unavailable.');
    return undefined;
  }

  const basePath = `/web/${resource.type}/${encodeURIComponent(fileZuid)}`;
  const [currentResponse, liveResponse, versionsResponse] = await Promise.all([
    zestyApiGet(instanceZuid, token, basePath),
    zestyApiGet(instanceZuid, token, `${basePath}?status=live`),
    zestyApiGet(instanceZuid, token, `${basePath}/versions`)
  ]);

  if (!versionsResponse.ok) {
    await vscode.window.showErrorMessage(
      `Unable to load version history from Zesty (${versionsResponse.statusCode ?? 'unknown'}): ${
        versionsResponse.error ?? 'Request failed'
      }`
    );
    return undefined;
  }

  const versions = extractApiArray(versionsResponse.data)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .sort((a, b) => {
      const av = Number(readNumberLike(a, ['version', 'version_num', 'versionNumber']) ?? 0);
      const bv = Number(readNumberLike(b, ['version', 'version_num', 'versionNumber']) ?? 0);
      return bv - av;
    });

  return {
    target,
    resource,
    instanceZuid,
    token,
    currentVersion: currentResponse.ok
      ? readNumberLike(extractApiData(currentResponse.data), [
          'version',
          'version_num',
          'versionNumber',
          'meta.version'
        ])
      : undefined,
    liveVersion: liveResponse.ok
      ? readNumberLike(extractApiData(liveResponse.data), [
          'version',
          'version_num',
          'versionNumber',
          'meta.version'
        ])
      : undefined,
    versions
  };
}

async function loadRollbackSnapshotPickItems(
  context: WebengineRollbackContext
): Promise<WebengineSnapshotPickItem[]> {
  const response = await zestyApiGet(context.instanceZuid, context.token, '/web/views');
  if (!response.ok) {
    await vscode.window.showErrorMessage(
      `Unable to load rollback snapshots from Zesty (${response.statusCode ?? 'unknown'}): ${
        response.error ?? 'Request failed'
      }`
    );
    return [];
  }

  const archiveFileName = buildRollbackSnapshotArchiveFileName(
    context.resource.type,
    context.resource.relativePath
  );
  const prefix = buildRollbackSnapshotPrefix(context.resource.type, context.resource.relativePath);
  const viewRecords = extractApiArray(response.data)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => toRollbackSnapshotViewRecord(entry))
    .filter((entry): entry is RollbackSnapshotViewRecord => Boolean(entry));

  const archiveRecord = viewRecords.find((entry) => entry.snapshotFileName === archiveFileName);
  const archivedSnapshots = archiveRecord
    ? await loadRollbackSnapshotArchivePayload(context, archiveRecord.snapshotZuid)
    : [];
  if (archiveRecord && !archivedSnapshots) {
    await vscode.window.showErrorMessage(
      'Unable to read the rollback snapshot archive for this file.'
    );
    return [];
  }

  const legacySnapshotEntries = await Promise.all(
    viewRecords
      .filter(
        (entry) =>
          entry.snapshotFileName !== archiveFileName &&
          entry.snapshotFileName.startsWith(prefix)
      )
      .map(async (entry) => {
        const payload = await loadRollbackSnapshotPayload(context, entry.snapshotZuid);
        if (!payload) {
          return undefined;
        }

        return {
          payload,
          snapshotFileName: entry.snapshotFileName,
          snapshotCreatedAt: payload.createdAt ?? entry.updatedAt,
          snapshotName: payload.snapshotName
        };
      })
  );

  const archivedSnapshotEntries = (archivedSnapshots ?? []).map((payload) => ({
    payload,
    snapshotFileName: archiveFileName,
    snapshotCreatedAt: payload.createdAt,
    snapshotName: payload.snapshotName
  }));

  return [...archivedSnapshotEntries, ...legacySnapshotEntries]
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .sort((a, b) => String(b.snapshotCreatedAt ?? '').localeCompare(String(a.snapshotCreatedAt ?? '')))
    .map((entry) => ({
      label: entry.snapshotName?.trim()
        ? entry.snapshotName.trim()
        : entry.snapshotCreatedAt
          ? `Snapshot ${entry.snapshotCreatedAt}`
          : path.basename(entry.snapshotFileName),
      description: entry.snapshotCreatedAt ?? entry.snapshotFileName,
      detail: entry.snapshotName?.trim()
        ? entry.snapshotFileName
        : entry.snapshotFileName === archiveFileName
          ? 'Stored in the rollback snapshot archive'
          : 'Stored in a legacy rollback snapshot file',
      payload: entry.payload,
      snapshotFileName: entry.snapshotFileName,
      snapshotCreatedAt: entry.snapshotCreatedAt,
      snapshotName: entry.snapshotName
    }));
}

async function loadRollbackSnapshotPayload(
  context: WebengineRollbackContext,
  snapshotZuid: string
): Promise<ReturnType<typeof parseRollbackSnapshotPayload>> {
  const response = await zestyApiGet(
    context.instanceZuid,
    context.token,
    `/web/views/${encodeURIComponent(snapshotZuid)}`
  );
  if (!response.ok) {
    return undefined;
  }

  const payload = asRecord(extractApiData(response.data));
  const code = readStringLike(payload, ['code']);
  if (!code) {
    return undefined;
  }

  return parseRollbackSnapshotPayload(code);
}

async function loadRollbackSnapshotArchivePayload(
  context: WebengineRollbackContext,
  snapshotZuid: string
): Promise<ReturnType<typeof parseRollbackSnapshotArchive>> {
  const response = await zestyApiGet(
    context.instanceZuid,
    context.token,
    `/web/views/${encodeURIComponent(snapshotZuid)}`
  );
  if (!response.ok) {
    return undefined;
  }

  const payload = asRecord(extractApiData(response.data));
  const code = readStringLike(payload, ['code']);
  if (!code) {
    return undefined;
  }

  return parseRollbackSnapshotArchive(code);
}

async function findRollbackSnapshotArchiveRecord(
  context: WebengineRollbackContext,
  archiveFileName: string
): Promise<RollbackSnapshotViewRecord | undefined> {
  const response = await zestyApiGet(context.instanceZuid, context.token, '/web/views');
  if (!response.ok) {
    await vscode.window.showErrorMessage(
      `Unable to load rollback snapshots from Zesty (${response.statusCode ?? 'unknown'}): ${
        response.error ?? 'Request failed'
      }`
    );
    return undefined;
  }

  return extractApiArray(response.data)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => toRollbackSnapshotViewRecord(entry))
    .filter((entry): entry is RollbackSnapshotViewRecord => Boolean(entry))
    .find((entry) => entry.snapshotFileName === archiveFileName);
}

function toRollbackSnapshotViewRecord(
  entry: Record<string, unknown>
): RollbackSnapshotViewRecord | undefined {
  const snapshotFileName = readStringLike(entry, ['fileName', 'filename']) ?? '';
  const snapshotZuid = readStringLike(entry, ['ZUID', 'zuid']) ?? '';
  if (!snapshotFileName || !snapshotZuid) {
    return undefined;
  }

  return {
    snapshotFileName,
    snapshotZuid,
    snapshotType: readStringLike(entry, ['type']),
    updatedAt: readStringLike(entry, ['updatedAt', 'updated_at', 'createdAt', 'created_at'])
  };
}

function resolveWebengineManagerUri(
  node?: WebengineTreeNode | WebengineFileRef | vscode.Uri
): vscode.Uri | undefined {
  const target = resolveWebengineCommandTarget(node);
  if (!target) {
    return undefined;
  }

  const config = readWorkspaceZestyConfig(target.workspaceFolder);
  const resource = resolveWebengineResource(target.workspaceFolder, target.uri, config);
  const instanceZuid = config?.instance_zuid;
  const fileZuid = resource?.record?.zuid;
  if (!resource || !instanceZuid || !fileZuid) {
    return undefined;
  }

  return vscode.Uri.parse(
    buildZestyManagerUrl({
      instanceZuid,
      resourceType: resource.type,
      fileZuid
    })
  );
}

function isWebengineFileUri(uri: vscode.Uri): boolean {
  if (uri.scheme !== 'file') {
    return false;
  }

  return uri.fsPath.replace(/\\/g, '/').includes('/webengine/');
}

function createCompletionProvider(): vscode.CompletionItemProvider {
  return {
    provideCompletionItems(document, position) {
      if (!shouldValidateDocument(document)) {
        return undefined;
      }

      const context = getSegmentAtPosition(document, position);
      if (!context) {
        return undefined;
      }

      const offsetInInner = document.offsetAt(position) - context.innerStartOffset;
      const prefix = context.innerRaw.slice(0, offsetInInner);
      const items: vscode.CompletionItem[] = [];

      const rootNames = Object.keys(ROOT_OBJECT_FIELDS).join('|');
      const propertyMatch = new RegExp(`\\b(${rootNames})\\.([A-Za-z_]\\w*)?$`).exec(prefix);
      if (propertyMatch && typeof propertyMatch.index === 'number') {
        const root = propertyMatch[1];
        const typedProperty = propertyMatch[2] ?? '';
        const fields = ROOT_OBJECT_FIELDS[root] ?? [];
        const replaceRange = new vscode.Range(position.translate(0, -typedProperty.length), position);

        for (const field of fields) {
          const cleanField = field.replace(/\(.*$/, '');
          const isMethodLike = field.includes('(');
          const item = new vscode.CompletionItem(
            `${root}.${field}`,
            isMethodLike ? vscode.CompletionItemKind.Method : vscode.CompletionItemKind.Field
          );
          item.detail = `Parsley ${root} ${isMethodLike ? 'helper' : 'field'}`;
          item.documentation = new vscode.MarkdownString(
            VARIABLE_DOCS[`${root}.${cleanField}`] ??
              QUALIFIED_METHOD_DOCS[`${root}.${cleanField}`] ??
              `Returns \`${cleanField}\` from the \`${root}\` object.`
          );
          item.insertText = field;
          item.range = replaceRange;
          items.push(item);
        }

        return items;
      }

      const methodMatch = /(?:[$@]?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\.([A-Za-z_]\w*)?$/.exec(prefix);
      if (methodMatch && typeof methodMatch.index === 'number') {
        const typedMethod = methodMatch[1] ?? '';
        const replaceRange = new vscode.Range(position.translate(0, -typedMethod.length), position);

        for (const method of METHOD_COMPLETIONS) {
          const item = new vscode.CompletionItem(method.label, vscode.CompletionItemKind.Method);
          item.detail = method.detail;
          item.documentation = new vscode.MarkdownString(method.documentation);
          item.insertText = method.label;
          item.range = replaceRange;
          item.sortText = `0-${method.label}`;
          items.push(item);
        }

        return items;
      }

      for (const [root, description] of Object.entries(ROOT_DOCS)) {
        const item = new vscode.CompletionItem(`${root}.`, vscode.CompletionItemKind.Module);
        item.detail = 'Parsley object';
        item.documentation = new vscode.MarkdownString(description);
        item.insertText = `${root}.`;
        item.sortText = `0-${root}`;
        items.push(item);
      }

      for (const entry of COMPLETION_BASE_ITEMS) {
        const item = new vscode.CompletionItem(
          entry.label,
          entry.kind ?? vscode.CompletionItemKind.Variable
        );
        item.detail = entry.detail;
        item.documentation = new vscode.MarkdownString(entry.documentation);
        item.sortText = `1-${entry.label}`;
        items.push(item);
      }

      for (const [keyword, description] of Object.entries(KEYWORD_DOCS)) {
        const item = new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword);
        item.detail = 'Parsley keyword';
        item.documentation = new vscode.MarkdownString(description);
        item.sortText = `1-keyword-${keyword}`;
        items.push(item);
      }

      items.push(
        createSnippetCompletion('if', '{{if ${1:condition}}}\n  $0\n{{/if}}', 'Parsley if block'),
        createSnippetCompletion(
          'if-else-if',
          '{{if ${1:condition}}}\n  ${2}\n{{else-if ${3:condition}}}\n  ${4}\n{{else}}\n  ${5}\n{{/if}}',
          'Parsley if / else-if / else block'
        ),
        createSnippetCompletion(
          'each',
          '{{each ${1:items} as ${2:item} sort by ${3:item.created_at} limit ${4:0},${5:10}}}\n  $0\n{{/each}}',
          'Parsley each block with alias/sort/limit'
        ),
        createSnippetCompletion(
          'include',
          '{{include ${1:components/header}}}',
          'Parsley include helper'
        ),
        createSnippetCompletion(
          'set-local',
          '{{$${1:var_name} = ${2:value}}}',
          'Set a local Parsley variable'
        ),
        createSnippetCompletion(
          'set-session',
          '{{$_${1:session_name} = ${2:value}}}',
          'Set a session Parsley variable'
        ),
        createSnippetCompletion(
          'set-cookie',
          '{{@${1:cookie_name} = ${2:value}}}',
          'Set a cookie Parsley variable'
        ),
        createSnippetCompletion(
          'autolayout',
          '{{${1:this}.autoLayout(${2|auto,stacked|})}}',
          'AutoLayout with allowed modes'
        )
      );

      return items;
    }
  };
}

function createSnippetCompletion(
  label: string,
  snippet: string,
  detail: string
): vscode.CompletionItem {
  const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Snippet);
  item.detail = detail;
  item.insertText = new vscode.SnippetString(snippet);
  item.sortText = `2-${label}`;
  return item;
}

function createHoverProvider(): vscode.HoverProvider {
  return {
    provideHover(document, position) {
      if (!shouldValidateDocument(document)) {
        return undefined;
      }

      const segment = getSegmentAtPosition(document, position);
      if (!segment) {
        return undefined;
      }

      const token = getIdentifierAtOffset(
        segment.innerRaw,
        document.offsetAt(position) - segment.innerStartOffset
      );

      if (!token) {
        return undefined;
      }

      const documentation = resolveTokenDocumentation(token);

      if (!documentation) {
        return undefined;
      }

      const markdown = new vscode.MarkdownString();
      markdown.appendCodeblock(token, 'txt');
      markdown.appendMarkdown(`\n${documentation}`);

      return new vscode.Hover(markdown);
    }
  };
}

function createFormattingProvider(): vscode.DocumentFormattingEditProvider {
  return {
    provideDocumentFormattingEdits(document) {
      const indentSize = vscode.workspace
        .getConfiguration('zestyParsley')
        .get<number>('format.indentSize', 2);

      const formatted = formatParsleyDocument(document.getText(), indentSize);
      const end = document.lineAt(document.lineCount - 1).range.end;
      const fullRange = new vscode.Range(new vscode.Position(0, 0), end);

      return [vscode.TextEdit.replace(fullRange, formatted)];
    }
  };
}

function formatParsleyDocument(text: string, indentSize: number): string {
  const lines = text.split(/\r?\n/);
  const formattedLines: string[] = [];

  let indentLevel = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      formattedLines.push('');
      continue;
    }

    const isClosing = /\{\{\s*(?:\/|end[-_])(if|each)\s*\}\}/.test(trimmed);
    const isElse = /\{\{\s*else(?:\s+if|-if|_if)?\b[\s\S]*?\}\}/.test(trimmed);

    if (isClosing || isElse) {
      indentLevel = Math.max(0, indentLevel - 1);
    }

    const indentation = ' '.repeat(indentSize * indentLevel);
    formattedLines.push(`${indentation}${trimmed}`);

    const isOpening = /\{\{\s*(if|each)\b.*\}\}/.test(trimmed);
    if (isOpening || isElse) {
      indentLevel += 1;
    }
  }

  return formattedLines.join('\n');
}

function collectDiagnostics(document: vscode.TextDocument): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];
  const blocks: OpenBlock[] = [];
  const documentText = document.getText();
  const segments = getParsleySegments(documentText);
  const scriptRanges = document.languageId === 'html' ? getHtmlScriptRanges(documentText) : [];

  for (const segment of segments) {
    if (isOffsetInsideRanges(segment.fullStartOffset, scriptRanges)) {
      continue;
    }

    const trimmed = segment.innerRaw.trim();
    const segmentRange = offsetsToRange(document, segment.fullStartOffset, segment.fullEndOffset);
    const loopAliases = getActiveEachAliases(blocks);

    if (trimmed.length === 0) {
      continue;
    }

    validateAutoLayoutMode(document, segment.innerRaw, segment.innerStartOffset, diagnostics);

    if (/^if\b/.test(trimmed)) {
      blocks.push({ type: 'if', range: segmentRange });
      const prefix = /^\s*if\b/.exec(segment.innerRaw);
      if (prefix) {
        const expressionRaw = segment.innerRaw.slice(prefix[0].length);
        validateVariableUsage(
          document,
          expressionRaw,
          segment.innerStartOffset + prefix[0].length,
          diagnostics,
          loopAliases
        );
      }
      continue;
    }

    if (/^each\b/.test(trimmed)) {
      const prefix = /^\s*each\b/.exec(segment.innerRaw);
      let loopAlias: string | undefined;
      if (prefix) {
        const expressionRaw = segment.innerRaw.slice(prefix[0].length);
        loopAlias = parseEachAlias(expressionRaw);
        const aliasesForExpression = new Set(loopAliases);
        if (loopAlias) {
          aliasesForExpression.add(loopAlias);
        }
        validateVariableUsage(
          document,
          expressionRaw,
          segment.innerStartOffset + prefix[0].length,
          diagnostics,
          aliasesForExpression,
          true
        );
      }
      blocks.push({ type: 'each', range: segmentRange, loopAlias });
      continue;
    }

    if (/^else\b/.test(trimmed)) {
      const elseIfPrefix = /^\s*else(?:\s+if|-if|_if)\b/.exec(segment.innerRaw);
      if (elseIfPrefix) {
        const top = blocks[blocks.length - 1];
        if (!top || top.type !== 'if') {
          diagnostics.push(
            new vscode.Diagnostic(
              segmentRange,
              'Unexpected {{else-if}} found outside of an open {{if}} block.',
              vscode.DiagnosticSeverity.Warning
            )
          );
        } else {
          const expressionRaw = segment.innerRaw.slice(elseIfPrefix[0].length);
          validateVariableUsage(
            document,
            expressionRaw,
            segment.innerStartOffset + elseIfPrefix[0].length,
            diagnostics,
            loopAliases
          );
        }
        continue;
      }

      const top = blocks[blocks.length - 1];
      if (!top || top.type !== 'if') {
        diagnostics.push(
          new vscode.Diagnostic(
            segmentRange,
            'Unexpected {{else}} found outside of an open {{if}} block.',
            vscode.DiagnosticSeverity.Warning
          )
        );
      }
      continue;
    }

    const closing = /^(?:\/|end[-_])(if|each)\b/.exec(trimmed);
    if (closing) {
      const expected = closing[1] as BlockType;
      const top = blocks.pop();

      if (!top) {
        diagnostics.push(
          new vscode.Diagnostic(
            segmentRange,
            `Closing tag {{/${expected}}} does not have a matching opening block.`,
            vscode.DiagnosticSeverity.Warning
          )
        );
        continue;
      }

      if (top.type !== expected) {
        diagnostics.push(
          new vscode.Diagnostic(
            segmentRange,
            `Expected {{/${top.type}}} before {{/${expected}}}.`,
            vscode.DiagnosticSeverity.Warning
          )
        );
      }
      continue;
    }

    if (/^include\b/.test(trimmed)) {
      const includeArgs = segment.innerRaw.replace(/^\s*include\b/, '').trim();
      if (!includeArgs) {
        diagnostics.push(
          new vscode.Diagnostic(
            segmentRange,
            'Include syntax requires a snippet/view target (for example: {{include components/header}}).',
            vscode.DiagnosticSeverity.Warning
          )
        );
      }
      continue;
    }

    if (/^meta\b/.test(trimmed)) {
      continue;
    }

    validateVariableUsage(
      document,
      segment.innerRaw,
      segment.innerStartOffset,
      diagnostics,
      loopAliases
    );
  }

  for (const block of blocks) {
    diagnostics.push(
      new vscode.Diagnostic(
        block.range,
        `Unclosed {{${block.type}}} block. Missing {{/${block.type}}}.`,
        vscode.DiagnosticSeverity.Warning
      )
    );
  }

  return diagnostics;
}

function validateVariableUsage(
  document: vscode.TextDocument,
  expressionRaw: string,
  expressionStartOffset: number,
  diagnostics: vscode.Diagnostic[],
  allowedIdentifiers: Set<string> = new Set<string>(),
  allowBareIdentifiers = false
): void {
  const autoLayoutCalls = parseAutoLayoutCalls(expressionRaw);
  const malformedDotPath = /\b[A-Za-z_]\w*\.\.[A-Za-z_]\w*\b/g;
  for (const malformedMatch of expressionRaw.matchAll(malformedDotPath)) {
    if (typeof malformedMatch.index !== 'number') {
      continue;
    }

    const start = expressionStartOffset + malformedMatch.index;
    const end = start + malformedMatch[0].length;
    diagnostics.push(
      new vscode.Diagnostic(
        offsetsToRange(document, start, end),
        'Invalid variable usage: consecutive dots are not allowed in Parsley variables.',
        vscode.DiagnosticSeverity.Warning
      )
    );
  }

  for (const match of expressionRaw.matchAll(IDENTIFIER_PATTERN)) {
    if (typeof match.index !== 'number') {
      continue;
    }

    const token = match[0];
    const tokenStart = match.index;

    if (isInsideQuotedString(expressionRaw, tokenStart)) {
      continue;
    }

    if (isInsideBraceAccessor(expressionRaw, tokenStart)) {
      continue;
    }

    const normalizedToken = token.toLowerCase();
    if (RESERVED_IDENTIFIERS.has(normalizedToken)) {
      continue;
    }

    if (isAutoLayoutModeToken(token, tokenStart, autoLayoutCalls)) {
      continue;
    }

    if (isPrefixedVariable(token)) {
      continue;
    }

    if (allowedIdentifiers.has(token)) {
      continue;
    }

    if (isBraceAccessorRoot(expressionRaw, tokenStart, token)) {
      continue;
    }

    if (isChainedAccessorToken(expressionRaw, tokenStart)) {
      continue;
    }

    if (token.includes('.')) {
      const [root] = token.split('.');
      if (allowedIdentifiers.has(root)) {
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(ROOT_OBJECT_FIELDS, root)) {
        continue;
      }

      // Dynamic roots and model aliases are common in Parsley templates.
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(ROOT_OBJECT_FIELDS, token)) {
      continue;
    }

    if (isFunctionCallToken(expressionRaw, tokenStart, token)) {
      continue;
    }

    if (allowBareIdentifiers) {
      continue;
    }

    const start = expressionStartOffset + tokenStart;
    const end = start + token.length;

    diagnostics.push(
      new vscode.Diagnostic(
        offsetsToRange(document, start, end),
        `Invalid variable usage: "${token}" should be namespaced (for example: this.${token}).`,
        vscode.DiagnosticSeverity.Warning
      )
    );
  }
}

function validateAutoLayoutMode(
  document: vscode.TextDocument,
  expressionRaw: string,
  expressionStartOffset: number,
  diagnostics: vscode.Diagnostic[]
): void {
  const autoLayoutCalls = parseAutoLayoutCalls(expressionRaw);
  for (const call of autoLayoutCalls) {
    const firstArg = call.firstArg;
    if (!firstArg) {
      continue;
    }

    const normalized = normalizeAutoLayoutMode(firstArg.raw);
    if (normalized && AUTO_LAYOUT_ALLOWED_MODES.has(normalized.toLowerCase())) {
      continue;
    }

    const argStart = expressionStartOffset + call.argsStart + firstArg.start;
    const argEnd = expressionStartOffset + call.argsStart + firstArg.end;
    diagnostics.push(
      new vscode.Diagnostic(
        offsetsToRange(document, argStart, argEnd),
        'autoLayout(mode) only allows `auto` or `stacked` for the mode value.',
        vscode.DiagnosticSeverity.Warning
      )
    );
  }
}

function parseAutoLayoutCalls(source: string): AutoLayoutCall[] {
  const calls: AutoLayoutCall[] = [];
  const pattern = /\bautoLayout\s*\(([^)]*)\)/gi;

  for (const match of source.matchAll(pattern)) {
    if (typeof match.index !== 'number') {
      continue;
    }

    if (isInsideQuotedString(source, match.index)) {
      continue;
    }

    const fullMatch = match[0];
    const argsRaw = match[1] ?? '';
    const openParenOffset = fullMatch.indexOf('(');
    if (openParenOffset === -1) {
      continue;
    }

    const argsStart = match.index + openParenOffset + 1;
    const args = splitTopLevelArguments(argsRaw);
    const firstArg = args.length > 0 ? args[0] : undefined;
    calls.push({ argsStart, firstArg });
  }

  return calls;
}

function splitTopLevelArguments(source: string): ArgumentSlice[] {
  const args: ArgumentSlice[] = [];
  if (!source.trim()) {
    return args;
  }

  let start = 0;
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let inSingle = false;
  let inDouble = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const previous = index > 0 ? source[index - 1] : '';

    if (char === "'" && previous !== '\\' && !inDouble) {
      inSingle = !inSingle;
      continue;
    }

    if (char === '"' && previous !== '\\' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (inSingle || inDouble) {
      continue;
    }

    if (char === '(') {
      depthParen += 1;
      continue;
    }
    if (char === ')') {
      depthParen = Math.max(0, depthParen - 1);
      continue;
    }
    if (char === '{') {
      depthBrace += 1;
      continue;
    }
    if (char === '}') {
      depthBrace = Math.max(0, depthBrace - 1);
      continue;
    }
    if (char === '[') {
      depthBracket += 1;
      continue;
    }
    if (char === ']') {
      depthBracket = Math.max(0, depthBracket - 1);
      continue;
    }

    if (char === ',' && depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
      const raw = source.slice(start, index);
      const trimmedRange = getTrimmedBounds(raw);
      if (trimmedRange) {
        args.push({
          raw: raw.slice(trimmedRange.start, trimmedRange.end),
          start: start + trimmedRange.start,
          end: start + trimmedRange.end
        });
      }
      start = index + 1;
    }
  }

  const tail = source.slice(start);
  const trimmedTail = getTrimmedBounds(tail);
  if (trimmedTail) {
    args.push({
      raw: tail.slice(trimmedTail.start, trimmedTail.end),
      start: start + trimmedTail.start,
      end: start + trimmedTail.end
    });
  }

  return args;
}

function getTrimmedBounds(source: string): { start: number; end: number } | undefined {
  const start = source.search(/\S/);
  if (start === -1) {
    return undefined;
  }
  let end = source.length;
  while (end > start && /\s/.test(source[end - 1])) {
    end -= 1;
  }
  return { start, end };
}

function normalizeAutoLayoutMode(rawValue: string): string {
  let value = rawValue.trim();
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    value = value.slice(1, -1).trim();
  }

  return value;
}

function isAutoLayoutModeToken(
  token: string,
  tokenStart: number,
  autoLayoutCalls: AutoLayoutCall[]
): boolean {
  const normalizedToken = token.toLowerCase();
  if (!AUTO_LAYOUT_ALLOWED_MODES.has(normalizedToken)) {
    return false;
  }

  const tokenEnd = tokenStart + token.length;
  for (const call of autoLayoutCalls) {
    const firstArg = call.firstArg;
    if (!firstArg) {
      continue;
    }

    const argStart = call.argsStart + firstArg.start;
    const argEnd = call.argsStart + firstArg.end;
    if (tokenStart >= argStart && tokenEnd <= argEnd) {
      return true;
    }
  }

  return false;
}

function maybeAutoCloseBlock(event: vscode.TextDocumentChangeEvent): void {
  if (autoCloseInProgress) {
    return;
  }

  const autoCloseBlocks = vscode.workspace
    .getConfiguration('zestyParsley')
    .get<boolean>('autoCloseBlocks', true);

  if (!autoCloseBlocks) {
    return;
  }

  const document = event.document;
  if (!shouldValidateDocument(document)) {
    return;
  }

  if (event.contentChanges.length !== 1) {
    return;
  }

  const change = event.contentChanges[0];
  if (!change.text.includes('}')) {
    return;
  }

  const cursor = new vscode.Position(
    change.range.start.line,
    change.range.start.character + change.text.length
  );

  const lineText = document.lineAt(cursor.line).text;
  const lineBeforeCursor = lineText.slice(0, cursor.character);
  if (!lineBeforeCursor.endsWith('}}')) {
    return;
  }

  const openBlockMatch = /\{\{\s*(if|each)\b.*\}\}$/.exec(lineBeforeCursor);
  if (!openBlockMatch) {
    return;
  }

  const blockType = openBlockMatch[1] as BlockType;
  const remainder = lineText.slice(cursor.character);
  if (new RegExp(`\\{\\{\\s*(?:\\/${blockType}|end[-_]${blockType})\\s*\\}\\}`).test(remainder)) {
    return;
  }

  const editor = vscode.window.visibleTextEditors.find(
    (candidate) => candidate.document.uri.toString() === document.uri.toString()
  );

  if (!editor || !editor.selection.active.isEqual(cursor)) {
    return;
  }

  const existingTextAfterCursor = document.getText(
    new vscode.Range(cursor, document.lineAt(document.lineCount - 1).range.end)
  );

  if (
    new RegExp(`\\{\\{\\s*(?:\\/${blockType}|end[-_]${blockType})\\s*\\}\\}`).test(
      existingTextAfterCursor
    )
  ) {
    return;
  }

  const indentation = lineText.match(/^\s*/)?.[0] ?? '';
  const indentUnit = getIndentUnit(document);

  autoCloseInProgress = true;
  const snippet = new vscode.SnippetString(
    `\n${indentation}${indentUnit}$0\n${indentation}{{/${blockType}}}`
  );

  void editor.insertSnippet(snippet, cursor).then(
    () => {
      autoCloseInProgress = false;
    },
    () => {
      autoCloseInProgress = false;
    }
  );
}

function getIndentUnit(document: vscode.TextDocument): string {
  const editorConfig = vscode.workspace.getConfiguration('editor', document);
  const insertSpaces = editorConfig.get<boolean>('insertSpaces', true);
  const tabSize = editorConfig.get<number>('tabSize', 2);
  if (!insertSpaces) {
    return '\t';
  }

  return ' '.repeat(Math.max(1, tabSize));
}

function getSegmentAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position
): ParsleySegment | undefined {
  const segments = getParsleySegments(document.getText());
  const offset = document.offsetAt(position);

  return segments.find(
    (segment) => offset >= segment.innerStartOffset && offset <= segment.fullEndOffset - 2
  );
}

function getParsleySegments(text: string): ParsleySegment[] {
  const segments: ParsleySegment[] = [];
  const matcher = /\{\{([\s\S]*?)\}\}/g;

  for (const match of text.matchAll(matcher)) {
    if (typeof match.index !== 'number') {
      continue;
    }

    const fullStart = match.index;
    const fullText = match[0];
    const fullEnd = fullStart + fullText.length;

    segments.push({
      fullText,
      innerRaw: match[1],
      fullStartOffset: fullStart,
      fullEndOffset: fullEnd,
      innerStartOffset: fullStart + 2
    });
  }

  return segments;
}

function isInsideQuotedString(source: string, index: number): boolean {
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < index; i += 1) {
    const char = source[i];
    const previous = i > 0 ? source[i - 1] : '';

    if (char === "'" && previous !== '\\' && !inDouble) {
      inSingle = !inSingle;
    }

    if (char === '"' && previous !== '\\' && !inSingle) {
      inDouble = !inDouble;
    }
  }

  return inSingle || inDouble;
}

function getIdentifierAtOffset(source: string, offset: number): string | undefined {
  for (const match of source.matchAll(IDENTIFIER_PATTERN)) {
    if (typeof match.index !== 'number') {
      continue;
    }

    const start = match.index;
    const end = start + match[0].length;

    if (offset >= start && offset <= end) {
      return match[0];
    }
  }

  return undefined;
}

function inferVariableDoc(token: string): string | undefined {
  if (VARIABLE_DOCS[token]) {
    return VARIABLE_DOCS[token];
  }

  const parts = token.split('.');
  if (parts.length < 2) {
    return undefined;
  }

  const [root, field] = parts;
  if (!Object.prototype.hasOwnProperty.call(ROOT_OBJECT_FIELDS, root)) {
    return undefined;
  }

  return `Returns \`${field}\` from the \`${root}\` Parsley object.`;
}

function resolveTokenDocumentation(token: string): string | undefined {
  if (VARIABLE_DOCS[token]) {
    return VARIABLE_DOCS[token];
  }

  if (ROOT_DOCS[token]) {
    return ROOT_DOCS[token];
  }

  if (KEYWORD_DOCS[token]) {
    return KEYWORD_DOCS[token];
  }

  if (isPrefixedVariable(token)) {
    return PREFIXED_VARIABLE_DOC;
  }

  if (!token.includes('.')) {
    return METHOD_DOCS[token];
  }

  if (QUALIFIED_METHOD_DOCS[token]) {
    return QUALIFIED_METHOD_DOCS[token];
  }

  const inferred = inferVariableDoc(token);
  if (inferred) {
    return inferred;
  }

  const methodToken = token.split('.').pop();
  if (!methodToken) {
    return undefined;
  }

  return METHOD_DOCS[methodToken];
}

function isPrefixedVariable(token: string): boolean {
  return PREFIXED_VARIABLE_PATTERN.test(token);
}

function parseEachAlias(expressionRaw: string): string | undefined {
  const aliasMatch = /\bas\s+([A-Za-z_]\w*)\b/i.exec(expressionRaw);
  return aliasMatch ? aliasMatch[1] : undefined;
}

function getActiveEachAliases(blocks: OpenBlock[]): Set<string> {
  const aliases = new Set<string>();
  for (const block of blocks) {
    if (block.type === 'each' && block.loopAlias) {
      aliases.add(block.loopAlias);
    }
  }

  return aliases;
}

function isBraceAccessorRoot(source: string, tokenStart: number, token: string): boolean {
  const afterToken = source.slice(tokenStart + token.length);
  return /^\s*\.\s*\{/.test(afterToken);
}

function isChainedAccessorToken(source: string, tokenStart: number): boolean {
  const beforeToken = source.slice(0, tokenStart);
  const dotIndex = beforeToken.search(/\.\s*$/);
  if (dotIndex === -1) {
    return false;
  }

  const beforeDot = beforeToken.slice(0, dotIndex);
  const previousNonWhitespace = beforeDot.match(/\S(?=\s*$)/);
  if (!previousNonWhitespace) {
    return false;
  }

  return /[\w\]\)}]/.test(previousNonWhitespace[0]);
}

function isFunctionCallToken(source: string, tokenStart: number, token: string): boolean {
  const afterToken = source.slice(tokenStart + token.length);
  return /^\s*\(/.test(afterToken);
}

function isInsideBraceAccessor(source: string, index: number): boolean {
  let inSingle = false;
  let inDouble = false;
  let braceDepth = 0;

  for (let i = 0; i < index; i += 1) {
    const char = source[i];
    const previous = i > 0 ? source[i - 1] : '';

    if (char === "'" && previous !== '\\' && !inDouble) {
      inSingle = !inSingle;
      continue;
    }

    if (char === '"' && previous !== '\\' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (inSingle || inDouble) {
      continue;
    }

    if (char === '{') {
      braceDepth += 1;
      continue;
    }

    if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
    }
  }

  return braceDepth > 0;
}

function getHtmlScriptRanges(content: string): OffsetRange[] {
  const ranges: OffsetRange[] = [];
  const openPattern = /<script\b[^>]*>/gi;
  const closePattern = /<\/script\s*>/gi;

  for (const openMatch of content.matchAll(openPattern)) {
    if (typeof openMatch.index !== 'number') {
      continue;
    }

    const start = openMatch.index;
    const openEnd = start + openMatch[0].length;
    closePattern.lastIndex = openEnd;
    const closeMatch = closePattern.exec(content);
    const end = closeMatch ? closeMatch.index + closeMatch[0].length : content.length;
    ranges.push({ start, end });
  }

  return ranges;
}

function isOffsetInsideRanges(offset: number, ranges: OffsetRange[]): boolean {
  for (const range of ranges) {
    if (offset >= range.start && offset < range.end) {
      return true;
    }
  }

  return false;
}

async function activateLegacyFileCommands(context: vscode.ExtensionContext): Promise<void> {
  try {
    const legacyModulePath = path.join(__dirname, '..', 'src', 'extension.js');
    const legacyModule = require(legacyModulePath) as {
      activate?: (ctx: vscode.ExtensionContext) => void | Promise<void>;
    };
    if (typeof legacyModule.activate === 'function') {
      await Promise.resolve(legacyModule.activate(context));
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`Unable to activate legacy file commands: ${detail}`);
  }
}

function isSupportedDocument(document: vscode.TextDocument): boolean {
  const fileOrUntitled = document.uri.scheme === 'file' || document.uri.scheme === 'untitled';
  if (!fileOrUntitled) {
    return false;
  }

  if (SUPPORTED_LANGUAGE_IDS.has(document.languageId)) {
    return true;
  }

  return document.languageId === 'plaintext' && isWebengineExtensionlessFile(document);
}

function shouldValidateDocument(document: vscode.TextDocument): boolean {
  if (!isSupportedDocument(document)) {
    return false;
  }

  if (document.languageId === PARSLEY_LANGUAGE_ID) {
    return true;
  }

  return hasParsleySyntax(document.getText());
}

function isWebengineExtensionlessFile(document: vscode.TextDocument): boolean {
  if (document.uri.scheme !== 'file') {
    return false;
  }

  const filePath = document.uri.fsPath;
  if (!filePath) {
    return false;
  }

  const normalizedPath = filePath.replace(/\\/g, '/');
  if (!normalizedPath.includes('/webengine/')) {
    return false;
  }

  const fileName = path.basename(filePath);
  if (!fileName) {
    return false;
  }

  return path.extname(fileName) === '';
}

function hasParsleySyntax(content: string): boolean {
  return /\{\{\s*(?:if|each|else(?:\s+if|-if|_if)?|\/if|\/each|end[-_](?:if|each)|include|meta|set_var|autoLayout\s*\(|!\s*this\b|this\b|meta\.|page\.|globals\.|navigation\.|instance\.|site\.|request\.|settings\.|get_var\.|post_var\.|api\.|[$@][A-Za-z_])[\s\S]*?\}\}/.test(
    content
  );
}

function offsetsToRange(
  document: vscode.TextDocument,
  startOffset: number,
  endOffset: number
): vscode.Range {
  return new vscode.Range(document.positionAt(startOffset), document.positionAt(endOffset));
}
