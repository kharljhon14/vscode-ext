// @ts-nocheck
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require("vscode");
const sdk = require("@zesty-io/sdk");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed

/**
 * @param {vscode.ExtensionContext} context
 */

var zestyPackageConfig = "zesty.config.json";
var zestySDK = null;
var basePath = "";
var folders = [
  "/webengine",
  "/webengine/views",
  "/webengine/styles",
  "/webengine/scripts",
];
var zestyConfig = {};
var token = "";

function makeDir(dir) {
  if (fs.existsSync(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
}

function makeFolders(folders) {
  folders.forEach((folder) => makeDir(basePath + folder));
}

async function validate() {
  if (!token) {
    vscode.window.showErrorMessage("Access Token not found.");
    return false;
  }
  const res = await zestySDK.account.getInstance();
  if (res.error) {
    vscode.window.showErrorMessage(
      "Invalid or expired developer token provided."
    );
    return false;
  }
  return true;
}

async function init() {
  const pathConfig = `${basePath}/${zestyPackageConfig}`;
  if (!fs.existsSync(pathConfig)) return false;
  zestyConfig = readConfig(pathConfig, "JSON");
  if (
    !zestyConfig.hasOwnProperty("instance_zuid") ||
    !zestyConfig.instance_zuid ||
    zestyConfig.instance_zuid === ""
  ) {
    vscode.window.showErrorMessage("Missing instance zuid on config file.");
    return false;
  }
  token = vscode.workspace.getConfiguration("zesty.editor").get("token");
  if (token && zestyConfig.instance_zuid)
    zestySDK = new sdk(zestyConfig.instance_zuid, token);
}

async function request(url, method, payload) {
  var opts = {
    method: method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  };

  if (method !== "GET") opts.body = JSON.stringify(payload);

  const res = await fetch(url, opts);
  return res.json();
}

function makeFileSync(type, filename, content) {
  try {
    var file = basePath;
    if (type === "view")
      file += `${folders[1]}/${
        filename.charAt(0) !== "/" ? filename : filename.substring(1)
      }`;
    if (type === "style") file += `${folders[2]}/${filename}`;
    if (type === "script") file += `${folders[3]}/${filename}`;
    if (type === "config") file += filename;

    makeDir(path.dirname(file));
    fs.writeFileSync(file, content);
  } catch (e) {}
}

async function syncInstanceView() {
  const res = await zestySDK.instance.getViews();
  var viewObj = {};
  res.data
    .filter((view) => view.status === "dev")
    .forEach((view) => {
      makeFileSync("view", view.fileName, view.code || "");
      viewObj[view.fileName] = {
        zuid: view.ZUID,
        type: view.type,
        updatedAt: view.createdAt,
        createdAt: view.updatedAt,
        lastSyncedAt: view.updatedAt || view.updated_at || view.createdAt || view.created_at,
      };
    });
  zestyConfig.instance.views = viewObj;
}

async function syncInstanceStyles() {
  const res = await zestySDK.instance.getStylesheets();
  var styleObj = {};
  res.data
    .filter((stylesheet) => stylesheet.status === "dev")
    .forEach((stylesheet) => {
      makeFileSync("style", stylesheet.fileName, stylesheet.code);
      styleObj[stylesheet.fileName] = {
        zuid: stylesheet.ZUID,
        type: stylesheet.type,
        updatedAt: stylesheet.createdAt,
        createdAt: stylesheet.updatedAt,
        lastSyncedAt:
          stylesheet.updatedAt ||
          stylesheet.updated_at ||
          stylesheet.createdAt ||
          stylesheet.created_at,
      };
    });
  zestyConfig.instance.styles = styleObj;
}

async function syncInstanceScipts() {
  const res = await request(
    `https://${zestyConfig.instance_zuid}.api.zesty.io/v1/web/scripts`,
    "GET",
    {}
  );
  var scriptObj = {};
  res.data
    .filter((script) => script.status === "dev")
    .forEach((script) => {
      makeFileSync("script", script.fileName, script.code);
      scriptObj[script.fileName] = {
        zuid: script.ZUID,
        type: script.type,
        updatedAt: script.createdAt,
        createdAt: script.updatedAt,
        lastSyncedAt:
          script.updatedAt ||
          script.updated_at ||
          script.createdAt ||
          script.created_at,
      };
    });
  zestyConfig.instance.scripts = scriptObj;
}

function readConfig(path, fileType) {
  const res = fs.readFileSync(path, {
    encoding: "utf8",
  });
  return fileType === "JSON" ? JSON.parse(res) : res;
}

async function writeConfig() {
  var path = `${basePath}/${zestyPackageConfig}`;
  if (fs.existsSync(path)) {
    if (zestyConfig.hasOwnProperty("instance_zuid") && token !== "") {
      await fs.writeFileSync(path, JSON.stringify(zestyConfig, null, 4));
    }
  }
}

async function createGitIgnore() {
  var path = `${basePath}/.gitignore`;
  if (!fs.existsSync(path)) {
    await fs.writeFileSync(path, "zesty.json");
  }
}

function isFileSaveSyncEnabled() {
  const fileSaveConfig = vscode.workspace
    .getConfiguration("zesty.editor")
    .get("syncFileOnSave");
  return fileSaveConfig;
}

function isFileDeleteSyncEnabled() {
  const fileDeleteConfig = vscode.workspace
    .getConfiguration("zesty.editor")
    .get("syncFileOnDelete");

  return fileDeleteConfig;
}

function getFileDetails(file) {
  const excludeExtList = ["css", "sass", "less", "scss", "js", undefined];
  var fileArray = file.split("/");
  fileArray.splice(0, fileArray.indexOf("webengine"));
  var baseDir = fileArray.shift();
  var type = fileArray.shift();
  if (baseDir !== "webengine") return {};
  var filename = fileArray.join("/");
  var extension = getExtension(filename);
  if (!excludeExtList.includes(extension)) filename = "/" + filename;
  var instance = zestyConfig.instance[type][filename];

  return {
    filename,
    baseDir,
    type,
    extension,
    instance,
  };
}

async function saveFile(document) {
  const file = getFileDetails(document.uri.path);
  if (!file.filename || file.filename === zestyPackageConfig) return false;
  if (!file.instance) {
    vscode.window.showErrorMessage("Cannot sync to the instance.");
    return false;
  }
  if (!(await validate())) return false;
  const code = document.getText();
  const remote = await fetchRemoteFile(file);
  if (!remote) {
    vscode.window.showErrorMessage("Unable to check remote file for changes.");
    return false;
  }
  if (remote.code === code) {
    vscode.window.showInformationMessage("No changes to sync.");
    return true;
  }
  if (remote.code && remote.code !== code) {
    const remoteChanged = isRemoteNewerThanLastSync(
      remote.updatedAt,
      file.instance
    );
    if (remoteChanged) {
      const choice = await vscode.window.showWarningMessage(
        "Remote file has newer changes. Overwrite with local version?",
        "Overwrite Remote",
        "Show Diff",
        "Cancel"
      );
      if (!choice || choice === "Cancel") return;
      if (choice === "Show Diff") {
        await showDiff(remote.code, document, file);
        return false;
      }
    }
  }
  const payload = {
    filename: file.filename,
    code: code || " ",
    type: file.instance.type,
  };

  let updatedAt = null;
  switch (file.extension) {
    case "css":
    case "less":
    case "scss":
    case "sass":
      {
        const res = await zestySDK.instance.updateStylesheet(
          file.instance.zuid,
          payload
        );
        updatedAt = res && res.data ? res.data.updatedAt : null;
      }
      vscode.window.showInformationMessage(
        `Saving stylesheet to ${file.instance.zuid}.`
      );
      break;
    case "js":
      {
        const res = await request(
        `https://${zestyConfig.instance_zuid}.api.zesty.io/v1/web/scripts/${file.instance.zuid}`,
        "PUT",
        payload
        );
        updatedAt = res && res.data ? res.data.updatedAt : null;
      }
      vscode.window.showInformationMessage(
        `Saving script to ${file.instance.zuid}.`
      );
      break;
    default:
      {
        const res = await zestySDK.instance.updateView(file.instance.zuid, {
          code: payload.code,
        });
        updatedAt = res && res.data ? res.data.updatedAt : null;
      }
      vscode.window.showInformationMessage(
        `Saving view to ${file.instance.zuid}.`
      );
      break;
  }

  await updateLastSyncedAt(file, updatedAt);
  return true;
}

async function fetchRemoteFile(file, opts = {}) {
  try {
    let url = "";
    const status = opts.status ? String(opts.status) : "";
    switch (file.extension) {
      case "css":
      case "less":
      case "scss":
      case "sass":
        url = `https://${zestyConfig.instance_zuid}.api.zesty.io/v1/web/stylesheets/${file.instance.zuid}`;
        break;
      case "js":
        url = `https://${zestyConfig.instance_zuid}.api.zesty.io/v1/web/scripts/${file.instance.zuid}`;
        break;
      default:
        url = `https://${zestyConfig.instance_zuid}.api.zesty.io/v1/web/views/${file.instance.zuid}`;
        break;
    }
    if (status) url += `?status=${encodeURIComponent(status)}`;
    const res = await request(url, "GET", {});
    const data = res && res.data ? res.data : res;
    if (!data) return null;
    return {
      code: data.code || "",
      updatedAt: data.updatedAt || data.updated_at,
      version: data.version || data.version_num || data.versionNumber,
    };
  } catch (e) {
    return null;
  }
}

function isRemoteNewerThanLastSync(remoteUpdatedAt, instance) {
  const remoteTs = toTimestamp(remoteUpdatedAt);
  if (!remoteTs) return false;
  const lastSyncedAt =
    (instance && (instance.lastSyncedAt || instance.updatedAt)) || null;
  const localTs = toTimestamp(lastSyncedAt);
  if (!localTs) return true;
  return remoteTs > localTs;
}

function toTimestamp(value) {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? null : ts;
}

async function updateLastSyncedAt(file, updatedAt) {
  if (!file || !file.instance) return;
  const stamp = updatedAt || new Date().toISOString();
  file.instance.lastSyncedAt = stamp;
  file.instance.updatedAt = updatedAt || file.instance.updatedAt;
  await writeConfig();
}

async function showDiffBetweenCodes(leftCode, rightCode, languageId, title) {
  const leftDoc = await vscode.workspace.openTextDocument({
    content: leftCode || "",
    language: languageId,
  });
  const rightDoc = await vscode.workspace.openTextDocument({
    content: rightCode || "",
    language: languageId,
  });
  await vscode.commands.executeCommand(
    "vscode.diff",
    leftDoc.uri,
    rightDoc.uri,
    title
  );
}

async function showDiff(remoteCode, document, file) {
  const remoteDoc = await vscode.workspace.openTextDocument({
    content: remoteCode || "",
    language: document.languageId,
  });
  const title = `Zesty: Remote ↔ Local (${file.filename})`;
  await vscode.commands.executeCommand(
    "vscode.diff",
    remoteDoc.uri,
    document.uri,
    title
  );
}

async function syncFileFromUri(uri, opts = {}) {
  const forceSave = !!opts.forceSave;
  let document = null;
  const activeEditor = vscode.window.activeTextEditor;

  if (uri) {
    if (
      activeEditor &&
      activeEditor.document &&
      activeEditor.document.uri.toString() === uri.toString()
    ) {
      document = activeEditor.document;
    } else {
      document = await vscode.workspace.openTextDocument(uri);
    }
  } else if (activeEditor && activeEditor.document) {
    document = activeEditor.document;
  }

  if (!document) {
    vscode.window.showErrorMessage("No file selected to sync.");
    return;
  }

  if (forceSave) {
    const saved = await document.save();
    if (!saved) {
      vscode.window.showErrorMessage("Save failed. Sync cancelled.");
      return;
    }
  } else if (document.isDirty) {
    const choice = await vscode.window.showWarningMessage(
      "File has unsaved changes. Save before syncing?",
      "Save & Sync",
      "Sync Without Saving",
      "Cancel"
    );
    if (choice === "Cancel" || !choice) return;
    if (choice === "Save & Sync") {
      const saved = await document.save();
      if (!saved) {
        vscode.window.showErrorMessage("Save failed. Sync cancelled.");
        return;
      }
    }
  }

  await saveFile(document);
}

async function pullFileFromUri(uri) {
  let document = null;
  const activeEditor = vscode.window.activeTextEditor;

  if (uri) {
    if (
      activeEditor &&
      activeEditor.document &&
      activeEditor.document.uri.toString() === uri.toString()
    ) {
      document = activeEditor.document;
    } else {
      document = await vscode.workspace.openTextDocument(uri);
    }
  } else if (activeEditor && activeEditor.document) {
    document = activeEditor.document;
  }

  if (!document) {
    vscode.window.showErrorMessage("No file selected to pull.");
    return;
  }

  const file = getFileDetails(document.uri.path);
  if (!file.filename || file.filename === zestyPackageConfig) return;
  if (!file.instance) {
    vscode.window.showErrorMessage("Cannot pull from the instance.");
    return;
  }

  const warningMessage = document.isDirty
    ? "This will overwrite local changes (unsaved edits will be lost). Continue?"
    : "This will overwrite the local file with the instance version. Continue?";
  const confirm = await vscode.window.showWarningMessage(
    warningMessage,
    { modal: true },
    "Pull and Overwrite",
    "Cancel"
  );
  if (confirm !== "Pull and Overwrite") return;

  if (!(await validate())) return;
  const remote = await fetchRemoteFile(file);
  if (!remote) {
    vscode.window.showErrorMessage("Unable to fetch remote file.");
    return;
  }

  const buffer = Buffer.from(remote.code || "", "utf8");
  await vscode.workspace.fs.writeFile(document.uri, buffer);
  await updateLastSyncedAt(file, remote.updatedAt);
  vscode.window.showInformationMessage("Pulled latest file from instance.");
}

async function pullPublishedFileFromUri(uri) {
  let document = null;
  const activeEditor = vscode.window.activeTextEditor;

  if (uri) {
    if (
      activeEditor &&
      activeEditor.document &&
      activeEditor.document.uri.toString() === uri.toString()
    ) {
      document = activeEditor.document;
    } else {
      document = await vscode.workspace.openTextDocument(uri);
    }
  } else if (activeEditor && activeEditor.document) {
    document = activeEditor.document;
  }

  if (!document) {
    vscode.window.showErrorMessage("No file selected to pull.");
    return;
  }

  const file = getFileDetails(document.uri.path);
  if (!file.filename || file.filename === zestyPackageConfig) return;
  if (!file.instance) {
    vscode.window.showErrorMessage("Cannot pull from the instance.");
    return;
  }

  const warningMessage = document.isDirty
    ? "This will overwrite local changes with the published (live) version. Unsaved edits will be lost."
    : "This will overwrite the local file with the published (live) version.";
  const confirm = await vscode.window.showWarningMessage(
    warningMessage,
    { modal: true },
    "Pull Published Version",
    "Cancel"
  );
  if (confirm !== "Pull Published Version") return;

  if (!(await validate())) return;
  const remote = await fetchRemoteFile(file, { status: "live" });
  if (!remote) {
    vscode.window.showErrorMessage("Unable to fetch published file.");
    return;
  }

  const buffer = Buffer.from(remote.code || "", "utf8");
  await vscode.workspace.fs.writeFile(document.uri, buffer);
  await updateLastSyncedAt(file, remote.updatedAt);
  vscode.window.showInformationMessage(
    "Pulled published (live) file from instance."
  );
}

async function publishFileFromUri(uri) {
  let document = null;
  const activeEditor = vscode.window.activeTextEditor;

  if (uri) {
    if (
      activeEditor &&
      activeEditor.document &&
      activeEditor.document.uri.toString() === uri.toString()
    ) {
      document = activeEditor.document;
    } else {
      document = await vscode.workspace.openTextDocument(uri);
    }
  } else if (activeEditor && activeEditor.document) {
    document = activeEditor.document;
  }

  if (!document) {
    vscode.window.showErrorMessage("No file selected to publish.");
    return;
  }

  const file = getFileDetails(document.uri.path);
  if (!file.filename || file.filename === zestyPackageConfig) return;
  if (!file.instance) {
    vscode.window.showErrorMessage("Cannot publish to the instance.");
    return;
  }

  if (document.isDirty) {
    const choice = await vscode.window.showWarningMessage(
      "File has unsaved changes. Save before publishing?",
      "Save & Publish",
      "Publish Without Saving",
      "Cancel"
    );
    if (!choice || choice === "Cancel") return;
    if (choice === "Save & Publish") {
      const saved = await document.save();
      if (!saved) {
        vscode.window.showErrorMessage("Save failed. Publish cancelled.");
        return;
      }
    }
  }

  if (!(await validate())) return;

  const localCode = document.getText();
  const live = await fetchRemoteFile(file, { status: "live" });
  if (!live) {
    const proceed = await vscode.window.showWarningMessage(
      "Unable to fetch published version for diff. Publish anyway?",
      "Publish Anyway",
      "Cancel"
    );
    if (proceed !== "Publish Anyway") return;
  } else if (live.code !== localCode) {
    const diffChoice = await vscode.window.showWarningMessage(
      "Published (live) version differs from local. Review diff before publishing?",
      "Show Diff",
      "Continue",
      "Cancel"
    );
    if (!diffChoice || diffChoice === "Cancel") return;
    if (diffChoice === "Show Diff") {
      await showDiffBetweenCodes(
        live.code,
        localCode,
        document.languageId,
        `Zesty: Live ↔ Local (${file.filename})`
      );
    }
  }

  const confirm = await vscode.window.showWarningMessage(
    "This will publish the file. Are you sure?",
    { modal: true },
    "Publish",
    "Cancel"
  );
  if (confirm !== "Publish") return;

  const pushed = await saveFile(document);
  if (!pushed) return;

  const remote = await fetchRemoteFile(file);
  if (!remote) {
    vscode.window.showErrorMessage("Unable to fetch instance file for publish.");
    return;
  }

  switch (file.extension) {
    case "css":
    case "less":
    case "scss":
    case "sass":
      if (!remote.version) {
        vscode.window.showErrorMessage(
          "Unable to determine stylesheet version to publish."
        );
        return;
      }
      await zestySDK.instance.publishStylesheet(
        file.instance.zuid,
        remote.version
      );
      vscode.window.showInformationMessage(
        `Published stylesheet ${file.filename}.`
      );
      break;
    case "js":
      await request(
        `https://${zestyConfig.instance_zuid}.api.zesty.io/v1/web/scripts/${file.instance.zuid}?action=publish`,
        "PUT",
        {}
      );
      vscode.window.showInformationMessage(
        `Published script ${file.filename}.`
      );
      break;
    default:
      if (!remote.version) {
        vscode.window.showErrorMessage(
          "Unable to determine view version to publish."
        );
        return;
      }
      await zestySDK.instance.publishView(file.instance.zuid, remote.version);
      vscode.window.showInformationMessage(`Published view ${file.filename}.`);
      break;
  }
}

function getFile(file) {
  var splitPath = file.fsPath.split("\\");
  var newSplitPath = splitPath.slice(
    splitPath.indexOf("webengine"),
    splitPath.length
  );
  if (newSplitPath[0] === "webengine") newSplitPath.shift();
  if (["styles", "scripts", "views"].includes(newSplitPath[0]))
    newSplitPath.shift();
  return newSplitPath.join("/");
}

function getExtension(filename) {
  var ext = /[^.]+$/.exec(filename);
  return /[.]/.exec(filename) ? ext[0] : undefined;
}

function loadConfig() {
  var path = `${basePath}/${zestyPackageConfig}`;
  if (fs.existsSync(path)) {
    const zestyData = readConfig(`${basePath}/${zestyPackageConfig}`, "JSON");
    zestyConfig = zestyData;
    if (!zestyData.hasOwnProperty("instance")) zestyConfig.instance = {};
  }
}

function isDirectory(path) {
  return fs.lstatSync(path).isDirectory();
}

async function activate(context) {
  basePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
  await init();

  context.subscriptions.push(
    vscode.commands.registerCommand("zesty-vscode-extension.run", async () => {
      if (!(await validate())) {
        const devToken = await vscode.window.showInputBox({
          value: "",
          placeHolder: "Please Enter your DEVELOPER TOKEN",
        });
        if (devToken === "" || devToken === undefined) {
          vscode.window.showErrorMessage(
            "Developer Token is required to proceed."
          );
          return;
        }
        const configuration = vscode.workspace.getConfiguration("zesty.editor");
        await configuration.update("token", devToken);
        await init();
        if (!(await validate())) return;
      }

      if (!zestyConfig.hasOwnProperty("instance")) zestyConfig.instance = {};
      await makeFolders(folders);
      await syncInstanceView();
      await syncInstanceStyles();
      await syncInstanceScipts();
      await writeConfig();
      vscode.window.showInformationMessage(`File sync is completed.`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "zesty-vscode-extension.syncFile",
      async (uri) => {
        await syncFileFromUri(uri);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "zesty-vscode-extension.saveAndSyncFile",
      async (uri) => {
        await syncFileFromUri(uri, { forceSave: true });
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "zesty-vscode-extension.pullFile",
      async (uri) => {
        await pullFileFromUri(uri);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "zesty-vscode-extension.pullPublishedFile",
      async (uri) => {
        await pullPublishedFileFromUri(uri);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "zesty-vscode-extension.publishFile",
      async (uri) => {
        await publishFileFromUri(uri);
      }
    )
  );

  vscode.workspace.onDidSaveTextDocument(async (document) => {
    if (!isFileSaveSyncEnabled()) return;
    await saveFile(document);
  });

  vscode.workspace.onDidDeleteFiles(async (event) => {
    if (!(await validate())) return;
    if (!isFileDeleteSyncEnabled()) return;
    if (event.files) {
      const file = getFileDetails(event.files[0].path);
      if (!file.filename || file.filename === zestyPackageConfig) return;
      if (event.files.length > 1) {
        vscode.window.showErrorMessage(
          `Multiple file deletion is not yet supported.`
        );
        return;
      }
      if (!file.instance) {
        vscode.window.showErrorMessage("Cannot sync to the instance.");
        return;
      }

      switch (file.extension) {
        case "css":
        case "less":
        case "scss":
        case "sass":
          await zestySDK.instance.deleteStylesheet(file.instance.zuid);
          delete zestyConfig.instance.styles[file.filename];
          await writeConfig();
          vscode.window.showInformationMessage(
            `Deleting stylesheet from ${file.instance.zuid}`
          );
          break;
        case "js":
          await request(
            `https://${zestyConfig.instance_zuid}.api.zesty.io/v1/web/scripts/${file.instance.zuid}`,
            "DELETE",
            {}
          );
          delete zestyConfig.instance.scripts[file.filename];
          await writeConfig();
          vscode.window.showInformationMessage(
            `Deleting script from ${file.instance.zuid}`
          );
          break;
        default:
          await request(
            `https://${zestyConfig.instance_zuid}.api.zesty.io/v1/web/views/${file.instance.zuid}`,
            "DELETE",
            {}
          );
          delete zestyConfig.instance.views[file.filename];
          await writeConfig();
          vscode.window.showInformationMessage(
            `Deleting view from ${file.instance.zuid}`
          );
          break;
      }
    }
  });

  vscode.workspace.onDidCreateFiles(async (event) => {
    if (!(await validate())) return;
    if (event.files && !isDirectory(event.files[0].fsPath)) {
      const file = getFileDetails(event.files[0].path);
      if (!file.filename || file.filename === zestyPackageConfig) return;
      var payload = {
        filename: file.filename,
        type: "ajax-json",
        code: " ",
      };

      switch (file.extension) {
        case "css":
        case "less":
        case "scss":
        case "sass":
          payload.type = `text/${file.extension}`;
          var resStyle = await zestySDK.instance.createStylesheet(payload);
          if (!resStyle.error) {
            zestyConfig.instance.styles[payload.filename] = {
              zuid: resStyle.data.ZUID,
              type: resStyle.data.type,
              updatedAt: resStyle.data.updatedAt,
              createdAt: resStyle.data.createdAt,
            };
            await writeConfig();
            vscode.window.showInformationMessage(
              `Creating stylesheet to ${resStyle.data.ZUID}.`
            );
          }
          break;
        case "js":
          payload.type = "text/javascript";
          var resScript = await request(
            `https://${zestyConfig.instance_zuid}.api.zesty.io/v1/web/scripts`,
            "POST",
            payload
          );
          if (!resScript.error) {
            zestyConfig.instance.scripts[payload.filename] = {
              zuid: resScript.data.ZUID,
              type: resScript.data.type,
              updatedAt: resScript.data.updatedAt,
              createdAt: resScript.data.createdAt,
            };
            await writeConfig();
            vscode.window.showInformationMessage(
              `Creating script to ${resScript.data.ZUID}.`
            );
          }
          break;
        case undefined:
          payload.type = "snippet";
          var resSnippet = await zestySDK.instance.createView(payload);
          if (!resSnippet.error) {
            zestyConfig.instance.views[payload.filename] = {
              zuid: resSnippet.data.ZUID,
              type: resSnippet.data.type,
              updatedAt: resSnippet.data.updatedAt,
              createdAt: resSnippet.data.createdAt,
            };
            await writeConfig();
            vscode.window.showInformationMessage(
              `Creating file to ${resSnippet.data.ZUID}.`
            );
          }
          break;
        default:
          var resCustom = await zestySDK.instance.createView(payload);
          if (!resCustom.error) {
            zestyConfig.instance.views[payload.filename] = {
              zuid: resCustom.data.ZUID,
              type: resCustom.data.type,
              updatedAt: resCustom.data.updatedAt,
              createdAt: resCustom.data.createdAt,
            };
            await writeConfig();
            vscode.window.showInformationMessage(
              `Creating file to ${resCustom.data.ZUID}.`
            );
          }
          break;
      }
    }
  });
}

// This method is called when your extension is deactivated
function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
