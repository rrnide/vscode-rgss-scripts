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
  private _close(uri: vscode.Uri): void {
    var filter = function filter(tab: vscode.Tab) {
      return tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString()
    }
    vscode.window.tabGroups.close(vscode.window.tabGroups.all.flatMap(group => group.tabs.filter(filter)))
  }

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

    vscode.commands.executeCommand('vscode.open', this._uri(tree.file, entry.contents, index))
  }

  async rm({ tree, index }: ScriptItem): Promise<void> {
    if (tree.file == null) return
    var entry = await this._open(tree.file)
    if (index === entry.contents.length) {
      vscode.window.showInformationMessage('Cannot delete the last item')
      return
    }
    if (entry.contents[index][1] || entry.contents[index][2].byteLength > 0) {
      var [_, title, code] = entry.contents[index]
      var answer = await vscode.window.showInformationMessage(
        `Are you sure to delete '${title}' (${code.byteLength} bytes)?`,
        'Yes',
        'No',
      )
      if (answer !== 'Yes') return
    }
    this._close(this._uri(tree.file, entry.contents, index))
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
    if (index < entry.contents.length) {
      this._close(this._uri(tree.file, entry.contents, index))
    }

    item[1] = newTitle
    if (index === entry.contents.length) {
      entry.contents.push(item)
    }

    await this._flush(tree.file, entry.contents)
    this._refreshFilesExplorer()
    tree.refresh()

    vscode.commands.executeCommand('vscode.open', this._uri(tree.file, entry.contents, index))
  }

  // ripgrep
  private _indices(line: string, text: string): number[] {
    var result: number[] = []
    var index = line.indexOf(text)
    while (index >= 0) {
      result.push(index)
      index = line.indexOf(text, index + 1)
    }
    return result
  }

  async rg(file: string, text: string): Promise<GrepLine[]> {
    var entry = await this._open(file)
    var cache: string[][] = Array(entry.contents.length) // { [index]: lines }
    var collect: { index: number; line_: number; columns_: number[] }[] = []
    for (var i = 0; i < entry.contents.length; ++i) {
      var [_, _title, code_] = entry.contents[i]
      var lines = this._decoder.decode(code_).split(/\r\n|\n|\r/g)
      cache[i] = lines
      for (var j = 0; j < lines.length; ++j) {
        var line = lines[j]
        var indices = this._indices(line, text)
        if (indices.length > 0) {
          // Note: [line_] and [columns_] are 0-based here
          collect.push({ index: i, line_: j, columns_: indices })
        }
      }
    }

    var result: GrepLine[] = []
    result.push({ type: 'message', text: `Searching ${entry.contents.length} files for "${text}"`, indices: void 0 })
    result.push({ type: 'message', text: '', indices: void 0 })

    if (collect.length === 0) {
      result.push({ type: 'message', text: '0 matches', indices: void 0 })
      return result
    }

    var max_line_ = -1
    for (var { line_ } of collect) {
      max_line_ = Math.max(max_line_, line_)
    }
    var max_line_width = String(max_line_).length + 2
    var render_line = function render_line(line: number | string, text: string, match: boolean): string {
      return `${String(typeof line === 'number' ? line + 1 : line).padStart(max_line_width, ' ')}${match ? ':' : ' '} ${text}`
    }
    var last_index = -1
    var last_line_ = -1
    for (var i = 0; i < collect.length; ++i) {
      var { index, line_, columns_ } = collect[i]
      if (index !== last_index) {
        if (last_line_ >= 0) {
          var last_lines = cache[last_index]
          for (var line__ = last_line_ + 1; line__ < Math.min(last_lines.length, last_line_ + 3); ++line__) {
            result.push({ type: 'context', text: render_line(line__, last_lines[line__], false), indices: void 0 })
          }
          last_line_ = -1
          result.push({ type: 'message', text: '', indices: void 0 })
        }

        last_index = index
        var [_, title] = entry.contents[index]
        result.push({ type: 'title', text: this._name(index, title) + ':', indices: void 0 })
      }
      if (last_line_ >= 0) {
        for (var line__ = last_line_ + 1; line__ < Math.min(line_, last_line_ + 3, Math.max(0, line_ - 2)); ++line__) {
          result.push({ type: 'context', text: render_line(line__, cache[index][line__], false), indices: void 0 })
        }
        // last_line_ = line__
      }
      for (var line__ = Math.max(0, line_ - 2); line__ < line_; ++line__) {
        if (last_line_ < line__) {
          if (last_line_ >= 0 && last_line_ + 1 < line__) {
            result.push({ type: 'context', text: render_line('..', '', false), indices: void 0 })
          }
          last_line_ = line__
          result.push({ type: 'context', text: render_line(line__, cache[index][line__], false), indices: void 0 })
        }
      }
      result.push({
        type: 'match',
        text: render_line(line_, cache[index][line_], true),
        indices: columns_.map(e => [e, e + text.length]),
      })
      last_line_ = line_
    }
    if (last_line_ >= 0) {
      var last_lines = cache[last_index]
      for (var line__ = last_line_ + 1; line__ < Math.min(last_lines.length, last_line_ + 3); ++line__) {
        result.push({ type: 'context', text: render_line(line__, last_lines[line__], false), indices: void 0 })
      }
      last_line_ = -1
    }

    var matches_text = collect.length <= 1 ? `${collect.length} match` : `${collect.length} matches`
    var files_count = new Set(collect.map(e => e.index)).size
    var files_text = files_count <= 1 ? `${files_count} file` : `${files_count} files`
    result.push({ type: 'message', text: '', indices: void 0 })
    result.push({ type: 'message', text: `${matches_text} across ${files_text}`, indices: void 0 })
    return result
  }
}

interface GrepLine {
  type: 'title' | 'context' | 'match' | 'message'
  text: string // '001_Title.rb' | '  1  def initialize' | '  2: matched code' <- notice the ':'
  indices?: [number, number][] // [start, end]
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

  children: ScriptItem[] | null = null

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
      // Expose to let the tree view instance reveal
      this.children = result
      return result
    } catch {
      vscode.window.showInformationMessage('No mounted Scripts.rvdata2 file')
      return null
    }
  }

  getParent(element: ScriptItem): null {
    return null
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

  var filter = function filter(tab: vscode.Tab) {
    return tab.input instanceof vscode.TabInputText && RGSS_Scripts.parse(tab.input.uri.fsPath)?.file === uri!.fsPath
  }
  vscode.window.tabGroups.close(vscode.window.tabGroups.all.flatMap(group => group.tabs.filter(filter)))
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
  if (file == null) return
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

function reveal(context: { tree: RGSS_Scripts_Tree; viewer: vscode.TreeView<ScriptItem> }, doc: vscode.TextDocument): void {
  if (context.tree.children == null) return
  var item = context.tree.children.find(e => e.uri?.toString() === doc.uri.toString())
  item && !context.viewer.selection.includes(item) && context.viewer.reveal(item, { select: true })
}

async function pick(fs: RGSS_Scripts, file?: string): Promise<void> {
  if (file == null) return
  var files = await fs.readDirectory(vscode.Uri.file(file))
  var items = files.map(([name]) => '$(file) ' + name)
  var selected = await vscode.window.showQuickPick(items, {
    canPickMany: false,
    placeHolder: 'Search files by name',
  })
  if (selected) {
    var path = vscode.Uri.joinPath(vscode.Uri.file(file), selected.slice(8)).path
    vscode.commands.executeCommand('vscode.open', vscode.Uri.from({ scheme: 'rgss', path }))
  }
}

export class RGSS_Scripts_Search_Result implements vscode.TextDocumentContentProvider {
  private _id = 0
  nextId() {
    return this._id++
  }
  private _cache = new Map<number, string>()
  get(id: number): string | undefined {
    return this._cache.get(id)
  }
  set(id: number, text: string): void {
    this._cache.set(id, text)
  }
  delete(id: number): void {
    this._cache.delete(id)
  }

  setAndGetNextId(text: string) {
    var id = this.nextId()
    this.set(id, text)
    return id
  }

  provideTextDocumentContent(uri: vscode.Uri): string | undefined {
    var [id] = uri.path.split('/')
    return this._cache.get(parseInt(id))
  }
}

// uri = 'rgss-search:0/encode(searching-text)/encode(path/to/Scripts.rvdata2)'
export class RGSS_Scripts_Search_Result_Syntax implements vscode.DocumentSemanticTokensProvider {
  static legend = new vscode.SemanticTokensLegend(['enum', 'number', 'function', 'comment'])

  constructor(private readonly search_result: RGSS_Scripts_Search_Result) {}

  provideDocumentSemanticTokens(doc: vscode.TextDocument): vscode.ProviderResult<vscode.SemanticTokens> {
    var [id] = doc.uri.path.split('/')
    var text = this.search_result.get(parseInt(id))
    if (text == null) return

    var builder = new vscode.SemanticTokensBuilder(RGSS_Scripts_Search_Result_Syntax.legend)
    this._matchAll(builder, /^([^ ].*):$/g, text, 'enum')
    this._matchAll(builder, /^ +([0-9]+) /g, text, 'number')
    this._matchAll(builder, /^ +([0-9]+):.*/g, text, 'function')
    return builder.build()
  }

  private _matchAll(builder: vscode.SemanticTokensBuilder, regex: RegExp, text: string, scope: string): void {
    var lines = text.split(/\r\n|\n|\r/g)
    for (var i = 0; i < lines.length; ++i) {
      var line = lines[i]
      var match: RegExpExecArray | null
      while ((match = regex.exec(line))) {
        var start = match.index
        var end = match.index + match[0].length
        builder.push(new vscode.Range(i, start, i, end), scope)
      }
    }
  }
}

export class RGSS_Scripts_Search_Result_Link implements vscode.DefinitionProvider {
  provideDefinition(doc: vscode.TextDocument, pos: vscode.Position): vscode.ProviderResult<vscode.Definition> {
    var [, , file] = doc.uri.path.split('/')
    file = decodeURIComponent(file)

    var line = doc.lineAt(pos.line).text
    var match = /^ +([0-9]+):/.exec(line)
    if (match == null) return
    var row = parseInt(match[1])

    var lines = doc.getText().split(/\r\n|\n|\r/g)
    var name = this._findName(lines, pos.line)
    if (name == null) return

    var uri = vscode.Uri.from({
      scheme: 'rgss',
      path: vscode.Uri.joinPath(vscode.Uri.file(file), name).path,
    })

    var range = new vscode.Range(row - 1, 0, row - 1, line.length)
    return new vscode.Location(uri, range)
  }

  // 001_Title.rb
  private _findName(lines: string[], at: number): string | undefined {
    for (var i = at; i >= 0; --i) {
      var line = lines[i]
      var match = /^([^ ].*):$/.exec(line)
      if (match) return match[1]
    }
  }
}

async function search(fs: RGSS_Scripts, file: string | undefined, search_result: RGSS_Scripts_Search_Result): Promise<void> {
  if (file == null) return
  var text = await vscode.window.showInputBox({ prompt: 'Search' })
  if (text == null) return
  var items = await fs.rg(file, text)
  var content = ''
  for (var e of items) content += e.text + '\n'
  var id = search_result.setAndGetNextId(content)
  var uri = vscode.Uri.from({ scheme: 'rgss-search', path: `${id}/${encodeURIComponent(text)}/${encodeURIComponent(file)}` })
  vscode.commands.executeCommand('vscode.open', uri)
}

function unsearch(search_result: RGSS_Scripts_Search_Result, doc: vscode.TextDocument): void {
  var [id] = doc.uri.path.split('/')
  search_result.delete(parseInt(id))
}

export function activate(context: vscode.ExtensionContext): void {
  var fs = new RGSS_Scripts()

  var p = vscode.workspace.workspaceFolders?.find(e => e.uri.scheme === 'rgss')?.uri.fsPath
  var info = p ? RGSS_Scripts.parse(p) : null
  var tree = new RGSS_Scripts_Tree(fs, info?.file)
  context.subscriptions.push(vscode.window.registerTreeDataProvider('rgss.scripts', tree))
  var viewer = vscode.window.createTreeView('rgss.scripts', { treeDataProvider: tree })

  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(reveal.bind(null, { tree, viewer })))

  context.subscriptions.push(vscode.workspace.registerFileSystemProvider('rgss', fs, { isCaseSensitive: true }))

  var search_result = new RGSS_Scripts_Search_Result()
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('rgss-search', search_result))
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(unsearch.bind(null, search_result)))

  var syntax = new RGSS_Scripts_Search_Result_Syntax(search_result)
  var { legend } = RGSS_Scripts_Search_Result_Syntax
  context.subscriptions.push(vscode.languages.registerDocumentSemanticTokensProvider({ scheme: 'rgss-search' }, syntax, legend))

  var link = new RGSS_Scripts_Search_Result_Link()
  context.subscriptions.push(vscode.languages.registerDefinitionProvider({ scheme: 'rgss-search' }, link))

  context.subscriptions.push(vscode.commands.registerCommand('rgss.open', mount))
  context.subscriptions.push(vscode.commands.registerCommand('rgss.close', unmount))
  context.subscriptions.push(vscode.commands.registerCommand('rgss.pick', pick.bind(null, fs, info?.file)))
  context.subscriptions.push(vscode.commands.registerCommand('rgss.search', search.bind(null, fs, info?.file, search_result)))

  context.subscriptions.push(vscode.commands.registerCommand('rgss.insert', item => fs.ni(item)))
  context.subscriptions.push(vscode.commands.registerCommand('rgss.delete', item => fs.rm(item)))
  context.subscriptions.push(vscode.commands.registerCommand('rgss.rename', item => fs.mv(item)))

  context.subscriptions.push(vscode.commands.registerCommand('rgss.run', run.bind(null, info?.file)))
}
