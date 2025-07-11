# Changelog

## 0.1.4

- Pick file implement with vscode's builtin `list.find`.
- Automatically close missing files due to index change.
- Update `@hyrious/marshal` to 0.3.3.

## 0.1.3

- Add a pick command to quickly open a script.
- Add a search command to search contents in scripts.
- Add double click handler to search results to jump to the location.

## 0.1.2

- Add a [<q>run</q>](https://code.visualstudio.com/api/extension-guides/virtual-documents) button to directly run the Game.exe.
- Automatically close all tabs when running `Close Scripts.rvdata2` command.
- Automatically reveal the current script in the tree view.

## 0.1.1

- Add a [tree view](https://code.visualstudio.com/api/extension-guides/tree-view) as a replacement for the file explorer.

## 0.1.0

- Add a [file system provider](https://github.com/microsoft/vscode-extension-samples/tree/main/fsprovider-sample) which can open and edit entries in Scripts.rvdata2.\
  Many thanks to the [ZipFS](https://github.com/yarnpkg/berry/tree/master/packages/vscode-zipfs) extension written by Yarn.
