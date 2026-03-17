/**
 * ModelUpdater — APEX-2026 Phase 5 (P5.2.2)
 *
 * Watches the models/ directory for new .onnx files.
 * When a new model is detected, signals the Rust bridge to
 * perform an atomic hot-swap using the double-buffer pattern.
 *
 * The Rust side has two model slots (active + inactive).
 * On hot-swap:
 *   1. Load new model into inactive slot
 *   2. Atomic swap (active pointer = inactive slot)
 *   3. Old model is freed on next swap
 *
 * Until Rust ONNX is implemented, this module validates the ONNX file
 * and logs the swap event for the retraining pipeline.
 */

import { EventEmitter } from 'events';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { stat, readdir, readFile } from 'node:fs/promises';
import { resolve, extname, basename } from 'node:path';
import { getFeatureStore } from '../data/FeatureStore.js';

export interface ModelInfo {
  path: string;
  filename: string;
  modelType: 'ppo' | 'tft' | 'hmm' | 'hawkes' | 'unknown';
  sizeBytes: number;
  loadedAt: number;
}

export interface ModelSwapEvent {
  previous: ModelInfo | null;
  current: ModelInfo;
  swapMs: number;
}

const WATCH_INTERVAL_MS = 5_000; // Poll every 5s (fs.watch can be unreliable)
const MODEL_EXTENSIONS = new Set(['.onnx', '.bin', '.pt']);

export class ModelUpdater extends EventEmitter {
  private modelsDir: string;
  private watcher: FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private activeModels: Map<string, ModelInfo> = new Map();
  private knownFiles: Map<string, number> = new Map(); // filename → mtime ms
  private swapCount = 0;

  constructor(modelsDir?: string) {
    super();
    this.modelsDir = modelsDir ?? resolve(process.cwd(), 'models');
    console.log(`🔄 [ModelUpdater] Watching: ${this.modelsDir}`);
  }

  /**
   * Start watching the models directory.
   */
  async start(): Promise<void> {
    if (!existsSync(this.modelsDir)) {
      console.log(`⚠️  [ModelUpdater] Directory not found: ${this.modelsDir}. Will create on first model.`);
      return;
    }

    // Initial scan
    await this.scanDirectory();

    // fs.watch for instant notifications (platform-dependent reliability)
    try {
      this.watcher = watch(this.modelsDir, { persistent: false }, (eventType, filename) => {
        if (filename && MODEL_EXTENSIONS.has(extname(filename))) {
          this.handleFileChange(filename).catch(() => {});
        }
      });
    } catch {
      console.log('⚠️  [ModelUpdater] fs.watch unavailable, using polling only');
    }

    // Polling fallback
    this.pollTimer = setInterval(() => {
      this.scanDirectory().catch(() => {});
    }, WATCH_INTERVAL_MS);

    console.log('✅ [ModelUpdater] Watching started');
  }

  /**
   * Stop watching.
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    console.log('🛑 [ModelUpdater] Stopped');
  }

  /**
   * Scan directory for new/updated model files.
   */
  private async scanDirectory(): Promise<void> {
    try {
      const files = await readdir(this.modelsDir);
      for (const file of files) {
        if (!MODEL_EXTENSIONS.has(extname(file))) continue;

        const fullPath = resolve(this.modelsDir, file);
        const fileStat = await stat(fullPath);
        const mtime = fileStat.mtimeMs;

        const knownMtime = this.knownFiles.get(file);
        if (knownMtime === undefined || mtime > knownMtime) {
          this.knownFiles.set(file, mtime);
          await this.handleFileChange(file);
        }
      }
    } catch {
      // Directory might not exist yet
    }
  }

  /**
   * Handle a new or updated model file.
   */
  private async handleFileChange(filename: string): Promise<void> {
    const fullPath = resolve(this.modelsDir, filename);

    try {
      const fileStat = await stat(fullPath);
      if (fileStat.size < 100) return; // Too small, likely incomplete write

      const modelType = this.inferModelType(filename);
      const t0 = performance.now();

      // Validate ONNX magic bytes
      if (extname(filename) === '.onnx') {
        const valid = await this.validateOnnx(fullPath);
        if (!valid) {
          console.log(`⚠️  [ModelUpdater] Invalid ONNX: ${filename}`);
          return;
        }
      }

      const newModel: ModelInfo = {
        path: fullPath,
        filename,
        modelType,
        sizeBytes: fileStat.size,
        loadedAt: Date.now(),
      };

      const previous = this.activeModels.get(modelType) ?? null;
      this.activeModels.set(modelType, newModel);
      this.swapCount++;

      const swapMs = performance.now() - t0;

      const swapEvent: ModelSwapEvent = { previous, current: newModel, swapMs };
      this.emit('modelSwap', swapEvent);

      // Log to Feature Store model registry
      try {
        getFeatureStore().saveModelParams({
          id: crypto.randomUUID(),
          modelType: modelType === 'unknown' ? 'tft' : modelType as 'hmm' | 'hawkes' | 'tft' | 'rl',
          version: this.swapCount,
          paramsBlob: null,
          metricsJson: JSON.stringify({
            filename,
            sizeBytes: fileStat.size,
            swapMs,
            previousFile: previous?.filename ?? null,
          }),
          isActive: true,
          createdAt: Date.now(),
        });
      } catch {
        // cold path
      }

      console.log(
        `🔄 [ModelUpdater] Hot-swap: ${modelType} → ${filename} ` +
          `(${(fileStat.size / 1024).toFixed(1)} KB) in ${swapMs.toFixed(1)}ms`,
      );

      // TODO: When Rust ONNX is ready, call FFI:
      // bridge.loadModel(fullPath, modelTypeId)
    } catch (err) {
      console.warn(`⚠️  [ModelUpdater] Error processing ${filename}:`, err);
    }
  }

  /**
   * Validate ONNX file by checking protobuf magic bytes.
   */
  private async validateOnnx(path: string): Promise<boolean> {
    try {
      const buf = Buffer.alloc(4);
      const file = Bun.file(path);
      const slice = file.slice(0, 4);
      const bytes = new Uint8Array(await slice.arrayBuffer());
      // ONNX protobuf starts with 0x08 (field 1, varint)
      return bytes.length >= 2 && bytes[0] === 0x08;
    } catch {
      return false;
    }
  }

  /**
   * Infer model type from filename.
   */
  private inferModelType(filename: string): ModelInfo['modelType'] {
    const name = basename(filename).toLowerCase();
    if (name.includes('ppo') || name.includes('rl')) return 'ppo';
    if (name.includes('tft')) return 'tft';
    if (name.includes('hmm')) return 'hmm';
    if (name.includes('hawkes')) return 'hawkes';
    return 'unknown';
  }

  /**
   * Get currently active model for a given type.
   */
  getActiveModel(type: string): ModelInfo | null {
    return this.activeModels.get(type) ?? null;
  }

  getStats() {
    return {
      swapCount: this.swapCount,
      activeModels: Object.fromEntries(
        [...this.activeModels.entries()].map(([k, v]) => [k, v.filename]),
      ),
      knownFiles: this.knownFiles.size,
    };
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let _updater: ModelUpdater | null = null;

export function getModelUpdater(dir?: string): ModelUpdater {
  if (!_updater) {
    _updater = new ModelUpdater(dir);
  }
  return _updater;
}
