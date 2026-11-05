import { describe, it, expect, beforeEach } from 'vitest';
import { fixture, html } from '@open-wc/testing';
import type { SlInput } from '@shoelace-style/shoelace';
import type { LookDialog } from '@rails49/look';
import '../src/rr-sensor-dialog.js';
import type { RRSensorDialog } from '../src/rr-sensor-dialog.js';
import { REFUSED_SENSOR_ID_CHARACTERS } from '../src/sensorId.js';

/** The id the editor generates at placement, which the dialog opens on. */
const GENERATED = 'S1abcdefghi';

function idField(el: RRSensorDialog): SlInput {
  return el.shadowRoot!.querySelector('#sensor-id')! as SlInput;
}

function nameField(el: RRSensorDialog): SlInput {
  return el.shadowRoot!.querySelector('#sensor-name')! as SlInput;
}

function dialogOf(el: RRSensorDialog): LookDialog {
  return el.shadowRoot!.querySelector('look-dialog')!;
}

/** What the person reads under the id field, or null when nothing is refused. */
function refusal(el: RRSensorDialog): string | null {
  return el.shadowRoot!.querySelector('.refusal')?.textContent?.trim() ?? null;
}

/** Types into the id field the way a person does: a value and an `sl-input`. */
async function typeId(el: RRSensorDialog, text: string) {
  idField(el).value = text;
  idField(el).dispatchEvent(new CustomEvent('sl-input'));
  await el.updateComplete;
}

function confirm(el: RRSensorDialog) {
  (el.shadowRoot!.querySelector('#sensor-confirm') as HTMLElement).click();
}

function pressEnter(field: SlInput) {
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
}

describe('rr-sensor-dialog', () => {
  let el: RRSensorDialog;
  let committed: unknown[];

  beforeEach(async () => {
    el = await fixture<RRSensorDialog>(html`<rr-sensor-dialog></rr-sensor-dialog>`);
    committed = [];
    el.addEventListener('rr-sensor-commit', e => committed.push((e as CustomEvent).detail));
  });

  /** Opens on a sensor, with the ids of the layout's other sensors taken. */
  function open(fields: { id?: string; name?: string | null } = {}, taken: readonly string[] = []) {
    const sensor = { id: fields.id ?? GENERATED, name: fields.name ?? null };
    return el.show(sensor, { taken: [sensor.id, ...taken] });
  }

  describe('the fields', () => {
    it('opens on the sensor it is editing: its id, and a blank name for none', async () => {
      await open();
      expect(idField(el).value).to.equal(GENERATED);
      expect(nameField(el).value).to.equal('');
    });

    it('opens prefilled with the name it has', async () => {
      await open({ name: 'Yard throat' });
      expect(nameField(el).value).to.equal('Yard throat');
    });

    it('resets both fields when reopened, rather than keeping what was typed', async () => {
      await open({ id: 'c3.a', name: 'Yard throat' });
      await typeId(el, 'something else');
      nameField(el).value = 'something else';

      await open({ id: 'c3.a', name: 'Yard throat' });

      expect(idField(el).value).to.equal('c3.a');
      expect(nameField(el).value).to.equal('Yard throat');
    });

    it('clears a refusal left over from the last time it was open', async () => {
      await open();
      await typeId(el, '');
      expect(refusal(el)).not.toBeNull();

      await open();

      expect(refusal(el)).toBeNull();
    });
  });

  describe('the commit', () => {
    it('commits both fields, each trimmed', async () => {
      await open();
      await typeId(el, '  c3.a  ');
      nameField(el).value = '  Yard throat  ';
      confirm(el);

      expect(committed).to.deep.equal([{ id: 'c3.a', name: 'Yard throat' }]);
    });

    it('commits an id with inner spaces, which a controller may already use', async () => {
      await open();
      await typeId(el, 'West yard throat');
      confirm(el);

      expect(committed).to.deep.equal([{ id: 'West yard throat', name: null }]);
    });

    it('commits null for a cleared name, which is how a name is removed', async () => {
      // `name` is absent when unset, never an empty string: a stored `""` would
      // be a name that displays as nothing.
      await open({ name: 'Yard throat' });
      nameField(el).value = '   ';
      confirm(el);

      expect(committed).to.deep.equal([{ id: GENERATED, name: null }]);
    });

    it('commits on Enter, the way a typed form wants to be finished', async () => {
      await open();
      await typeId(el, 'c3.a');
      pressEnter(nameField(el));

      expect(committed).to.deep.equal([{ id: 'c3.a', name: null }]);
    });

    it('commits nothing when dismissed', async () => {
      await open({ name: 'Yard throat' });
      (el.shadowRoot!.querySelector('#sensor-cancel') as HTMLElement).click();

      expect(committed).to.have.length(0);
    });
  });

  describe('a refused id', () => {
    /** Each refusal: the message under the field, the dialog open, no commit. */
    async function expectRefused(typed: string, pattern: RegExp) {
      await typeId(el, typed);
      expect(refusal(el), typed).toMatch(pattern);

      confirm(el);
      pressEnter(idField(el));
      await el.updateComplete;

      expect(refusal(el), typed).toMatch(pattern);
      expect(dialogOf(el).open, typed).toBe(true);
      expect(committed, typed).to.have.length(0);
    }

    it('refuses a blank id', async () => {
      await open();
      await expectRefused('   ', /required/i);
    });

    it('refuses an id another sensor in the layout holds', async () => {
      await open({}, ['c3.a']);
      await expectRefused('c3.a', /already/i);
    });

    it('refuses each character a controller message cannot carry', async () => {
      for (const character of REFUSED_SENSOR_ID_CHARACTERS) {
        await open();
        await expectRefused(`c3${character}a`, /MQTT|XML/);
      }
    });

    it('says nothing and commits once the id is fixed', async () => {
      await open({}, ['c3.a']);
      await typeId(el, 'c3.a');
      expect(refusal(el)).not.toBeNull();

      await typeId(el, 'c3.b');
      expect(refusal(el)).toBeNull();

      confirm(el);
      expect(committed).to.deep.equal([{ id: 'c3.b', name: null }]);
    });

    it('takes C3.A while c3.a is taken: a controller tells the two apart', async () => {
      await open({}, ['c3.a']);
      await typeId(el, 'C3.A');

      expect(refusal(el)).toBeNull();
      confirm(el);
      expect(committed).to.deep.equal([{ id: 'C3.A', name: null }]);
    });

    it('judges the value Save reads, not the last one typed into', async () => {
      // A field written with no `sl-input` in between — the way a script or an
      // autofill writes one — is still judged before anything is committed.
      await open();
      idField(el).value = 'c3+a';
      confirm(el);
      await el.updateComplete;

      expect(refusal(el)).toMatch(/MQTT/);
      expect(committed).to.have.length(0);
    });

    it('never refuses the id the sensor already holds, so its name stays editable', async () => {
      // The format allows any non-empty string, so an archive can hold an id
      // this rule refuses. Editing that sensor's name must not be blocked by it.
      await open({ id: 'c3/a', name: 'Yard throat' });
      expect(refusal(el)).toBeNull();

      nameField(el).value = 'Approach';
      confirm(el);

      expect(committed).to.deep.equal([{ id: 'c3/a', name: 'Approach' }]);
    });
  });
});
