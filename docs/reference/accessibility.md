---
title: Accessibility
description: Using Kubermeister from the keyboard and with a screen reader — the skip link, the focus outline, what is announced for status, logs, shells, port forwards and drains, and reduced motion.
sidebar:
  order: 7
---

Everything in Kubermeister can be reached from the keyboard, and the parts that change on their own
say so to a screen reader. The keys themselves are listed under
[keyboard shortcuts](/docs/reference/shortcuts/).

## Moving through the window

`Tab` goes through the window in the order it is laid out: the sidebar, the top bar, then the screen.
The first stop is a **Skip to content** button, which shows only while it has focus; `Return` on it
moves focus to the screen itself, past the sidebar and top bar.

Whatever has focus from the keyboard is outlined in the theme's accent colour. The outline shows for
the keyboard only, not for a click.

In a list, `Tab` reaches the column headings, which sort the list, then in each row its selection
checkbox, where the list has one, and the link in its Name column, which opens the object. In a
detail page the left rail is one stop: the arrow keys move between its tabs, and the next `Tab` goes
to the open tab.

## What a screen reader hears

- **Status dots** that stand alone, such as the cluster's health on the context selector or an
  unusable context in its menu, are read by what they mean. A dot beside a word that already says it,
  as in every status badge, is skipped.
- **The context selector** is read as the Kubernetes context control, followed by the context's name
  and the cluster's health.
- **Notifications** are read as they appear.
- **A log console** says when it switches between following, not following and a snapshot. The line
  count is not read on every change, since it changes with every batch of lines.
- **The Shell tab** says when a shell is opening, when it is open, when the session ends, and any
  error it ends with. The terminal itself is drawn on a canvas and is not read.
- **A port forward** reads its status as it changes, such as the local address it listens on or the
  error that stopped it.
- **A drain** reads each pod as it is evicted, and the result at the end.
- **Meters**, such as a list's CPU and memory columns, are read as their percentage.

## Reduced motion

When the operating system is set to reduce motion (**Reduce motion** in macOS's Accessibility
settings, **Animation effects** off in Windows, or the desktop's own setting on Linux), Kubermeister
stops its own animations: dialogs and menus appear without transitions, the Live dot in a log console
stops pulsing, spinners stand still and the shell's cursor stops blinking. The charts never animate.
