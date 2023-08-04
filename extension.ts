'use strict'

import * as vscode from 'vscode'
import * as marshal from '@hyrious/marshal'
import * as fs from 'fs'
import * as zlib from 'zlib'

declare var console: { log(...args: any[]): void }

class RGSS_Scripts implements vscode.FileSystemProvider {
  private _encoder = new TextEncoder()
  private _decoder = new TextDecoder()

  public currentFile: vscode.Uri | undefined

  public scripts: [magic: number, title: string, code: Uint8Array][] | null = null

  async refresh(): Promise<void> {
    const uri = this.currentFile
    if (uri && uri.fsPath) {
      const buffer = await fs.promises.readFile(uri.fsPath)
      const buffer2 = new Uint8Array(buffer).buffer
      const scripts: [number, ArrayBuffer, ArrayBuffer][] = marshal.load(buffer2, { decodeString: false })
      const scripts2: [number, string, Uint8Array][] = []
      for (const [magic, title_, code_] of scripts) {
        const title = this._decoder.decode(title_)
        const code = new Uint8Array(zlib.inflateSync(code_))
        scripts2.push([magic, title, code])
      }
      this.scripts = scripts2
    } else {
      this.scripts = null
    }
  }

  flush(): void {
    if (!this.scripts || !this.currentFile) return

    const scripts: [number, ArrayBuffer, ArrayBuffer][] = []
    for (const [magic, title, code] of this.scripts) {
      const title_ = this._encoder.encode(title)
      const code_ = new Uint8Array(zlib.deflateSync(code)).buffer
      scripts.push([magic, title_, code_])
    }
    const buffer = marshal.dump(scripts)

    fs.writeFileSync(this.currentFile.fsPath, Buffer.from(buffer))
  }

  private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>()
  private _bufferedEvents: vscode.FileChangeEvent[] = []
  private _fireSoonHandle: NodeJS.Timer | undefined

  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event

  watch(_uri: vscode.Uri): vscode.Disposable {
    // ignore, fires for all changes...
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

  private _parse(uri: vscode.Uri): { index: number; title: string } | undefined {
    const parts = uri.path.split('/')
    if (parts.length !== 2) return undefined

    const match = parts[1].match(/^(\d+)-(.*)\.rb$/)
    if (!match) return undefined

    const index = parseInt(match[1])
    if (isNaN(index)) return undefined

    return { index, title: match[2] }
  }

  private _lookup(uri: vscode.Uri, silent: false): vscode.FileStat
  private _lookup(uri: vscode.Uri, silent: boolean): vscode.FileStat | undefined
  private _lookup(uri: vscode.Uri, silent: boolean): vscode.FileStat | undefined {
    if (!this.scripts) throw vscode.FileSystemError.Unavailable(uri)

    if (uri.path === '/') return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 }

    const parsed = this._parse(uri)
    if (!parsed) return this._notFound(uri, silent)

    const { index } = parsed

    const script = this.scripts[index]
    if (!script) return this._notFound(uri, silent)

    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: script[2].length }
  }

  private _lookupAsDirectory(uri: vscode.Uri, silent: false): vscode.FileStat
  private _lookupAsDirectory(uri: vscode.Uri, silent: boolean): vscode.FileStat | undefined
  private _lookupAsDirectory(uri: vscode.Uri, silent: boolean): vscode.FileStat | undefined {
    const entry = this._lookup(uri, silent)
    if (!entry || entry.type === vscode.FileType.Directory) return entry
    else throw vscode.FileSystemError.FileNotADirectory(uri)
  }

  private _lookupAsFile(uri: vscode.Uri, silent: false): vscode.FileStat
  private _lookupAsFile(uri: vscode.Uri, silent: boolean): vscode.FileStat | undefined
  private _lookupAsFile(uri: vscode.Uri, silent: boolean): vscode.FileStat | undefined {
    const entry = this._lookup(uri, silent)
    if (!entry || entry.type === vscode.FileType.File) return entry
    else throw vscode.FileSystemError.FileIsADirectory(uri)
  }

  private _notFound(uri: vscode.Uri, silent: boolean): vscode.FileStat | undefined {
    if (silent) return undefined
    else throw vscode.FileSystemError.FileNotFound(uri)
  }

  private _padZero(i: number): string {
    return String(i).padStart(3, '0')
  }

  private _noPermission(): never {
    throw vscode.FileSystemError.NoPermissions("Can only write to 'rgss:/{index}-{title}'")
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    return this._lookup(uri, false)
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    this._lookupAsDirectory(uri, false)

    const result: [string, vscode.FileType][] = []
    const n = this.scripts!.length
    for (let i = 0; i < n; ++i) {
      const script = this.scripts![i]
      if (!script) continue

      const [_magic, title] = script
      const name = this._padZero(i) + '-' + title + '.rb'
      result.push([name, vscode.FileType.File])
    }

    return result
  }

  readFile(uri: vscode.Uri): Uint8Array {
    this._lookupAsFile(uri, false)

    const { index } = this._parse(uri)!

    const [_magic, _title, code] = this.scripts![index]
    return code
  }

  writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): void {
    if (!this.scripts) throw vscode.FileSystemError.Unavailable(uri)

    const parsed = this._parse(uri)
    if (!parsed) this._noPermission()

    const { index, title } = parsed

    let script = this.scripts[index]
    if (!script && !options.create) throw vscode.FileSystemError.FileNotFound(uri)

    if (script && options.create && !options.overwrite) throw vscode.FileSystemError.FileExists(uri)

    if (script) {
      script[1] = title
      script[2] = content
    } else {
      script = [(Math.random() * 32768) | 0, title, content]
      this.scripts[index] = script
    }

    this.flush()
    this._fireSoon({ type: vscode.FileChangeType.Changed, uri })
  }

  rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): void {
    if (!this.scripts) throw vscode.FileSystemError.Unavailable(oldUri)

    if (!options.overwrite && this._lookup(newUri, true)) throw vscode.FileSystemError.FileExists(newUri)

    const parsed = this._parse(oldUri)
    if (!parsed || !this.scripts[parsed.index]) throw vscode.FileSystemError.FileNotFound(oldUri)

    const parsed2 = this._parse(newUri)
    if (!parsed2) this._noPermission()

    const { index } = parsed
    const { index: index2, title } = parsed2

    const script = this.scripts[index]!
    this.scripts[index2] = [script[0], title, script[2]]
    if (index !== index2) delete this.scripts[index]

    this.flush()
    this._fireSoon(
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri },
    )
  }

  delete(uri: vscode.Uri): void {
    if (!this.scripts) throw vscode.FileSystemError.Unavailable(uri)

    const parsed = this._parse(uri)
    if (!parsed || !this.scripts[parsed.index]) throw vscode.FileSystemError.FileNotFound(uri)

    const { index } = parsed
    delete this.scripts[index]

    this.flush()
    this._fireSoon({ type: vscode.FileChangeType.Deleted, uri })
  }

  createDirectory(_uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions("Can't create directory in 'rgss:/'")
  }
}

let cache: vscode.Uri | undefined

export function activate(context: vscode.ExtensionContext) {
  console.log('Hello, world!')

  const rgssFS = new RGSS_Scripts()
  if (cache) {
    rgssFS.currentFile = cache
    rgssFS.refresh()
  }

  context.subscriptions.push(vscode.workspace.registerFileSystemProvider('rgss', rgssFS, { isCaseSensitive: false }))

  context.subscriptions.push(
    vscode.commands.registerCommand('rgss.open', async function open() {
      const fileUri = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Open',
        filters: { 'RGSS Scripts': ['rvdata2'] },
      })

      if (fileUri && fileUri[0]) {
        rgssFS.currentFile = cache = fileUri[0]
        await rgssFS.refresh()
        vscode.workspace.updateWorkspaceFolders(0, 0, { uri: vscode.Uri.parse('rgss:/'), name: 'RGSS Scripts' })
      }
    }),
  )
}
