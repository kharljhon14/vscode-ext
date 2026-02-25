## Zesty.io VS Code Extension

Use this package to connect the Visual Studio Code to your Zesty.io Instance. This extension will sync the remote instance content and create files to your local machine. You can edit the files (views, stylesheet and scripts) and save them locally. Saving a file will push the changes to the associated file from your instance.

NOTE:

The extension uses the file path from webengine when syncing the file to your local machine. Using special characted will result to error in file creation due to unable to create directory with special character.

## Getting Started

- Install the `zesty-vscode-extension` package to vscode

```
code --install-extension zesty-io.zesty-vscode-extension
```

- Create empty directory for your instance.

```bash
mkdir mydomain.com
```

- Create a file on your root folder named `zesty.config.json`.
- Add the following to the `zesty.config.json` file.

```json
{
  "instance_zuid": "INSTANCE_ZUID"
}
```

- Replace `INSTANCE_ZUID` with the value from your instance.
- Sync instance file by right clicking the `zesty.config.json` file then click `Sync to Instance` or by using the key command shortcut (`ctrl + alt + i`)
- Input your developer token then press enter.
- Instance contents including view, scripts and stylesheet will sync and copied to your local machine.

## Functionality Notes

- Any existing view, stylesheet, or script on a cloud instance will synchronize and become editable through VSCode.
- New files may be created from on the local machine, and they will sync to the cloud content instance
- Javascript and CSS files can be created remotely from the local project, and will be synced to the cloud instance
- Stylesheets and javascript compiles in the cloud on save (SASS, SCSS, LESS supported)
- Custom endpoints for xml,json, html, etc. can be created by making a new file in your views folder with an extension
- Adjustment on file under `webengine` folder will automatically sync to the instance.
- With option enable or disable sync file deletion and saving with vscode settings.

## Requirements

- A zesty.io account is required. Create your account at https://www.zesty.io/join/
- A zesty.io instance.
- Developer Token for authenticated connection with zesty.io instance.

## Extension Settings

This extension contributes the following settings:

- `zesty.editor.token` : Store developer token from the account.
- `zesty.editor.syncFileOnSave` : Default to `true`. Automatically sync save to cloud instance.
- `zesty.editor.syncFileOnDelete` : Default to `true`. Automatically sync file deletion to clound instance.

## Known Issues

Submit issues on github https://github.com/zesty-io/vscode-ext/issues

## Release Notes

### 0.0.1

Phase 1 Release

- Zesty Plugin will be available on VSCode Extension Store.
- Configuration will be needed to synchronize your codebase to zesty instance.
- Configuration will match the Next.js configuration file.
- Files will be stored to webengine folder, with option to change the folder name to change the folder root, to match the atom plugin behavior .
- Files will sync down with command in VSCode.
- New files will be created and sync to zesty project.
- Files by default will automatically save on save, with an option to sync with a VS Code command, with an option to turn off synchronization on save. (maybe)
- Deleting file synchronization can be turned off. A notification will prompt before file deletion.
- Options will be stored on a .vscode configuration file.
- Opensource codebase on github. https://github.com/zesty-io/vscode-ext
- Submit feature requests https://github.com/zesty-io/vscode-ext/issues/new/choose
- Submit bugs https://github.com/zesty-io/vscode-ext/issues/new/choose
- Command for zesty init will create a shell zesty.json config file.
- Sneak peak video https://www.youtube.com/watch?v=2pCqhK9iy2E

