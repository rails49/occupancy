import type { R49Archive, ReferencePoint, Image, Layout, Point } from '@rails49/r49';

/**
 * Undo/redo for the editor, as scoped snapshots of the manifest.
 *
 * A plain module, not an element: each `EditSession` owns one instance (see
 * `ui/README.md` § State and data flow). It deliberately does **not** live
 * in `@rails49/r49` — that package is a parser/serializer, and an edit history
 * is an editing-session concept, coupled here to view state that means nothing
 * to the training exporter.
 *
 * Three properties are load-bearing, and each one closes a failure mode:
 *
 * 1. **Snapshots, not inverse commands.** Every entry carries `before` and
 *    `after` clones of the subtree it touched, so undo and redo are one
 *    operation with the fields swapped. There is no per-command inverse to
 *    author, and therefore no way to write one that silently produces a subtly
 *    wrong manifest — the failure that would surface a training run later.
 * 2. **Scoped, not whole-manifest.** Every edit targets exactly one image
 *    record, the layout, or the images array, so an entry costs kilobytes
 *    rather than the hundreds of KB a fully labeled manifest runs to. The
 *    corollary the editor must honour: **key on label `id`, never on object
 *    identity** — applying a snapshot replaces the objects wholesale.
 * 3. **No holes.** A history that silently skips some edits is worse than none,
 *    because the binding teaches the user to trust it. Deleting an image
 *    therefore retains its bytes rather than being excluded as too expensive.
 *
 * @see SPEC.md § Undo and redo
 */

/** What an entry's snapshot covers. Every editor mutation targets exactly one. */
export type HistoryTarget =
  /** `layout` — sensors, calibration, scale, metadata. */
  | { kind: 'layout' }
  /** One image record — its car labels and `labeled_complete`. */
  | { kind: 'image'; filename: string }
  /** The images array itself — add, remove, reorder. */
  | { kind: 'images' };

/**
 * One object an entry changed, for the reveal to point at.
 *
 * Keyed the way the editor keys everything else: by `id` where the format gives
 * one, because applying a snapshot replaces the objects wholesale and an index
 * or a reference would name a different object a moment later. A calibration
 * point has no id — nothing references one individually — so it is named by the
 * pixel it sits on, which is the same handle `_pointIsStillAt` uses.
 *
 * It is a **candidate**, not a promise that the object is there: an undone
 * *add* changed a car that no longer exists once the snapshot lands, and
 * resolving is the consumer's job (see `rr-editor-view`).
 */
export type HistoryHighlight =
  | { readonly kind: 'car'; readonly id: string }
  | { readonly kind: 'sensor'; readonly id: string }
  | { readonly kind: 'calibration'; readonly px: Point };

/**
 * One undoable edit. Returned by {@link EditHistory.undo} and
 * {@link EditHistory.redo} so the caller can satisfy the navigation invariant:
 * an undo that changes another image must reveal that image before the user is
 * told anything happened.
 */
export interface HistoryEntry {
  /** Human phrase, rendered as "Undo <label>". */
  readonly label: string;
  readonly target: HistoryTarget;
  /** Retained bytes for images this entry can bring back. */
  readonly blobs: ReadonlyMap<string, Uint8Array>;
  /** Approximate retained size, the unit the budget is spent in. */
  readonly bytes: number;
  /**
   * The objects this entry moved, added or removed — what a reveal highlights.
   *
   * Computed once, from the entry's own two snapshots, and therefore the same
   * list in both directions: undo and redo are one operation with the fields
   * swapped, so they touch the same objects. Empty for an edit with no
   * sub-image geometry to point at — a completeness toggle, a rename, a scale.
   */
  readonly highlights: readonly HistoryHighlight[];
}

/**
 * The image an entry has to bring into view before it lands, or `undefined`
 * when it touches nothing image-scoped.
 *
 * The navigation invariant in one function (`SPEC.md` § Undo and redo): undo may
 * move the user, but it may never change something they cannot see.
 * `EditSession` asks it before every undo and redo.
 *
 * `null` is accepted because it is asked of the *pending* entry, and an empty
 * stack has none: "no entry" and "an entry about no image" both mean "do not
 * move the user".
 */
export function revealTarget(entry: HistoryEntry | null): string | undefined {
  return entry?.target.kind === 'image' ? entry.target.filename : undefined;
}

interface MutableEntry extends HistoryEntry {
  before: string;
  after: string;
  blobs: Map<string, Uint8Array>;
}

/**
 * Which objects differ between an entry's two snapshots.
 *
 * A **diff, not a record of what the caller meant**: the mutation is an opaque
 * callback here, so the only honest answer to "what changed" is the one the
 * snapshots give — and it is the answer that stays right when one gesture moves
 * two cars, or when a delete takes a `labeled_complete` with it.
 *
 * Identity is `id` for cars and sensors and the **whole point** for calibration
 * points, which carry no id. A moved object therefore appears twice, once at
 * each end of the move; the consumer resolves both against the manifest as it
 * stands after the apply, and exactly one of them is there.
 *
 * An `images` entry yields nothing, and a `layout.scale` edit yields nothing:
 * neither changes an object the overlay draws. What an images entry changed is
 * the image list, which the thumbnail bar shows whole; what a scale edit
 * changed is every car rectangle at once, and lighting all of them would be a
 * highlight that points at nothing in particular.
 */
export function changedObjects(
  target: HistoryTarget,
  before: string,
  after: string
): readonly HistoryHighlight[] {
  switch (target.kind) {
    case 'images':
      return [];
    case 'image': {
      const labels = (json: string) => (JSON.parse(json) as Image | null)?.labels ?? [];
      return changedIds(labels(before), labels(after)).map(id => ({ kind: 'car', id }) as const);
    }
    case 'layout': {
      const layout = (json: string) => JSON.parse(json) as Layout | null;
      const b = layout(before);
      const a = layout(after);
      return [
        ...changedIds(b?.sensors ?? [], a?.sensors ?? []).map(
          id => ({ kind: 'sensor', id }) as const
        ),
        ...changedPoints(b?.calibration.points ?? [], a?.calibration.points ?? []).map(
          px => ({ kind: 'calibration', px }) as const
        ),
      ];
    }
  }
}

/** Ids whose object is absent from one side, or different on the two. */
function changedIds(
  before: readonly { readonly id: string }[],
  after: readonly { readonly id: string }[]
): string[] {
  const index = (items: readonly { readonly id: string }[]) =>
    new Map(items.map(item => [item.id, JSON.stringify(item)]));
  const b = index(before);
  const a = index(after);
  return [...new Set([...b.keys(), ...a.keys()])].filter(id => b.get(id) !== a.get(id));
}

/**
 * The pixels of the calibration points one side has and the other does not.
 *
 * By **value**, because a point has no id and its index is not a name — a
 * deletion renumbers every point after it, and a diff by index would light up
 * the whole tail. A point that moved is in neither intersection, so both of its
 * positions come back; a point whose world coordinate was retyped comes back
 * once, since the pixel it is grabbed by is the same one.
 */
function changedPoints(
  before: readonly ReferencePoint[],
  after: readonly ReferencePoint[]
): Point[] {
  const key = (p: ReferencePoint) =>
    `${p.px.x},${p.px.y}|${p.world.x},${p.world.y},${p.world.z}`;
  const b = new Set(before.map(key));
  const a = new Set(after.map(key));

  const pixels: Point[] = [];
  const seen = new Set<string>();
  for (const point of [...before, ...after]) {
    if (b.has(key(point)) && a.has(key(point))) continue;
    const px = `${point.px.x},${point.px.y}`;
    if (seen.has(px)) continue;
    seen.add(px);
    pixels.push(point.px);
  }
  return pixels;
}

/**
 * A gesture in progress: one drag, which will cost **one** entry or none.
 *
 * `record` brackets a single mutation, which a drag is not — it mutates on
 * every pointer-move and must still be one Cmd+Z. So the snapshot is taken when
 * the gesture opens (pointer-down), the caller mutates as freely as it likes,
 * and {@link commit} closes it (pointer-up).
 *
 * That the entry covers **more than one object** falls out of the target being
 * a subtree rather than an object: a coupler drag moves two cars inside one
 * image record, and one `{kind: 'image'}` gesture already covers both.
 *
 * @see SPEC.md § Undo and redo — "one entry is one gesture"
 */
export interface HistoryGesture {
  /**
   * Closes the gesture, recording one entry if the subtree actually changed.
   *
   * @returns whether an entry was recorded. `false` for a drag returned to its
   *   origin — a no-op suppressed by value comparison, not by trusting that the
   *   user meant it — and for a gesture that was already closed.
   */
  commit(): Promise<boolean>;
}

/** The open gesture's own state. Held by the history, not by the caller. */
interface OpenGesture {
  readonly label: string;
  readonly target: HistoryTarget;
  readonly before: string;
}

/** A gesture with nothing to record: no archive is attached. */
const INERT_GESTURE: HistoryGesture = { commit: async () => false };

/**
 * Default retention ceiling.
 *
 * A byte budget rather than an entry count, because entries are heterogeneous
 * by three orders of magnitude: a label edit clones ~10 KB, a deleted image
 * retains megabytes of JPEG. "100 entries" is 1 MB or 800 MB depending on what
 * the user happened to do, which makes it useless as a bound.
 *
 * The property this buys: in a pure labeling session — no image removals, the
 * overwhelmingly common case — this is tens of thousands of entries, so undo
 * reaches all the way back to the state the archive was opened in. The budget
 * only bites when images are being deleted, which is when retention genuinely
 * is expensive and a saved file is the fallback.
 *
 * A UI constant: a browser memory ceiling agrees with nothing outside `ui/`,
 * and `ui/` reads no generated config (#236).
 */
export const DEFAULT_HISTORY_BUDGET_BYTES = 256 * 1024 * 1024;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class EditHistory {
  private _archive: R49Archive | null = null;
  private _entries: MutableEntry[] = [];
  /** Number of entries currently applied; the boundary between undo and redo. */
  private _index = 0;
  /** `_index` as of the last save. Negative once eviction passes it. */
  private _savedIndex = 0;
  private _bytes = 0;
  private readonly _budgetBytes: number;
  /** The gesture currently open, or null. At most one — see {@link beginGesture}. */
  private _gesture: OpenGesture | null = null;

  constructor(budgetBytes: number = DEFAULT_HISTORY_BUDGET_BYTES) {
    this._budgetBytes = budgetBytes;
  }

  /**
   * Binds the history to an archive, discarding any existing stack.
   *
   * New and Open replace the archive wholesale, which invalidates every scoped
   * snapshot in it — so clearing is not a policy choice here, it is the only
   * correct behaviour. Attaching also resets the save marker, so a
   * freshly-opened archive is not dirty.
   */
  attach(archive: R49Archive | null): void {
    this._archive = archive;
    this._entries = [];
    this._index = 0;
    this._savedIndex = 0;
    this._bytes = 0;
    // A gesture holds a snapshot of the archive being replaced, so it cannot
    // survive the replacement. Dropping it here is also what keeps an
    // uncommitted gesture from wedging undo permanently.
    this._gesture = null;
  }

  get canUndo(): boolean {
    return this._index > 0;
  }

  get canRedo(): boolean {
    return this._index < this._entries.length;
  }

  /**
   * The edit `undo()` would reverse, **without** reversing it, or null.
   *
   * What the affordances are named from, and what lets a caller honour the
   * order the navigation invariant states: an entry scoped to another image
   * selects that image *first*, then applies. Reading the entry off the stack
   * is the only way to know which image that is before the snapshot lands.
   */
  get undoEntry(): HistoryEntry | null {
    return this.canUndo ? this._entries[this._index - 1] : null;
  }

  /** The edit `redo()` would reapply, without reapplying it. Mirror of {@link undoEntry}. */
  get redoEntry(): HistoryEntry | null {
    return this.canRedo ? this._entries[this._index] : null;
  }

  /** Label of the edit `undo()` would reverse, or null. */
  get undoLabel(): string | null {
    return this.undoEntry?.label ?? null;
  }

  /** Label of the edit `redo()` would reapply, or null. */
  get redoLabel(): string | null {
    return this.redoEntry?.label ?? null;
  }

  /**
   * Whether the archive differs from what was last saved.
   *
   * Falls out of the save marker rather than needing separate bookkeeping, and
   * it is what gates the three destructive acts undo structurally cannot cover:
   * New and Open take the stack with them, and closing or reloading the tab
   * takes the whole session (#49).
   */
  get isDirty(): boolean {
    return this._index !== this._savedIndex;
  }

  /** Entries currently retained. Undo reaches back at most this far. */
  get size(): number {
    return this._entries.length;
  }

  /** Bytes currently retained, against {@link DEFAULT_HISTORY_BUDGET_BYTES}. */
  get bytes(): number {
    return this._bytes;
  }

  /**
   * Marks the current position as saved. Called after a successful export —
   * saving does not clear the history, because the bytes on disk are unaffected
   * by anything undone afterwards, so undoing past a save stays legitimate.
   */
  markSaved(): void {
    this._savedIndex = this._index;
  }

  /**
   * Runs a mutation and records it, if it changed anything.
   *
   * **Every manifest mutation in the editor must go through this.** Nothing in
   * the compiler enforces it: a component that reaches into `.archive` directly
   * still typechecks, still renders, and leaves a stack that is wrong rather
   * than merely short.
   *
   * @param label Human phrase for the affordance — "delete image".
   * @param target The subtree the mutation touches. Getting this wrong is the
   *   one class of bug scoped snapshots admit, which is what the round-trip
   *   test in `tests/history.test.ts` exists to catch.
   * @param mutate Performs the edit. May be async.
   * @param options.retain Filenames whose bytes must survive the mutation, for
   *   an edit that removes images. Read *before* `mutate` runs, since removal
   *   drops them from the zip.
   * @returns Whatever `mutate` returned.
   */
  async record<T>(
    label: string,
    target: HistoryTarget,
    mutate: () => T | Promise<T>,
    options?: { retain?: string[] }
  ): Promise<T> {
    const archive = this._archive;
    if (!archive) return await mutate();

    if (this._gesture) {
      // Nesting is a caller bug, not a state to support: the gesture's own
      // commit would record this mutation a second time. Noisy rather than
      // silent, like an unretained removal.
      console.warn(
        `EditHistory: "${label}" was recorded inside the open gesture ` +
          `"${this._gesture.label}"; the gesture will record it again.`
      );
    }

    const blobs = new Map<string, Uint8Array>();
    for (const filename of options?.retain ?? []) {
      const data = await archive.getImage(filename);
      if (data) blobs.set(filename, data);
    }

    const before = JSON.stringify(this._read(target));
    const result = await mutate();
    const after = JSON.stringify(this._read(target));

    // No-op suppression: a drag returned to its origin, a reclassify to the
    // class it already had, a retyped identical name. None may consume a slot.
    if (before === after) return result;

    if (target.kind === 'images') {
      await this._retainImageBytes(archive, before, after, blobs);
    }

    this._push(label, target, before, after, blobs);
    return result;
  }

  /**
   * Opens a gesture — a drag — that will cost one entry or none.
   *
   * Called at **pointer-down**, so the snapshot is of the state before anything
   * moved; the caller then mutates on every pointer-move and calls
   * {@link HistoryGesture.commit} at pointer-up. Recording per motion event
   * instead would make a drag across the image two hundred presses of Cmd+Z.
   *
   * Only one gesture is open at a time: a second press during a drag is a
   * second finger, and the editor ignores it rather than starting a gesture the
   * first one's commit would close.
   *
   * Every gesture owes an ending, because an abandoned one holds undo shut
   * until the archive is replaced. `commit()` pushes before it yields, so a
   * caller closing a stale gesture and opening the next in the same handler
   * records both, in order.
   *
   * `target` carries the same obligation as in {@link record} — declare the
   * subtree actually touched — and is what lets one entry cover several
   * objects, since a coupler drag's two cars share one image record. Gestures
   * move geometry, never image bytes, so there is no `retain` here.
   */
  beginGesture(label: string, target: HistoryTarget): HistoryGesture {
    if (!this._archive) return INERT_GESTURE;

    const gesture: OpenGesture = { label, target, before: JSON.stringify(this._read(target)) };
    this._gesture = gesture;

    return {
      commit: async () => {
        // Identity, not just presence: a gesture dropped by `attach` or already
        // closed by an earlier commit must record nothing. Pointer-up and
        // pointer-cancel can both arrive for one gesture.
        if (this._gesture !== gesture) return false;
        this._gesture = null;

        const after = JSON.stringify(this._read(target));
        if (after === gesture.before) return false;

        this._push(label, target, gesture.before, after, new Map());
        return true;
      },
    };
  }

  /** Appends an entry, discarding the abandoned redo branch and evicting. */
  private _push(
    label: string,
    target: HistoryTarget,
    before: string,
    after: string,
    blobs: Map<string, Uint8Array>
  ): void {
    let bytes = before.length + after.length;
    for (const data of blobs.values()) bytes += data.byteLength;

    // Linear redo: any new edit discards the abandoned branch.
    this._drop(this._entries.splice(this._index));
    this._entries.push({
      label,
      target,
      before,
      after,
      blobs,
      bytes,
      // Diffed once, here, rather than on every reveal: the snapshots are
      // immutable from this point, so the answer cannot change, and a reveal is
      // on the keystroke path where an undo of a fully labeled image would
      // otherwise re-parse both snapshots.
      highlights: changedObjects(target, before, after),
    });
    this._index = this._entries.length;
    this._bytes += bytes;
    this._evict();
  }

  /**
   * Reverses the most recent edit.
   *
   * @returns The entry that was reversed, so the caller can reveal what it
   *   changed, or null if there was nothing to undo.
   */
  async undo(): Promise<HistoryEntry | null> {
    // Not while a drag is live. The gesture has already mutated the manifest
    // outside the stack, so applying an older snapshot over it would leave the
    // commit that follows comparing against a `before` that never existed. The
    // press ends first; the next one undoes normally.
    if (this._gesture || !this.canUndo) return null;
    const entry = this._entries[this._index - 1];
    await this._apply(entry, entry.before);
    this._index--;
    return entry;
  }

  /** Reapplies the next edit. Mirror of {@link undo}, gesture guard included. */
  async redo(): Promise<HistoryEntry | null> {
    if (this._gesture || !this.canRedo) return null;
    const entry = this._entries[this._index];
    await this._apply(entry, entry.after);
    this._index++;
    return entry;
  }

  /**
   * Makes an images entry reversible in **both** directions.
   *
   * An entry that changes the image list moves bytes, not just manifest rows,
   * and the two directions need opposite timing:
   *
   * * A **removal** loses its bytes when it runs, so they must be read before —
   *   which only the caller can arrange, via `retain`.
   * * An **addition** is the mirror: undoing it deletes the bytes from the zip,
   *   so *redo* needs them. They are still there once the mutation has run, so
   *   this captures them automatically and the caller need not think about it.
   *
   * The warning is deliberate. A removal whose bytes nobody retained produces
   * an entry that restores a manifest row naming an image that is not in the
   * archive — a hole, and holes are what this design refuses everywhere. Better
   * noisy in the console than discovered by a user pressing Cmd+Z.
   */
  private async _retainImageBytes(
    archive: R49Archive,
    before: string,
    after: string,
    blobs: Map<string, Uint8Array>
  ): Promise<void> {
    const names = (json: string) => new Set((JSON.parse(json) as Image[]).map((img) => img.filename));
    const wasPresent = names(before);
    const isPresent = names(after);

    for (const filename of isPresent) {
      if (wasPresent.has(filename) || blobs.has(filename)) continue;
      const data = await archive.getImage(filename);
      if (data) blobs.set(filename, data);
    }
    for (const filename of wasPresent) {
      if (isPresent.has(filename) || blobs.has(filename)) continue;
      console.warn(
        `EditHistory: "${filename}" was removed without retaining its bytes; ` +
          'undo will restore the manifest entry but not the image. Pass it in options.retain.'
      );
    }
  }

  /** Reads the target subtree out of the live manifest. */
  private _read(target: HistoryTarget): Layout | Image | Image[] | null {
    const manifest = this._archive!.getManifest();
    switch (target.kind) {
      case 'layout':
        return manifest.layout;
      case 'image':
        return manifest.images.find((img) => img.filename === target.filename) ?? null;
      case 'images':
        return manifest.images;
    }
  }

  private async _apply(entry: MutableEntry, snapshot: string): Promise<void> {
    const archive = this._archive;
    if (!archive) return;
    const manifest = archive.getManifest();
    const data = JSON.parse(snapshot);

    switch (entry.target.kind) {
      case 'layout':
        manifest.layout = data as Layout;
        return;

      case 'image': {
        if (data === null) return;
        const image = data as Image;
        const index = manifest.images.findIndex((img) => img.filename === image.filename);
        if (index >= 0) manifest.images[index] = image;
        return;
      }

      case 'images': {
        // Reconcile the zip's payload before the manifest, so a restored entry
        // never names bytes that are not there.
        const wanted = data as Image[];
        const wantedNames = new Set(wanted.map((img) => img.filename));
        const present = new Set(manifest.images.map((img) => img.filename));

        for (const filename of present) {
          if (!wantedNames.has(filename)) archive.removeImage(filename);
        }
        for (const filename of wantedNames) {
          if (present.has(filename)) continue;
          const bytes = entry.blobs.get(filename);
          if (bytes) await archive.addImage(filename, bytes);
        }
        manifest.images = clone(wanted);
        return;
      }
    }
  }

  /**
   * Spends the budget down by dropping the oldest entries.
   *
   * Truncates the tail; never removes a middle entry to reclaim a large blob.
   * A hole would be invisible until the user undid into it, which is the exact
   * failure this design refuses everywhere else. The newest entry is always
   * kept, even if it alone exceeds the budget: discarding what the user just
   * did is a worse answer than exceeding a memory target.
   */
  private _evict(): void {
    while (this._bytes > this._budgetBytes && this._entries.length > 1) {
      const [evicted] = this._entries.splice(0, 1);
      this._bytes -= evicted.bytes;
      this._index--;
      this._savedIndex--;
    }
  }

  private _drop(entries: MutableEntry[]): void {
    for (const entry of entries) this._bytes -= entry.bytes;
  }
}
