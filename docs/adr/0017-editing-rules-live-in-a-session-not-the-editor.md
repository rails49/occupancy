# Editing rules live in a session, not the editor

The editing rules live in `ui/src/editSession.ts`, a plain class with no DOM. They cover every manifest write the editor makes and the history target each one picks, the tool and its calibration gate, chaining, drags, the image on screen, and undo and redo. `rr-app` creates one `EditSession` per archive on New and Open and passes it to `rr-editor-view`, and the rail's tools, Undo and Redo call it directly.

Hit-testing is part of the session. The editor passes pointer positions in image pixels together with the pointer event's screen scale, and the session decides what a click, a drag or a right-click means. The editor keeps the click-or-drag threshold, pan and zoom, dialogs and menus, highlights and blob URLs.

The rules were private methods of a Lit element, so they could only be tested by mounting it and sending pointer events. Undo was also split between `rr-app` and the editor. With the session, the rules are tested by direct calls, and undo is one method. Decided in [#169](https://github.com/rails49/occupancy/issues/169).
