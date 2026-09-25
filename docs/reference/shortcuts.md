---
title: Keyboard shortcuts and menus
description: Every Kubermeister keyboard shortcut and menu item on macOS, Windows and Linux — the cheat sheet, moving between domains, refreshing, searching, back and forward, the command palette, where the keys work, the YAML editor and the edit fields.
sidebar:
  order: 6
---

Kubermeister's own shortcuts are listed below and on the cheat sheet, which `?` opens. The rest of
this page is the application menu, the command palette, and the standard keys of the editor and
dialogs the app is built from.

In the tables, `⌘` is Command on macOS and `Ctrl` is Control on Windows and Linux; a key written as
`⌘`/`Ctrl` is `⌘` on macOS and `Ctrl` elsewhere.

## The app's own shortcuts

| Keys                                              | Does                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| `⌘K`/`Ctrl+K`                                     | Opens the command palette, or closes it                                    |
| `⌘1` … `⌘6` / `Ctrl+1` … `Ctrl+6`                 | Goes to Overview, Workloads, Network, Storage, Access or Add-ons           |
| `⌘[` / `⌘]` on macOS, `Alt+←` / `Alt+→` elsewhere | Goes back / forward; the mouse's back and forward buttons do the same      |
| `⌘R`/`Ctrl+R`                                     | Refreshes the screen's data, as its **Refresh** button does                |
| `/`, or `⌘F`/`Ctrl+F`                             | Puts the cursor in the screen's search box: a list's, or a log console's   |
| `⌘,`/`Ctrl+,`                                     | Opens Settings                                                             |
| `?`                                               | Opens the keyboard shortcuts cheat sheet                                   |
| `⇧⌘R` / `Ctrl+Shift+R`                            | Reloads the window, which ends every port forward, shell and log follow    |
| `⌘Q`                                              | Quits, after [asking](/docs/reference/settings/#quitting) (macOS)          |
| `Ctrl+W` or `Alt+F4`                              | Closes the window, which quits after asking (Windows and Linux)            |
| `↑` `↓` `←` `→`                                   | Moves between tabs in a detail page's left rail, when a rail tab has focus |
| `Return`                                          | Applies the replica count you typed in the **Scale** popover               |
| `Return` / `Escape`                               | Saves a Settings text field, or puts back what was there                   |

A number goes to the first screen of its domain: `⌘2` opens Pods, `⌘6` opens Charts. `⌘R` refreshes
only what the screen's own **Refresh** button would, and spins it; on a screen without one it
re-reads everything the screen shows. It no longer reloads the window. `/` does nothing on a screen
without a search box.

On macOS `Ctrl+K` opens the palette as well as `⌘K`. The palette and the other chords match the
key's position rather than its letter, so they work with Caps Lock on and with non-Latin layouts.

In the detail rail the arrow keys run through every tab in order, across the groups, and wrap from
the last tab to the first.

## Where the keys work

- **In a text field**, `/` and `?` type themselves; only the chords act.
- **In the Shell tab**, every key a shell reads goes to the shell: on Windows and Linux no `Ctrl` or
  `Alt` chord is taken from it, so `Ctrl+R` searches the shell's history and `Ctrl+W` deletes a word.
  On macOS the `⌘` chords still act, since no shell reads them, and `Ctrl+K` goes to the shell.
- **In the YAML editor**, its own keys win: `⌘F`/`Ctrl+F` opens its search, and `⌘[` / `⌘]` on
  macOS and `Alt+←` / `Alt+→` elsewhere are its own. `⌘K`, `⌘R` and `⌘1` to `⌘6` still act.
- **With a dialog, a popover or a menu open**, it has `Escape` and its own keys first, and the app's
  shortcuts wait until it closes. `⌘K`/`Ctrl+K` closes the palette it opened.

## The command palette

The palette is titled **Quick actions**. Type to filter, move with `↑` and `↓`, choose with
`Return`, and close with `Escape`. It lists:

- **Contexts** — switch to any context in your kubeconfig;
- **Namespaces** — switch to any namespace of the current context;
- **Actions** — **Create resource**; **Check for updates**, which runs a check and opens Settings;
  and **Keyboard shortcuts**, which opens the cheat sheet;
- every screen in the sidebar, grouped by domain, then **Settings**.

## Menus

### macOS

| Menu             | Items                                                                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Kubermeister** | About Kubermeister, **Check for Updates…**, **Settings…** (`⌘,`), Services, Hide Kubermeister (`⌘H`), Hide Others (`⌥⌘H`), Show All, **Quit Kubermeister** (`⌘Q`) |
| **Edit**         | Undo (`⌘Z`), Redo (`⇧⌘Z`), Cut (`⌘X`), Copy (`⌘C`), Paste (`⌘V`), Paste and Match Style (`⌥⇧⌘V`), Delete, Select All (`⌘A`), Speech                               |
| **View**         | **Refresh** (`⌘R`), Force Reload (`⇧⌘R`), Toggle Developer Tools (`⌥⌘I`), Actual Size (`⌘0`), Zoom In (`⌘+`), Zoom Out (`⌘-`), Toggle Full Screen (`⌃⌘F`)         |
| **Window**       | Minimize (`⌘M`), Zoom, Bring All to Front                                                                                                                         |
| **Help**         | **Keyboard Shortcuts** (`?`), **Report a Bug…**, **Kubermeister on GitHub**                                                                                       |

### Windows and Linux

| Menu       | Items                                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **File**   | **Settings…** (`Ctrl+,`), **Check for Updates…**, **Quit**                                                                                                                                  |
| **Edit**   | Undo (`Ctrl+Z`), Redo (`Ctrl+Y` on Windows, `Ctrl+Shift+Z` on Linux), Cut (`Ctrl+X`), Copy (`Ctrl+C`), Paste (`Ctrl+V`), Delete, Select All (`Ctrl+A`)                                      |
| **View**   | **Refresh** (`Ctrl+R`), Force Reload (`Ctrl+Shift+R`), Toggle Developer Tools (`Ctrl+Shift+I`), Actual Size (`Ctrl+0`), Zoom In (`Ctrl++`), Zoom Out (`Ctrl+-`), Toggle Full Screen (`F11`) |
| **Window** | Minimize (`Ctrl+M`), Close (`Ctrl+W`)                                                                                                                                                       |
| **Help**   | **Keyboard Shortcuts** (`?`), **Report a Bug…**, **Kubermeister on GitHub**                                                                                                                 |

The items in bold are Kubermeister's own; the rest are Electron's standard items.

- **Settings…** opens the Settings screen.
- **Check for Updates…** checks and answers in native dialogs, which work even when the window has
  not finished loading. See [updates](/docs/reference/updates/#where-you-see-it).
- **Quit** asks first unless you have turned that off. **File › Quit** has no shortcut.
- **Refresh** re-reads the screen's data, as `⌘R`/`Ctrl+R` does.
- **Keyboard Shortcuts** opens the cheat sheet, as `?` does.
- **Report a Bug…** opens the bug report form on GitHub in your browser, with the version filled in,
  and **Kubermeister on GitHub** opens the repository. Both work when the window is blank.
- **Force Reload** starts the window afresh, which ends every port forward, shell and log follow it
  had open. It is the one way left to reload the window.
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

- **`Tab`** first reaches **Skip to content**, which moves focus past the sidebar and top bar to the
  screen. See [accessibility](/docs/reference/accessibility/#moving-through-the-window).

- **Dialogs and popovers** close with `Escape`.
- **The Shell tab** sends what you type to the shell in the pod; the terminal adds no shortcuts of its
  own. See [where the keys work](#where-the-keys-work).
- **The log viewer** has no keys of its own beyond `/` for its search: its filters and view options
  are all controls in its toolbar.
