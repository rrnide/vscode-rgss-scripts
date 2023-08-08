import * as vscode from 'vscode'
import * as marshal from '@hyrious/marshal'

declare function inflate(data: ArrayBuffer): Promise<Uint8Array>
declare function deflate(data: Uint8Array): Promise<ArrayBuffer>

type RGSS_Scripts_Data_Item = [magic: number, title: string, code: Uint8Array]
type RGSS_Scripts_Data = RGSS_Scripts_Data_Item[]
type CacheEntry = { stat: vscode.FileStat; contents: RGSS_Scripts_Data }

// Simulate a virtual FS whose path looks like rgss:/path/to/Scripts.rvdata2/001_Title.rb
// Note: use 'vscode.workspace.fs' to access the system FS (works in browser too)
export class RGSS_Scripts implements vscode.FileSystemProvider {
  private readonly _encoder = new TextEncoder()
  private readonly _decoder = new TextDecoder()

  // Cache opened Scripts.rvdata2 files, populate its stats to the contents
  private readonly _cache = new Map<string, CacheEntry>()

  // p = "/path/to/Scripts.rvdata2/001_Title.rb"
  // or "C:\\path\\to\\Scripts.rvdata2\\001_Title.rb" on Windows
  private _parse(p: string): { file: string; index: number; title: string } | undefined {
    if (process.platform === 'win32') {
      p = p.replace(/\\/g, '/')
    }
    var index = p.indexOf('/Scripts.rvdata2')
    if (index < 0) return undefined

    if (p.length === index + 16) {
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
    return `${index.toString().padStart(3, '0')}_${title}.rb`
  }

  private _empty(): RGSS_Scripts_Data_Item {
    return [(Math.random() * 32768) | 0, '', new Uint8Array()]
  }

  private _uri(file: string, arr: RGSS_Scripts_Data, index: number): vscode.Uri {
    return vscode.Uri.joinPath(vscode.Uri.file(file), this._name(index, arr[index][1]))
  }

  private async _flush(file: string, contents: RGSS_Scripts_Data): Promise<void> {
    for (var i = contents.length - 1; i >= 0; i--) {
      var item = contents[i]
      if (item[1].length > 0 || item[2].length > 0) {
        break
      }
      this._fireSoon({
        type: vscode.FileChangeType.Deleted,
        uri: this._uri(file, contents, i),
      })
    }
    contents.length = i + 1
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
    exist[1] = ''
    exist[2] = new Uint8Array()

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
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.workspace.registerFileSystemProvider('rgss', new RGSS_Scripts(), { isCaseSensitive: true }))

  context.subscriptions.push(vscode.commands.registerCommand('rgss.open', mount))

  context.subscriptions.push(vscode.commands.registerCommand('rgss.close', unmount))
}
