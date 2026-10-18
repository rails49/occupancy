import { type Point, type ManifestData, getDPT } from '@rails49/r49';
import type { InferenceSession, Tensor } from 'onnxruntime-common';

export interface ClassifierConfig {
  labels: string[];
  dpt: number;
  crop_size: number;
  mean: number[];
  std: number[];
}

/**
 * Platform-agnostic base class for the Occupancy Classifier.
 * Handles configuration, scaling math, and normalization.
 */
export abstract class BaseClassifier {
  protected _session: InferenceSession | null = null;
  protected _config: ClassifierConfig;

  constructor(config: ClassifierConfig) {
    if (!config) {
      throw new Error("Fatal Error: ClassifierConfig is missing.");
    }
    if (!config.labels || !Array.isArray(config.labels) || config.labels.length === 0) {
      throw new Error("Fatal Error: ClassifierConfig.labels must be a non-empty array.");
    }
    if (config.dpt === undefined || config.dpt === null || isNaN(config.dpt)) {
      throw new Error("Fatal Error: ClassifierConfig.dpt must be a valid number.");
    }
    if (config.crop_size === undefined || config.crop_size === null || isNaN(config.crop_size)) {
      throw new Error("Fatal Error: ClassifierConfig.crop_size must be a valid number.");
    }
    if (!config.mean || !Array.isArray(config.mean) || config.mean.length !== 3) {
      throw new Error("Fatal Error: ClassifierConfig.mean must be a 3-element array.");
    }
    if (!config.std || !Array.isArray(config.std) || config.std.length !== 3) {
      throw new Error("Fatal Error: ClassifierConfig.std must be a 3-element array.");
    }
    this._config = config;
  }

  /**
   * Calculates the true Dots Per Track (DPT) from a layout manifest.
   * @throws if the manifest has no calibration data yet.
   */
  static calculateDpt(manifest: ManifestData): number {
    const dpt = getDPT(manifest);
    if (dpt === null) {
      throw new Error('Fatal Error: layout has no calibration data — calibrate it before classifying.');
    }
    return dpt;
  }

  /**
   * Common scaling math to determine the source crop area.
   */
  protected getScalingMath(point: Point, img_dpt: number) {
    const cropSize = this._config.crop_size;
    const scaleFactor = img_dpt / this._config.dpt;
    const srcSize = cropSize * scaleFactor;
    const sx = point.x - srcSize / 2;
    const sy = point.y - srcSize / 2;
    return { sx, sy, srcSize, cropSize };
  }

  /**
   * Shared normalization logic.
   * Converts a flattened RGB buffer [R, G, B, R, G, B, ...] into an ONNX Tensor.
   */
  protected preprocessToTensor(
    rgbData: Uint8Array | Uint8ClampedArray,
    size: number,
    createTensor: (data: Float32Array, dims: number[]) => Tensor
  ): Tensor {
    const area = size * size;
    const floatData = new Float32Array(1 * 3 * area);
    
    const mean = this._config.mean;
    const std = this._config.std;

    for (let i = 0; i < area; i++) {
      // Normalize to 0-1 and apply ImageNet normalization
      // Source data index depends on whether we have 3 channels (Node) or 4 channels (Browser)
      // This is handled by subclasses providing the correct buffer type.
      // For simplicity, we assume the subclass provides a packed 3-channel RGB buffer.
      floatData[i] = (rgbData[i * 3] / 255.0 - mean[0]) / std[0];            // R
      floatData[i + area] = (rgbData[i * 3 + 1] / 255.0 - mean[1]) / std[1];     // G
      floatData[i + 2 * area] = (rgbData[i * 3 + 2] / 255.0 - mean[2]) / std[2]; // B
    }

    return createTensor(floatData, [1, 3, size, size]);
  }

  /**
   * Multi-label logic for classification.
   * Returns all labels with a probability >= 0.5.
   */
  protected getLabelsFromResult(outputData: Float32Array): string[] {
    const labels = this._config.labels;
    const results: string[] = [];
    
    for (let i = 0; i < outputData.length; i++) {
      if (outputData[i] >= 0.5) {
        results.push(labels[i] || `label_${i}`);
      }
    }
    return results;
  }

  abstract load(source: any): Promise<void>;
  abstract classify(image: any, point: Point, img_dpt: number): Promise<string[]>;

  async release() {
    if (this._session) {
      await (this._session as any).release?.();
      this._session = null;
    }
  }
}
