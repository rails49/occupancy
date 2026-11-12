import { describe, it, expect } from 'vitest';
import { fixture, html, oneEvent } from '@open-wc/testing';
import '../src/rr-thumbnail-bar.js';
import { RRThumbnailBar } from '../src/rr-thumbnail-bar.js';

describe('rr-thumbnail-bar', () => {
  const images = ['img1.jpg', 'img2.jpg'];

  it('is defined', () => {
    const el = document.createElement('rr-thumbnail-bar');
    expect(el).to.be.instanceOf(RRThumbnailBar);
  });

  it('renders correct number of thumbnails', async () => {
    const el = await fixture<RRThumbnailBar>(html`
      <rr-thumbnail-bar .images=${images}></rr-thumbnail-bar>
    `);
    const thumbs = el.shadowRoot!.querySelectorAll('img');
    expect(thumbs.length).to.equal(2);
  });

  it('highlights the selected thumbnail', async () => {
    const el = await fixture<RRThumbnailBar>(html`
      <rr-thumbnail-bar .images=${images} .selectedIndex=${1}></rr-thumbnail-bar>
    `);
    const thumbs = el.shadowRoot!.querySelectorAll('img');
    expect(thumbs[0].classList.contains('active')).to.be.false;
    expect(thumbs[1].classList.contains('active')).to.be.true;
  });

  it('emits rr-image-select when a thumbnail is clicked', async () => {
    const el = await fixture<RRThumbnailBar>(html`
      <rr-thumbnail-bar .images=${images}></rr-thumbnail-bar>
    `);
    const thumb = el.shadowRoot!.querySelector('img')!;
    
    setTimeout(() => thumb.click());
    const ev = await oneEvent(el, 'rr-image-select');
    
    expect(ev.detail.index).to.equal(0);
  });

  it('emits rr-image-delete when delete button is clicked', async () => {
    const el = await fixture<RRThumbnailBar>(html`
      <rr-thumbnail-bar .images=${images}></rr-thumbnail-bar>
    `);
    const deleteBtn = el.shadowRoot!.querySelector('.delete-btn')!;
    
    setTimeout(() => (deleteBtn as HTMLElement).click());
    const ev = await oneEvent(el, 'rr-image-delete');
    
    expect(ev.detail.index).to.equal(0);
  });

  it('emits rr-image-add when add buttons are clicked', async () => {
    const el = await fixture<RRThumbnailBar>(html`
      <rr-thumbnail-bar></rr-thumbnail-bar>
    `);
    const addBtns = el.shadowRoot!.querySelectorAll('.add-btn');
    
    // Test Camera
    setTimeout(() => (addBtns[0] as HTMLElement).click());
    const ev1 = await oneEvent(el, 'rr-image-add');
    expect(ev1.detail.source).to.equal('camera');

    // Test File
    setTimeout(() => (addBtns[1] as HTMLElement).click());
    const ev2 = await oneEvent(el, 'rr-image-add');
    expect(ev2.detail.source).to.equal('file');
  });

  // A service page adds pictures from the service's camera alone (#381).
  describe('on a service page', () => {
    const adds = (el: RRThumbnailBar) => {
      const seen: string[] = [];
      el.addEventListener('rr-image-add', e => seen.push((e as CustomEvent).detail.source));
      return seen;
    };

    it('offers no file button without `files`', async () => {
      const el = await fixture<RRThumbnailBar>(html`
        <rr-thumbnail-bar .files=${false}></rr-thumbnail-bar>
      `);
      const buttons = el.shadowRoot!.querySelectorAll('.add-btn');
      expect(buttons).to.have.length(1);

      const seen = adds(el);
      (buttons[0] as HTMLElement).click();
      expect(seen).to.deep.equal(['camera']);
    });

    it('sends nothing from a disabled camera button, and says it is disabled', async () => {
      const el = await fixture<RRThumbnailBar>(html`
        <rr-thumbnail-bar .cameraDisabled=${true}></rr-thumbnail-bar>
      `);
      const camera = el.shadowRoot!.querySelector('.add-btn') as HTMLElement;
      const seen = adds(el);

      camera.click();

      expect(seen).to.deep.equal([]);
      expect(camera.getAttribute('aria-disabled')).to.equal('true');
    });

    it('offers no add, delete or reorder when read-only', async () => {
      const el = await fixture<RRThumbnailBar>(html`
        <rr-thumbnail-bar .images=${images} .readOnly=${true}></rr-thumbnail-bar>
      `);

      expect(el.shadowRoot!.querySelectorAll('.add-btn')).to.have.length(0);
      expect(el.shadowRoot!.querySelectorAll('.delete-btn')).to.have.length(0);
      expect(el.shadowRoot!.querySelector('.thumbnail-wrapper')!.getAttribute('draggable')).to.equal('false');
    });
  });

  // Scanning a set for which images are done is the workflow (`SPEC.md`
  // § Labeling completeness), so the flag has to read off the strip itself.
  describe('the completeness badge', () => {
    it('marks every complete image and no incomplete one', async () => {
      const el = await fixture<RRThumbnailBar>(html`
        <rr-thumbnail-bar .images=${images} .complete=${[false, true]}></rr-thumbnail-bar>
      `);
      const wrappers = el.shadowRoot!.querySelectorAll('.thumbnail-wrapper');

      expect(wrappers[0].querySelector('.complete-badge')).to.not.exist;
      expect(wrappers[1].querySelector('.complete-badge')).to.exist;
    });

    it('treats a missing flag as incomplete', async () => {
      // `complete` is a parallel array, so a caller that has not caught up
      // renders unmarked rather than throwing.
      const el = await fixture<RRThumbnailBar>(html`
        <rr-thumbnail-bar .images=${images}></rr-thumbnail-bar>
      `);
      expect(el.shadowRoot!.querySelectorAll('.complete-badge')).to.have.length(0);
    });

    it('carries no control of its own, so a click on it selects the image', async () => {
      // The badge is a readout: the assertion is made through the editor's own
      // checkbox, so a click aimed at selecting an image can never assert
      // completeness by landing a few pixels off. `pointer-events: none` is
      // what makes the badge transparent to that click — jsdom does not apply
      // it, so what is asserted here is that the badge binds no handler and the
      // wrapper's own click still reports a selection.
      const el = await fixture<RRThumbnailBar>(html`
        <rr-thumbnail-bar .images=${images} .complete=${[true, true]}></rr-thumbnail-bar>
      `);
      const badge = el.shadowRoot!.querySelector('.complete-badge') as HTMLElement;
      const seen: number[] = [];
      el.addEventListener('rr-image-select', e => seen.push((e as CustomEvent).detail.index));

      badge.click();
      expect(seen, 'the badge itself reports nothing').to.deep.equal([]);

      // The same pixel, reaching the image underneath as the browser delivers
      // it: still a selection and nothing more.
      el.shadowRoot!.querySelectorAll('img')[0].click();
      expect(seen).to.deep.equal([0]);
    });
  });

  it('emits rr-image-reorder when a thumbnail is dropped', async () => {
    const el = await fixture<RRThumbnailBar>(html`
      <rr-thumbnail-bar .images=${['img1.jpg', 'img2.jpg']}></rr-thumbnail-bar>
    `);
    const wrappers = el.shadowRoot!.querySelectorAll('.thumbnail-wrapper');
    
    // Simulate drag and drop
    const dragStartEvent = new Event('dragstart', { 
      bubbles: true,
      composed: true
    });
    (dragStartEvent as any).dataTransfer = {
      effectAllowed: '',
      setData: () => {}
    };
    wrappers[0].dispatchEvent(dragStartEvent);
    
    const dropEvent = new Event('drop', { 
      bubbles: true,
      composed: true
    });
    (dropEvent as any).preventDefault = () => {};
    setTimeout(() => wrappers[1].dispatchEvent(dropEvent));
    
    const ev = await oneEvent(el, 'rr-image-reorder');
    expect(ev.detail.from).to.equal(0);
    expect(ev.detail.to).to.equal(1);
  });
});
