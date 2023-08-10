import * as vscode from 'vscode'
import * as marshal from '@hyrious/marshal'

declare function inflate(data: ArrayBuffer): Promise<Uint8Array>
declare function deflate(data: Uint8Array): Promise<ArrayBuffer>

type RGSS_Scripts_Data_Item = [magic: number, title: string, code: Uint8Array]
type RGSS_Scripts_Data = RGSS_Scripts_Data_Item[]
type CacheEntry = { stat: vscode.FileStat; contents: RGSS_Scripts_Data }

// Simulate a virtual FS whose path looks like rgss:/path/to/Scripts.rvdata2/001_Title.rb
export class RGSS_Scripts implements vscode.FileSystemProvider {
  private readonly _encoder = new TextEncoder()
  private readonly _decoder = new TextDecoder()

  // Cache opened Scripts.rvdata2 files, populate its stats to the contents
  private readonly _cache = new Map<string, CacheEntry>()

  // p = "/path/to/Scripts.rvdata2/001_Title.rb"
  // or "C:\\path\\to\\Scripts.rvdata2\\001_Title.rb" on Windows
  static parse(p: string): { file: string; index: number; title: string } | undefined {
    if (process.platform === 'win32') {
      p = p.replace(/\\/g, '/')
    }
    var index = p.indexOf('/Scripts.rvdata2')
    if (index < 0) return undefined

    if (p.length === index + 16) {
      if (process.platform === 'win32') p = p.replace(/\//g, '\\')
      return { file: p, index: -1, title: '' }
    }
    if (p[index + 16] !== '/') return undefined

    var file = p.slice(0, index + 16)
    if (process.platform === 'win32') {
      file = file.replace(/\//g, '\\')
    }
    p = p.slice(index + 17)
    var sep = p.indexOf('_')
    if (sep < 0) return undefined
    var index = Number.parseInt(p.slice(0, sep))
    if (Number.isNaN(index)) return undefined
    var title = p.slice(sep + 1)
    if (title.includes('/')) return undefined
    if (title.endsWith('.rb')) {
      title = title.slice(0, -3)
    }
    return { file, index, title }
  }

  static name_(index: number, title: string): string {
    return `${index.toString().padStart(3, '0')}_${title}.rb`
  }

  static uri(file: string, index: number, title: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: 'rgss',
      path: vscode.Uri.joinPath(vscode.Uri.file(file), this.name_(index, title)).path,
    })
  }

  private _parse(p: string): { file: string; index: number; title: string } | undefined {
    return RGSS_Scripts.parse(p)
  }

  private async _open(file: string): Promise<CacheEntry> {
    var entry = this._cache.get(file)
    if (entry) return entry

    var uri = vscode.Uri.file(file)
    var stat = await vscode.workspace.fs.stat(uri) // throws file not found error
    var u8 = await vscode.workspace.fs.readFile(uri)
    var buffer = u8.buffer
    if (u8.byteOffset !== 0) {
      buffer = buffer.slice(u8.byteOffset)
    }

    // https://github.com/hyrious/rvdata2-textconv/blob/main/index.js
    var data = marshal.load(buffer, { decodeString: false })
    var contents: RGSS_Scripts_Data = []
    for (var i = 0; i < data.length; i++) {
      var [magic, title_, code_] = data[i]
      var title = this._decoder.decode(title_)
      var code = new Uint8Array(await inflate(code_))
      contents.push([magic, title, code])
    }

    stat.type = vscode.FileType.Directory
    entry = { stat, contents }
    this._cache.set(file, entry)
    return entry
  }

  private _name(index: number, title: string): string {
    return RGSS_Scripts.name_(index, title)
  }

  private _empty(): RGSS_Scripts_Data_Item {
    return [(Math.random() * 32768) | 0, '', new Uint8Array()]
  }

  private _uri(file: string, arr: RGSS_Scripts_Data, index: number): vscode.Uri {
    return RGSS_Scripts.uri(file, index, arr[index][1])
  }

  private async _flush(file: string, contents: RGSS_Scripts_Data): Promise<void> {
    var data: [number, ArrayBuffer, ArrayBuffer][] = Array(contents.length)
    for (var i = 0; i < contents.length; i++) {
      var [magic, title, code] = contents[i]
      data[i] = [magic, this._encoder.encode(title).buffer, new Uint8Array(await deflate(code)).buffer]
    }
    var u8 = new Uint8Array(marshal.dump(data))
    var entry = this._cache.get(file)
    if (entry) {
      entry.stat.mtime = Date.now()
      entry.stat.size = contents.length
    }
    await vscode.workspace.fs.writeFile(vscode.Uri.file(file), u8)
  }

  // The `rename` and `delete` command may not really delete the file
  // and VS Code may not listen to the `onDidChangeFile` event
  // So we need to refresh the workspace manually
  private _refreshFilesExplorer(): void {
    if (vscode.workspace.workspaceFolders?.some(folder => folder.uri.scheme === 'rgss'))
      vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer')
  }

  private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>()
  private _bufferedEvents: vscode.FileChangeEvent[] = []
  private _fireSoonHandle: NodeJS.Timer | undefined

  readonly onDidChangeFile = this._emitter.event

  // VS Code never calls this method... why? :(
  watch(uri: vscode.Uri, options: any): vscode.Disposable {
    return new vscode.Disposable(() => void 0)
  }

  private _fireSoon(...events: vscode.FileChangeEvent[]): void {
    this._bufferedEvents.push(...events)

    if (this._fireSoonHandle) {
      clearTimeout(this._fireSoonHandle)
    }

    this._fireSoonHandle = setTimeout(() => {
      this._emitter.fire(this._bufferedEvents)
      this._bufferedEvents.length = 0
    }, 5)
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    var info = this._parse(uri.fsPath)
    if (info == null) {
      throw vscode.FileSystemError.FileNotFound(uri)
    }

    var entry = await this._open(info.file)
    if (info.index < 0) {
      return entry.stat
    }

    var item = entry.contents[info.index]
    if (item == null || item[1] !== info.title) {
      throw vscode.FileSystemError.FileNotFound(uri)
    }

    return {
      type: vscode.FileType.File,
      ctime: entry.stat.ctime,
      mtime: entry.stat.mtime,
      size: entry.contents[info.index][2].length,
      permissions: entry.stat.permissions,
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    var stat = await this.stat(uri)
    if (stat.type !== vscode.FileType.Directory) {
      throw vscode.FileSystemError.FileNotADirectory(uri)
    }

    var info = this._parse(uri.fsPath)!
    var entry = await this._open(info.file)
    if (info.index < 0) {
      return entry.contents.map(([_, title], index) => [this._name(index, title), vscode.FileType.File])
    }

    throw vscode.FileSystemError.FileNotADirectory(uri)
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    var stat = await this.stat(uri)
    if (stat.type !== vscode.FileType.File) {
      if (stat.type === vscode.FileType.Directory) {
        throw vscode.FileSystemError.FileIsADirectory(uri)
      } else {
        throw vscode.FileSystemError.FileNotFound(uri)
      }
    }

    var info = this._parse(uri.fsPath)!
    var entry = await this._open(info.file)
    return entry.contents[info.index][2]
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
    var info = this._parse(uri.fsPath)
    if (info == null || info.index < 0) {
      throw vscode.FileSystemError.NoPermissions(uri)
    }

    var entry = await this._open(info.file)
    var exist = entry.contents[info.index]
    if (!options.create && !exist) {
      throw vscode.FileSystemError.FileNotFound(uri)
    }
    if (options.create && !options.overwrite && exist) {
      throw vscode.FileSystemError.FileExists(uri)
    }

    while (info.index > entry.contents.length) {
      entry.contents.push(this._empty())
      this._fireSoon({
        type: vscode.FileChangeType.Created,
        uri: this._uri(info.file, entry.contents, info.index),
      })
    }
    var type = info.index === entry.contents.length ? vscode.FileChangeType.Created : vscode.FileChangeType.Changed
    var item = this._empty() || entry.contents[info.index]
    item[1] = info.title
    item[2] = content
    entry.contents[info.index] = item
    this._fireSoon({ type, uri: this._uri(info.file, entry.contents, info.index) })

    await this._flush(info.file, entry.contents)
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    var oldInfo = this._parse(oldUri.fsPath)
    if (oldInfo == null || oldInfo.index < 0) {
      throw vscode.FileSystemError.NoPermissions(oldUri)
    }

    var newInfo = this._parse(newUri.fsPath)
    if (newInfo == null || newInfo.index < 0) {
      throw vscode.FileSystemError.NoPermissions(newUri)
    }

    // Should it allow rename to another Scripts.rvdata2 file?
    if (oldInfo.file !== newInfo.file) {
      throw vscode.FileSystemError.NoPermissions(newUri)
    }

    var file = oldInfo.file
    var entry = await this._open(file)
    var exist = entry.contents[oldInfo.index]
    if (exist == null || exist[1] !== oldInfo.title) {
      throw vscode.FileSystemError.FileNotFound(oldUri)
    }

    // these events may need to be fired later
    var events: vscode.FileChangeEvent[] = []

    // '001_Title.rb' -> '001_Title2.rb'
    if (oldInfo.index === newInfo.index) {
      this._fireSoon({
        type: vscode.FileChangeType.Deleted,
        uri: this._uri(file, entry.contents, oldInfo.index),
      })
      exist[1] = newInfo.title
      this._fireSoon({
        type: vscode.FileChangeType.Created,
        uri: this._uri(file, entry.contents, oldInfo.index),
      })
    }

    // '001_Title.rb' -> '002_Title2.rb'
    else {
      var code = exist[2]

      this._fireSoon({
        type: vscode.FileChangeType.Deleted,
        uri: this._uri(file, entry.contents, oldInfo.index),
      })
      exist[1] = ''
      exist[2] = new Uint8Array()
      if (oldInfo.index < entry.contents.length) {
        events.push({
          type: vscode.FileChangeType.Created,
          uri: this._uri(file, entry.contents, oldInfo.index),
        })
      }

      while (newInfo.index > entry.contents.length) {
        entry.contents.push(this._empty())
        this._fireSoon({
          type: vscode.FileChangeType.Created,
          uri: this._uri(file, entry.contents, entry.contents.length - 1),
        })
      }
      if (newInfo.index === entry.contents.length) {
        var item = this._empty()
        item[1] = newInfo.title
        item[2] = code
        entry.contents[newInfo.index] = item
        this._fireSoon({
          type: vscode.FileChangeType.Created,
          uri: this._uri(file, entry.contents, newInfo.index),
        })
      } else {
        events.push({
          type: vscode.FileChangeType.Deleted,
          uri: this._uri(file, entry.contents, newInfo.index),
        })
        var item = entry.contents[newInfo.index]
        item[1] = newInfo.title
        item[2] = code
        this._fireSoon({
          type: vscode.FileChangeType.Created,
          uri: this._uri(file, entry.contents, newInfo.index),
        })
      }
    }

    await this._flush(file, entry.contents)

    if (events.length > 0) {
      this._fireSoon(...events)
      this._refreshFilesExplorer()
    }
  }

  // No need to handle 'recursive' since it only has one level of depth
  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    var info = this._parse(uri.fsPath)
    if (info == null || info.index < 0) {
      throw vscode.FileSystemError.NoPermissions(uri)
    }

    var entry = await this._open(info.file)
    var exist = entry.contents[info.index]
    if (exist == null) return // Already deleted

    if (exist[1] !== info.title) {
      throw vscode.FileSystemError.FileNotFound(uri)
    }

    if (info.index === entry.contents.length - 1) {
      entry.contents.pop()
    } else {
      exist[1] = ''
      exist[2] = new Uint8Array()
    }

    await this._flush(info.file, entry.contents)

    this._refreshFilesExplorer()
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    var info = this._parse(uri.fsPath)
    if (info == null || info.index >= 0) {
      throw vscode.FileSystemError.NoPermissions(uri)
    }

    this._cache.set(info.file, {
      stat: {
        type: vscode.FileType.Directory,
        ctime: Date.now(),
        mtime: Date.now(),
        size: 0,
      },
      contents: [],
    })
    this._fireSoon({
      type: vscode.FileChangeType.Created,
      uri: uri,
    })

    await this._flush(info.file, [])
  }

  // Below are APIs used by the tree view
  async ls(file: string): Promise<string[] | null> {
    try {
      var entry = await this._open(file)
      return entry.contents.map(e => e[1])
    } catch {
      return null
    }
  }

  // New-Item, get it? :P
  async ni({ tree, index }: ScriptItem): Promise<void> {
    if (tree.file == null) return
    var entry = await this._open(tree.file)
    entry.contents.splice(index, 0, this._empty())

    await this._flush(tree.file, entry.contents)
    this._refreshFilesExplorer()
    tree.refresh()
  }

  async rm({ tree, index }: ScriptItem): Promise<void> {
    if (tree.file == null) return
    // Should we ask for confirmation?
    var entry = await this._open(tree.file)
    if (index === entry.contents.length) {
      vscode.window.showInformationMessage('Cannot delete the last item')
      return
    }
    entry.contents.splice(index, 1)

    await this._flush(tree.file, entry.contents)
    this._refreshFilesExplorer()
    tree.refresh()
  }

  // Cannot add an inline rename input box, see https://github.com/microsoft/vscode/issues/97190
  async mv(treeItem: ScriptItem): Promise<void> {
    var { tree, index } = treeItem
    if (tree.file == null) return
    var entry = await this._open(tree.file)
    var item = entry.contents[index] || this._empty()
    var newTitle = await vscode.window.showInputBox({
      prompt: 'Edit title',
      value: item[1],
      validateInput(title) {
        if (title.includes('/')) {
          return 'Title cannot contain "/"'
        }
        return null
      },
    })
    if (newTitle == null || newTitle === item[1]) return
    item[1] = newTitle
    if (index === entry.contents.length) {
      entry.contents.push(item)
    }

    await this._flush(tree.file, entry.contents)
    this._refreshFilesExplorer()
    tree.refresh()
  }
}

class ScriptItem extends vscode.TreeItem {
  constructor(readonly tree: RGSS_Scripts_Tree, readonly index: number, readonly title: string, readonly uri: vscode.Uri | null) {
    super(title, vscode.TreeItemCollapsibleState.None)
  }

  // "when": "viewItem == 'rgss-script'"
  override contextValue = 'rgss-script'

  override command: vscode.Command | undefined = this.uri
    ? {
        command: 'vscode.open',
        title: 'Open Script',
        arguments: [this.uri],
      }
    : void 0
}

export class RGSS_Scripts_Tree implements vscode.TreeDataProvider<ScriptItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ScriptItem | null>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  constructor(readonly fs: RGSS_Scripts, readonly file?: string) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(null)
  }

  getTreeItem(element: ScriptItem): vscode.TreeItem {
    return element
  }

  async getChildren(element?: ScriptItem): Promise<ScriptItem[] | null> {
    // No need to handle 'element' since it only has one level of depth
    if (this.file == null || element) return null

    try {
      var titles = await this.fs.ls(this.file)
      if (titles == null) return null

      var result: ScriptItem[] = []
      for (var i = 0; i < titles.length; ++i) {
        var title = titles[i]
        result.push(new ScriptItem(this, i, title, RGSS_Scripts.uri(this.file, i, title)))
      }
      // Append a 'null' item like RPG Maker, so that you can append new file to the end
      result.push(new ScriptItem(this, i, '', null))
      return result
    } catch {
      vscode.window.showInformationMessage('No mounted Scripts.rvdata2 file')
      return null
    }
  }
}

function basename(p: string): string {
  if (process.platform === 'win32') {
    p = p.replace(/\\/g, '/')
  }
  var index = p.lastIndexOf('/')
  if (index < 0) return p
  return p.slice(index + 1)
}

async function mount(uri: vscode.Uri | undefined): Promise<void> {
  if (uri == null) {
    var uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Open',
      filters: { 'RGSS Scripts': ['rvdata2'] },
    })

    if (uris && uris.length > 0) {
      uri = uris[0]
    } else {
      return
    }
  }

  var rgssUri = vscode.Uri.parse(`rgss:${uri.fsPath}`)

  if (vscode.workspace.getWorkspaceFolder(rgssUri) == null) {
    var folders = vscode.workspace.workspaceFolders || []
    vscode.workspace.updateWorkspaceFolders(folders.length, 0, {
      name: basename(uri.fsPath),
      uri: rgssUri,
    })
  }
}

function unmount(uri: vscode.Uri | undefined): void {
  if (uri == null) {
    var folder = vscode.workspace.workspaceFolders?.find(folder => folder.uri.scheme === 'rgss')
    if (folder == null) {
      vscode.window.showErrorMessage('No mounted Scripts.rvdata2 file')
      return
    }
    uri = folder.uri
  }

  var rgssUri = vscode.Uri.parse(`rgss:${uri.fsPath}`)

  var folder = vscode.workspace.getWorkspaceFolder(rgssUri)
  if (folder == null) {
    vscode.window.showErrorMessage(`Cannot unmount ${uri.fsPath}: not mounted`)
    return
  }

  if (vscode.workspace.workspaceFolders == null) {
    vscode.window.showErrorMessage(`Cannot unmount ${uri.fsPath}: no workspace folder`)
    return
  }

  if (vscode.workspace.workspaceFolders.length === 2) {
    var other = vscode.workspace.workspaceFolders.find(other => other.index !== folder!.index)
    vscode.commands.executeCommand('vscode.openFolder', other!.uri, { forceNewWindow: false })
  } else {
    vscode.workspace.updateWorkspaceFolders(folder.index, 1)
  }

  for (var tab of vscode.window.tabGroups.all.map(e => e.tabs).flat()) {
    if (tab.input instanceof vscode.TabInputText && RGSS_Scripts.parse(tab.input.uri.fsPath)?.file === uri.fsPath) {
      vscode.window.tabGroups.close(tab)
    }
  }
}

function dirname(p: string): string {
  if (process.platform === 'win32') {
    var index = p.lastIndexOf('\\')
    if (index < 0) return p
    return p.slice(0, index)
  }
  var index = p.lastIndexOf('/')
  if (index < 0) return p
  return p.slice(0, index)
}

// file = "/path/to/Scripts.rvdata2"
async function run(file?: string): Promise<void> {
  if (file == null) {
    return
  }
  if (process.platform !== 'win32') {
    vscode.window.showErrorMessage('Only Windows is supported to run RPG Maker games')
    return
  }
  var find_exe = async function find_exe(dir: string): Promise<string | undefined> {
    var files = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir))
    for (var [name, type] of files) {
      // If there is Game.ini, there must be Game.exe at the same directory
      if (type === vscode.FileType.File && name.endsWith('.ini')) {
        var name2 = name.replace(/\.ini$/, '.exe')
        if (files.some(e => e[0] === name2 && e[1] === vscode.FileType.File)) {
          return vscode.Uri.joinPath(vscode.Uri.file(dir), name2).fsPath
        }
      }
    }
  }
  var dir = dirname(file)
  var exe = (await find_exe(dir)) || (await find_exe((dir = dirname(dir))))
  if (exe) {
    var p = new vscode.ProcessExecution(exe, ['test', 'console'], { cwd: dir })
    vscode.window.showInformationMessage(`Running ${exe}`)
    vscode.tasks.executeTask(new vscode.Task({ type: 'shell' }, vscode.TaskScope.Workspace, 'Run', 'RPG Maker', p))
  }
}

export function activate(context: vscode.ExtensionContext): void {
  var fs = new RGSS_Scripts()

  var p = vscode.workspace.workspaceFolders?.find(e => e.uri.scheme === 'rgss')?.uri.fsPath
  var info = p ? RGSS_Scripts.parse(p) : null
  context.subscriptions.push(vscode.window.registerTreeDataProvider('rgss.scripts', new RGSS_Scripts_Tree(fs, info?.file)))

  context.subscriptions.push(vscode.workspace.registerFileSystemProvider('rgss', fs, { isCaseSensitive: true }))

  context.subscriptions.push(vscode.commands.registerCommand('rgss.open', mount))
  context.subscriptions.push(vscode.commands.registerCommand('rgss.close', unmount))

  context.subscriptions.push(vscode.commands.registerCommand('rgss.insert', item => fs.ni(item)))
  context.subscriptions.push(vscode.commands.registerCommand('rgss.delete', item => fs.rm(item)))
  context.subscriptions.push(vscode.commands.registerCommand('rgss.rename', item => fs.mv(item)))

  context.subscriptions.push(vscode.commands.registerCommand('rgss.run', run.bind(null, info?.file)))
}
