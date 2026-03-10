# Zesty Parsley Tools

Developer tooling for the Parsley templating language used in Zesty.io WebEngine templates.

## Features

- Syntax highlighting for Parsley tags and variables:
  - `{{this.field}}`
  - `{{$myVariable}}`, `{{$_mySessionVar}}`, `{{@myCookieVar}}`
  - `{{ each media.{clippings.default_images} as media }} ... {{ end-each }}`
  - `{{else-if condition}}` and `{{else if condition}}`
  - `{{end-if}}` and `{{end-each}}`
  - `{{each collection}} ... {{/each}}`
  - `{{if condition}} ... {{else}} ... {{/if}}`
  - `{{include}}`
  - `{{meta}}`
- Autocomplete / IntelliSense for common objects:
  - `this.`
  - `meta.`
  - `page.`
  - `globals.`
  - `navigation.`
  - `instance.`
  - `site.`
  - `request.`
  - `get_var.`
  - `post_var.`
  - `api.json.`, `api.xml.`, `api.gbi.`
- Method IntelliSense for common Parsley helpers:
  - `toJSON()`, `json()`, `filter()`, `isPublished()`
  - `getImage()`, `getMediaURL()`, `date()`, `truepath()`
  - `escapeForJs()`, `html_entity_decode()`, `wordCount()`, `replace()`
- Snippets for common patterns:
  - Each loop
  - Advanced each loop (`where` / `sort by` / `limit`)
  - If block
  - If/else block and if/else-if/else block
  - Meta title tag
  - Include helper
  - Dynamic include path helper
  - Local/session/cookie variable assignment helpers
  - API JSON GET helper
  - Published status check helper
- Basic lint diagnostics in Problems panel:
  - Unclosed `{{if}}`
  - Unclosed `{{each}}`
  - Invalid include usage (missing include target)
  - Invalid variable usage (unknown root and non-namespaced variables; excludes `$`/`$_`/`@` prefixed variables)
- Hover documentation for Parsley variables, roots, keywords, and methods (for example: `{{this.title}}`, `{{instance.date()}}`, `{{api.json.get()}}`)
- File support:
  - Native Parsley language for `.tpl` and `.parsley`
  - Parsley syntax highlighting and tooling injection inside `.html`
- Sidebar:
  - `Zesty` activity bar view with a `WebEngine Files` tree
  - `File Details` panel that updates from the selected WebEngine file
  - Browse `webengine/` folders and files
  - Click a WebEngine file to open it locally
  - `File Details` includes an `Open in Zesty` action when the selected file has a mapped item ZUID
  - `File Details` includes `Create Rollback Snapshot` and `Rollback File` actions
  - Rollback snapshots are stored in Zesty as dedicated hidden view files containing the source file metadata and code
  - Shows file metadata from `zesty.config.json` and API data (current version, published/live version, and publishing history with current + previous published versions when available)
  - Right-click file actions for open in Zesty, open locally, create rollback snapshot, rollback, sync, pull, pull published, and publish
- Command:
  - `Zesty: Validate Parsley Template`
- Nice-to-have capabilities:
  - Auto close for `{{if}}` and `{{each}}` blocks
  - Bracket matching and auto-closing pairs
  - Basic Parsley document formatting

## Extension Structure

```text
zesty-parsley-tools/
├ package.json
├ extension.ts
├ language-configuration.json
├ syntaxes/
│  ├ parsley.tmLanguage.json
│  └ parsley.injection.tmLanguage.json
├ snippets/
│  └ parsley.code-snippets
├ tsconfig.json
└ README.md
```

## Commands

- `Zesty: Validate Parsley Template`
- `Zesty: Refresh WebEngine Sidebar`
- `Zesty: Refresh WebEngine File Details`
- `Zesty: Open WebEngine File in Zesty`
- `Zesty: Create Rollback Snapshot`
- `Zesty: Rollback WebEngine File`
- `Zesty: Open WebEngine File Locally`
- `Zesty: Sync WebEngine File`
- `Zesty: Pull WebEngine File`
- `Zesty: Pull Published WebEngine File`
- `Zesty: Publish WebEngine File`
- `Zesty: Sync Instance Files`
- `Zesty: Sync Current File`
- `Zesty: Save and Sync Current File`
- `Zesty: Pull Current File`
- `Zesty: Pull Published Current File`
- `Zesty: Publish Current File`

## Settings

- `zestyParsley.autoCloseBlocks` (default: `true`)
- `zestyParsley.validateOnType` (default: `true`)
- `zestyParsley.format.indentSize` (default: `2`)

## Run Locally in VS Code

1. Install dependencies:

```bash
npm install
```

2. Compile TypeScript:

```bash
npm run compile
```

3. Open this folder in VS Code.
4. Press `F5` to launch an Extension Development Host.
5. In the new window, open a `.tpl`, `.parsley`, or `.html` file with Parsley syntax.
6. Test tooling:
   - Trigger IntelliSense with `Ctrl+Space`.
   - Hover on variables like `this.title`.
   - Open Command Palette and run `Zesty: Validate Parsley Template`.

## Packaging

To create a VSIX package:

```bash
npx @vscode/vsce package
```
