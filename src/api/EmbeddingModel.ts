/**
 * Query-time embedding model using @huggingface/transformers (ONNX/WASM).
 *
 * Uses intfloat/multilingual-e5-small by default — a compact multilingual
 * model (384d) with E5 query/passage prefix conventions.
 */

// ─── EmbeddingModel ──────────────────────────────────────────────────

export class EmbeddingModel {
  // Typed as `any` because @huggingface/transformers pipeline() returns
  // a union type too complex for TypeScript to represent. At runtime,
  // "feature-extraction" always returns a FeatureExtractionPipeline.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pipe: any = null;
  private _modelId: string = "";

  /**
   * Initialize the model. Downloads from HuggingFace Hub on first use,
   * or loads from a local cache/path.
   *
   * @param modelId - HuggingFace model ID or local path
   */
  async init(modelId: string = "intfloat/multilingual-e5-small"): Promise<void> {
    this._modelId = modelId;
    try {
      const { pipeline } = await import("@huggingface/transformers");
      this.pipe = await pipeline("feature-extraction", modelId, {
        dtype: "q8",   // int8 quantized ONNX
      });
      console.error(`Embedding model loaded: ${modelId}`);
    } catch (err) {
      console.error(`Failed to load embedding model: ${err instanceof Error ? err.message : err}`);
      this.pipe = null;
    }
  }

  get available(): boolean { return this.pipe !== null; }
  get modelId(): string { return this._modelId; }

  /**
   * Embed a single query string. Returns a Float32Array of dimension 384.
   *
   * E5 models require a "query: " prefix for queries (vs "passage: " for
   * documents). The prefix is added automatically.
   */
  async embed(text: string): Promise<Float32Array> {
    if (!this.pipe) throw new Error("Embedding model not initialized");

    const output = await this.pipe("query: " + text, {
      pooling: "mean",
      normalize: true,
    });

    // output.data is a TypedArray (Float32Array or similar)
    return new Float32Array(output.data);
  }
}
