import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { R49Archive } from '@rails49/r49';
import { GrayImage } from './image.ts';
import { DecodedArchive } from './cases.ts';

/**
 * The working width every frame is normalized to before anything else
 * happens. Grades are calibrated in these pixels; a scorer that wants a
 * different resolution resamples inside itself, so every candidate sees the
 * same inputs.
 */
export const WORKING_WIDTH = 960;

export async function decodeToGray(bytes: Uint8Array, width = WORKING_WIDTH): Promise<GrayImage> {
  const { data, info } = await sharp(bytes)
    .greyscale()
    .resize({ width })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = new Float32Array(info.width * info.height);
  for (let i = 0; i < out.length; i++) out[i] = data[i] / 255;
  return { width: info.width, height: info.height, data: out };
}

/** Load every *.r49 in a directory and decode its images in manifest order. */
export async function loadArchives(fixturesDir: string, width = WORKING_WIDTH): Promise<DecodedArchive[]> {
  const entries = (await readdir(fixturesDir)).filter((f) => f.endsWith('.r49')).sort();
  if (entries.length === 0) {
    throw new Error(`no .r49 archives in ${fixturesDir}`);
  }
  const archives: DecodedArchive[] = [];
  for (const entry of entries) {
    const archive = await R49Archive.load(await readFile(join(fixturesDir, entry)));
    const manifest = archive.getManifest();
    const images: DecodedArchive['images'] = [];
    for (const { filename } of manifest.images) {
      const bytes = await archive.getImage(filename);
      if (!bytes) continue;
      images.push({ filename, image: await decodeToGray(bytes, width) });
    }
    archives.push({ name: entry, images });
  }
  return archives;
}
