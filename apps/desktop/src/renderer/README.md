# Phase 2 renderer boundary

The renderer contains two isolated React entry points:

- `ball/` renders the 56 DIP floating shortcut.
- `settings/` renders the minimal shell settings and native status UI.

Both entry points consume role-specific APIs exposed by their preload. Renderer
code must not import Electron, Node.js, SQLite, or a general-purpose IPC client.
Shared snapshot types come from `@desktop-translate/contracts/ui-shell`.
