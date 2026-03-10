import * as vscode from 'vscode';
import * as path from 'path';

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

interface OpenBlock {
  type: BlockType;
  range: vscode.Range;
  loopAlias?: string;
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
    'AutoLayout helper to render content model records with a configured snippet/template.',
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
    label: 'autoLayout("model_name","snippet_name",10,0)',
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
  { label: 'autoLayout("model","snippet",10,0)', detail: 'AutoLayout helper', documentation: METHOD_DOCS.autoLayout },
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
  { language: 'html', scheme: 'untitled' }
];

let autoCloseInProgress = false;

export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection('zesty-parsley');
  const pendingValidation = new Map<string, NodeJS.Timeout>();

  context.subscriptions.push(diagnostics);

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
    void maybeAssignWebengineExtensionlessFileToHtml(vscode.window.activeTextEditor.document).then(
      (changed) => {
        if (!changed) {
          runValidation(vscode.window.activeTextEditor!.document);
        }
      }
    );
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      void maybeAssignWebengineExtensionlessFileToHtml(document).then((changed) => {
        if (!changed) {
          runValidation(document);
        }
      });
    }),
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
    })
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

async function maybeAssignWebengineExtensionlessFileToHtml(
  document: vscode.TextDocument
): Promise<boolean> {
  if (document.uri.scheme !== 'file') {
    return false;
  }

  if (document.languageId === 'html') {
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
  if (!fileName || path.extname(fileName)) {
    return false;
  }

  await vscode.languages.setTextDocumentLanguage(document, 'html');
  return true;
}

function isSupportedDocument(document: vscode.TextDocument): boolean {
  return (
    SUPPORTED_LANGUAGE_IDS.has(document.languageId) &&
    (document.uri.scheme === 'file' || document.uri.scheme === 'untitled')
  );
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
