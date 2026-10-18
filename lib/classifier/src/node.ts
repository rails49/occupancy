import * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import { type Point } from '@rails49/r49';
import { BaseClassifier, type ClassifierConfig } from './base.ts';

export class NodeClassifier extends BaseClassifier {
  async load(modelPath: string) {
    try {
      this._session = await ort.InferenceSession.create(modelPath);
      console.log('ONNX node session loaded successfully');
    } catch (err) {
      console.error('Failed to load ONNX model in node', err);
      throw err;
    }
  }

  async classify(
    image: Buffer | sharp.Sharp,
    point: Point,
    img_dpt: number
  ): Promise<string[]> {
    if (!this._session) return [];

    const { sx, sy, srcSize, cropSize } = this.getScalingMath(point, img_dpt);

    // Extract patch using Sharp
    const pipeline = (image && (image as any).constructor.name === 'Sharp') 
      ? (image as sharp.Sharp).clone() 
      : sharp(image as Buffer | Uint8Array);

    const metadata = await pipeline.metadata();
    if (!metadata.width || !metadata.height) throw new Error('Could not get image dimensions');

    let left = Math.round(sx);
    let top = Math.round(sy);
    let width = Math.round(srcSize);
    let height = Math.round(srcSize);

    // Clamping
    if (left < 0) left = 0;
    if (top < 0) top = 0;
    if (left + width > metadata.width) left = metadata.width - width;
    if (top + height > metadata.height) top = metadata.height - height;
    
    // Final safety check
    if (left < 0) left = 0;
    if (top < 0) top = 0;
    if (width > metadata.width) width = metadata.width;
    if (height > metadata.height) height = metadata.height;

    const cropBuffer = await pipeline
      .extract({ left, top, width, height })
      .resize({ width: cropSize, height: cropSize, kernel: 'linear' as any })
      .raw()
      .toBuffer();

    const inputTensor = this.preprocessToTensor(
      cropBuffer,
      cropSize,
      (data, dims) => new ort.Tensor('float32', data, dims)
    );

    const feeds = { [this._session.inputNames[0]]: inputTensor };
    const results = await this._session.run(feeds);
    const output = results[this._session.outputNames[0]];
    
    return this.getLabelsFromResult(output.data as Float32Array);
  }
}
