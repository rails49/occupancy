import { describe, it, expect } from 'vitest';
import {
  REFUSED_SENSOR_ID_CHARACTERS,
  sensorId,
  sensorIdRefusal,
} from '../src/sensorId.ts';

/** The judgement a dialog makes on a fresh sensor nobody else collides with. */
const alone = { current: 'S1abcdefghi', taken: ['S1abcdefghi'] };

describe('sensorId', () => {
  it('is the typed text with its ends trimmed', () => {
    expect(sensorId('  c3.a  ')).toBe('c3.a');
  });

  it('keeps the spaces inside, which a name a controller uses may hold', () => {
    expect(sensorId(' West yard throat ')).toBe('West yard throat');
  });
});

describe('sensorIdRefusal', () => {
  it('accepts an id a controller would use', () => {
    expect(sensorIdRefusal('c3.a', alone)).toBeNull();
  });

  it('refuses a blank id, which no controller could name', () => {
    expect(sensorIdRefusal('   ', { current: null, taken: [] })).toMatch(/required/i);
  });

  it('refuses an id another sensor in the layout holds', () => {
    const refusal = sensorIdRefusal('c3.a', { current: 'S1abcdefghi', taken: ['c3.a'] });
    expect(refusal).toMatch(/already/i);
  });

  it('matches a taken id case-sensitively, so C3.A is free while c3.a is taken', () => {
    expect(sensorIdRefusal('C3.A', { current: 'S1abcdefghi', taken: ['c3.a'] })).toBeNull();
  });

  it('judges the trimmed id, so padding cannot smuggle a duplicate in', () => {
    expect(sensorIdRefusal('  c3.a  ', { current: 'S1abcdefghi', taken: ['c3.a'] })).toMatch(
      /already/i
    );
  });

  it('accepts inner spaces', () => {
    expect(sensorIdRefusal('West yard throat', alone)).toBeNull();
  });

  it('refuses each character a controller message cannot carry, saying why', () => {
    expect(REFUSED_SENSOR_ID_CHARACTERS).toHaveLength(6);

    for (const character of REFUSED_SENSOR_ID_CHARACTERS) {
      const refusal = sensorIdRefusal(`c3${character}a`, alone);
      expect(refusal, character).not.toBeNull();
      expect(refusal, character).toMatch(/MQTT|XML/);
    }
  });

  it('names MQTT for + and # and the Rocrail profile for the XML three', () => {
    expect(sensorIdRefusal('c3+a', alone)).toMatch(/MQTT/);
    expect(sensorIdRefusal('c3#a', alone)).toMatch(/MQTT/);
    expect(sensorIdRefusal('c3/a', alone)).toMatch(/MQTT/);
    expect(sensorIdRefusal('c3"a', alone)).toMatch(/XML/);
    expect(sensorIdRefusal('c3<a', alone)).toMatch(/XML/);
    expect(sensorIdRefusal('c3&a', alone)).toMatch(/XML/);
  });

  it('never refuses the id the sensor already holds', () => {
    // An archive authored before this rule, or by another tool, can hold one.
    // Its name must stay editable, so the sensor's own id is always allowed.
    expect(sensorIdRefusal('c3/a', { current: 'c3/a', taken: ['c3/a'] })).toBeNull();
  });

  it('refuses a character in an id a sensor does not hold yet', () => {
    expect(sensorIdRefusal('c3/b', { current: 'c3/a', taken: ['c3/a'] })).not.toBeNull();
  });
});
