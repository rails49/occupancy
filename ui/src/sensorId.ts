/**
 * The rule for a sensor's `id`, and the one place it is declared (#335).
 *
 * The `id` is what a controller knows the sensor by (`SPEC.md` § Occupancy
 * Output): it is generated when the sensor is placed, and a person sets it to
 * the name the controller already uses. Consumers key on it, so it must be
 * there and it must be unique within the layout — which is also what the format
 * requires, refusing a duplicate as `manifest/duplicate-id`.
 *
 * `rr-sensor-dialog` and `EditSession` both judge an id through
 * {@link sensorIdRefusal}, so a refusal shown under the field and a write
 * refused by the session are the same rule rather than two that can drift. The
 * dialog is the one a person sees; the session's check is what makes the rule
 * true of the archive however the editor is driven.
 *
 * **The format is not changed** — it still allows any non-empty string, and this
 * is the editor's narrower rule. That is why an id the rule now refuses still
 * *loads*: see {@link SensorIdContext.current}.
 */

/** A sensor's editable fields: what the dialog commits and the session writes. */
export interface SensorFields {
  /** What a controller knows the sensor by. Judged by {@link sensorIdRefusal}. */
  readonly id: string;
  /** Free text, not unique, and `null` for none — a cleared field removes it. */
  readonly name: string | null;
}

/** What an id is judged against: the sensor it is for, and the layout around it. */
export interface SensorIdContext {
  /**
   * The id the sensor holds now, or null when it has none.
   *
   * Never refused, whatever it contains. An archive authored before this rule —
   * or by another tool, since the format allows any non-empty string — can hold
   * an id with a refused character, and it must still open and its sensor's
   * name must still be editable. Refusing it would make the dialog unusable on
   * exactly the archives that need fixing.
   */
  readonly current: string | null;
  /** Every sensor id in the layout. The current one may be among them. */
  readonly taken: readonly string[];
}

/**
 * Why each refused character is refused, in the order a message names them.
 *
 * Only these, and every other character is allowed — inner spaces included —
 * because the id has to be able to *be* the name a controller already uses. The
 * six are the ones a message carrying the id cannot survive:
 * `+` and `#` are MQTT's wildcards and are illegal in a topic, `/` is its level
 * separator and would split one id into two levels, and `"`, `<` and `&` are
 * markup in the Rocrail profile's XML.
 */
const REFUSALS: ReadonlyMap<string, string> = new Map([
  ['+', 'An id cannot contain “+” — an MQTT topic cannot carry it.'],
  ['#', 'An id cannot contain “#” — an MQTT topic cannot carry it.'],
  ['/', 'An id cannot contain “/” — it adds a level to an MQTT topic.'],
  ['"', 'An id cannot contain a double quote — it breaks the Rocrail profile’s XML.'],
  ['<', 'An id cannot contain “<” — it breaks the Rocrail profile’s XML.'],
  ['&', 'An id cannot contain “&” — it breaks the Rocrail profile’s XML.'],
]);

/** The characters an id may not contain, for a test or a document to enumerate. */
export const REFUSED_SENSOR_ID_CHARACTERS: readonly string[] = [...REFUSALS.keys()];

/**
 * The id a typed string means: the string with its ends trimmed.
 *
 * Trimmed because trailing space is invisible, and an id that differs from
 * another by one would read as the same id everywhere it is shown. Inner spaces
 * are kept: they are part of a name a controller may already use.
 */
export function sensorId(text: string): string {
  return text.trim();
}

/**
 * Why `text` cannot be this sensor's id, as one sentence, or null when it can.
 *
 * Judged on the trimmed id, so padding cannot smuggle a duplicate past the
 * uniqueness check. Matching is **case-sensitive**: a controller tells `c3.a`
 * and `C3.A` apart, so the editor must not fold two distinct ids together.
 *
 * The checks are ordered so the most specific reason wins: an id that is both
 * taken and holds a refused character reports the character, which is the thing
 * the person has to change whatever else is in the layout.
 */
export function sensorIdRefusal(text: string, context: SensorIdContext): string | null {
  const id = sensorId(text);
  if (id === context.current) return null;

  if (id === '') {
    return 'An id is required — it is what a controller knows this sensor by.';
  }
  for (const character of id) {
    const refusal = REFUSALS.get(character);
    if (refusal) return refusal;
  }
  if (context.taken.includes(id)) {
    return 'Another sensor in this layout already has this id.';
  }
  return null;
}
