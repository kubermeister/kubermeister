---
title: Keyboard shortcuts and menus
description: Every Kubermeister menu item on macOS, Windows and Linux, and every keyboard shortcut in the app — the command palette, Settings, quitting, the detail tab rail, the YAML editor and the edit fields.
sidebar:
  order: 6
---

Kubermeister has few shortcuts of its own. Most of what is here is the application menu, the command
palette, and the standard keys of the editor and dialogs it is built from.

In the tables, `⌘` is Command on macOS and `Ctrl` is Control on Windows and Linux; a key written as
`⌘`/`Ctrl` is `⌘` on macOS and `Ctrl` elsewhere.

## The app's own shortcuts

| Keys                | Does                                                      | Where                 |
| ------------------- | --------------------------------------------------------- | --------------------- |
| `⌘K` or `Ctrl+K`    | Opens the command palette, or closes it                   | anywhere, every OS    |
| `⌘,`                | Opens Settings                                            | macOS only            |
| `⌘Q`                | Quits, after [asking](/docs/reference/settings/#quitting) | macOS only            |
| `Alt+F4`            | Closes the window, which quits after asking               | Windows and Linux     |
| `↑` `↓` `←` `→`     | Moves between tabs in a detail page's left rail           | a focused rail tab    |
| `Return`            | Applies the replica count you typed                       | the **Scale** popover |
| `Return` / `Escape` | Saves the field, or puts back what was there              | Settings text fields  |

Either modifier opens the palette on every platform: `⌘K` and `Ctrl+K` both work on macOS, which is
why the sidebar's **Quick actions** button shows `⌘K` everywhere. The palette matches the key's
position rather than its letter, so it works with Caps Lock on and with non-Latin layouts.

On Windows and Linux, Settings has no shortcut: open it from **File › Settings…**, the sidebar or the
palette. The same goes for quitting, which is **File › Quit**.

In the detail rail the arrow keys run through every tab in order, across the groups, and wrap from
the last tab to the first.

## The command palette

The palette is titled **Quick actions**. Type to filter, move with `↑` and `↓`, choose with
`Return`, and close with `Escape`. It lists:

- **Contexts** — switch to any context in your kubeconfig;
- **Namespaces** — switch to any namespace of the current context;
- **Actions** — **Create resource**, and **Check for updates**, which runs a check and opens Settings;
- every screen in the sidebar, grouped by domain, then **Settings**.

## Menus

### macOS

| Menu             | Items                                                                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Kubermeister** | About Kubermeister, **Check for Updates…**, **Settings…** (`⌘,`), Services, Hide Kubermeister (`⌘H`), Hide Others (`⌥⌘H`), Show All, **Quit Kubermeister** (`⌘Q`) |
| **Edit**         | Undo (`⌘Z`), Redo (`⇧⌘Z`), Cut (`⌘X`), Copy (`⌘C`), Paste (`⌘V`), Paste and Match Style (`⌥⇧⌘V`), Delete, Select All (`⌘A`), Speech                               |
| **View**         | Reload (`⌘R`), Force Reload (`⇧⌘R`), Toggle Developer Tools (`⌥⌘I`), Actual Size (`⌘0`), Zoom In (`⌘+`), Zoom Out (`⌘-`), Toggle Full Screen (`⌃⌘F`)              |
| **Window**       | Minimize (`⌘M`), Zoom, Bring All to Front                                                                                                                         |
| **Help**         | **Report a Bug…**, **Kubermeister on GitHub**                                                                                                                     |

### Windows and Linux

| Menu       | Items                                                                                                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **File**   | **Settings…**, **Check for Updates…**, **Quit**                                                                                                                                        |
| **Edit**   | Undo (`Ctrl+Z`), Redo (`Ctrl+Y` on Windows, `Ctrl+Shift+Z` on Linux), Cut (`Ctrl+X`), Copy (`Ctrl+C`), Paste (`Ctrl+V`), Delete, Select All (`Ctrl+A`)                                 |
| **View**   | Reload (`Ctrl+R`), Force Reload (`Ctrl+Shift+R`), Toggle Developer Tools (`Ctrl+Shift+I`), Actual Size (`Ctrl+0`), Zoom In (`Ctrl++`), Zoom Out (`Ctrl+-`), Toggle Full Screen (`F11`) |
| **Window** | Minimize (`Ctrl+M`), Close (`Ctrl+W`)                                                                                                                                                  |
| **Help**   | **Report a Bug…**, **Kubermeister on GitHub**                                                                                                                                          |

The items in bold are Kubermeister's own; Edit, View and Window are Electron's standard menus.

- **Settings…** opens the Settings screen.
- **Check for Updates…** checks and answers in native dialogs, which work even when the window has
  not finished loading. See [updates](/docs/reference/updates/#where-you-see-it).
- **Quit** asks first unless you have turned that off. **File › Quit** has no shortcut.
- **Report a Bug…** opens the bug report form on GitHub in your browser, with the version filled in,
  and **Kubermeister on GitHub** opens the repository. Both work when the window is blank.
- **Reload** and **Force Reload** start the window afresh, which ends every port forward, shell and
  log follow it had open.
- **Close** on Windows and Linux closes the only window, which quits the app, and asks first like
  **Quit**. On macOS there is no Close item: closing the window with its button leaves the app
  running, and clicking the Dock icon opens it again, but it ends every port forward, shell and log
  follow the window had open, without asking.

## The YAML editor

The Manifest tab and the Create resource screen use a CodeMirror editor, with its standard keys.
Here `Mod` is `⌘` on macOS and `Ctrl` elsewhere.

| Keys                                                                          | Does                                         |
| ----------------------------------------------------------------------------- | -------------------------------------------- |
| `Tab` / `Shift+Tab`                                                           | Indents / outdents the line or selection     |
| `Mod+F`                                                                       | Opens search in the editor                   |
| `Mod+G` or `F3`, with `Shift` to go back                                      | Next / previous match                        |
| `Escape`                                                                      | Closes the search panel                      |
| `Mod+Alt+G`                                                                   | Goes to a line                               |
| `Mod+D`                                                                       | Selects the next occurrence of the selection |
| `Mod+Shift+L`                                                                 | Selects every occurrence of the selection    |
| `Mod+Z`                                                                       | Undo                                         |
| `Mod+Shift+Z` on macOS, `Mod+Y` elsewhere                                     | Redo                                         |
| `Mod+/`                                                                       | Comments or uncomments the line              |
| `Alt+↑` / `Alt+↓`                                                             | Moves the line up / down                     |
| `Shift+Alt+↑` / `Shift+Alt+↓`                                                 | Copies the line up / down                    |
| `Mod+[` / `Mod+]`                                                             | Outdents / indents                           |
| `Mod+Alt+[` / `Mod+Alt+]` on macOS, `Ctrl+Shift+[` / `Ctrl+Shift+]` elsewhere | Folds / unfolds the block                    |

Search, go-to-line and selection work in the read-only viewer too; only edits are refused.

Because `Tab` indents, it does not move focus out of the editor. Press `Escape` and then `Tab`
within two seconds to leave it.

## Elsewhere

- **Dialogs and popovers** close with `Escape`.
- **The Shell tab** sends what you type to the shell in the pod; the terminal adds no shortcuts of its
  own.
- **The log viewer** has none: its search, filters and view options are all controls in its toolbar.
