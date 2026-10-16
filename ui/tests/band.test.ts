import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { fixture, fixtureCleanup, html } from '@open-wc/testing';
import { R49Archive } from '@occupancy/r49';
import type { LookAbout } from '@rails49/look';
import '../src/rr-app.js';
import { RRApp } from '../src/rr-app.js';
import * as persistence from '../src/persistence.js';

/**
 * The band, as `rr-app` declares it on look's elements: the layout's name and
 * scale, the file a save would land in, and the gear.
 */

vi.mock('../src/persistence.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/persistence.js')>()),
  openArchive: vi.fn(),
}));

let archive: R49Archive;

beforeEach(() => {
  archive = new R49Archive();
  archive.setManifest({
    version: 4,
    layout: {
      name: 'Test',
      scale: 'N',
      calibration: { points: [], camera_height_mm: 1150 },
      sensors: [],
    },
    camera: { resolution: { width: 1920, height: 1080 } },
    images: [],
  });
});

afterEach(fixtureCleanup);

async function mount(open: R49Archive | null = archive) {
  const el = await fixture<RRApp>(html`<rr-app></rr-app>`);
  (el as any)._archive = open;
  await el.updateComplete;
  return el;
}

const about = (el: RRApp) => el.renderRoot.querySelector<LookAbout>('look-about')!;
const reading = (el: RRApp) => el.renderRoot.querySelector('look-reading');

describe('the band', () => {
  it('says "occupancy" and no scale before an archive is loaded', async () => {
    // The `N` the settings dialog renders against is a placeholder, not an
    // answer any archive gave; stating it here would be the band inventing it.
    const el = await mount(null);
    expect(about(el).name).toBe('occupancy');
    expect(about(el).detail).toBe('');
  });

  // The scale is what the layout's geometry means — a span two pixels long is a
  // different car in N than in HO (#52).
  it('names the layout and its scale', async () => {
    const el = await mount();
    expect(about(el).name).toBe('Test');
    expect(about(el).detail).toBe('N');
  });

  it('follows a scale changed in the settings dialog', async () => {
    const el = await mount();

    await (el as any)._onLayoutChange(
      new CustomEvent('rr-layout-change', { detail: { layout: { scale: 'HO' } } })
    );
    await el.updateComplete;

    expect(about(el).detail).toBe('HO');
  });

  it('shows the bound file only once a save can overwrite it', async () => {
    const el = await mount();
    (el as any)._binding = { stem: 'west-yard' };
    await el.updateComplete;
    expect(reading(el)).toBeNull();

    (el as any)._binding = { stem: 'west-yard', handle: {} as FileSystemFileHandle };
    await el.updateComplete;
    expect(reading(el)?.textContent).toBe('west-yard.r49');
  });

  it('opens the settings dialog from the gear', async () => {
    const el = await mount();
    const show = vi.spyOn(el.renderRoot.querySelector('rr-settings-dialog')!, 'show');

    el.renderRoot.querySelector('look-gear')!.click();

    expect(show).toHaveBeenCalled();
  });

  it('links nowhere: the source link is gone', async () => {
    const el = await mount();
    expect(el.renderRoot.querySelector('[name="github"], a[href]')).toBeNull();
  });

  it('toasts loading rather than writing it on the band', async () => {
    const file = new File([], 'west-yard.r49');
    vi.mocked(persistence.openArchive).mockResolvedValue({ file, binding: { stem: 'west-yard' } });
    const load = vi.spyOn(R49Archive, 'load').mockResolvedValue(archive);
    onTestFinished(() => load.mockRestore());
    const el = await mount(null);
    const notify = vi.spyOn(el as any, '_notify');

    await (el as any)._onFileOpen();
    await el.updateComplete;

    expect(notify).toHaveBeenCalledWith('Loading west-yard.r49…', 'primary', 'hourglass-split');
    expect(about(el).name).toBe('Test');
  });
});
