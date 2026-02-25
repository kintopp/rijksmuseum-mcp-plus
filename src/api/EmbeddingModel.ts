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
  private queryPrefix = "query: ";
  private targetDim = 0;

  /**
   * Initialize the model. Downloads from HuggingFace Hub on first use,
   * or loads from a local cache/path.
   *
   * @param modelId   - HuggingFace model ID or local path
   * @param targetDim - MRL truncation target dimension (0 = no truncation).
   *                    Pass embeddingsDb.vectorDimensions so the query-time
   *                    vector matches what was stored during harvest.
   */
  async init(modelId: string = "Xenova/multilingual-e5-small", targetDim = 0): Promise<void> {
    this._modelId = modelId;
    this.targetDim = targetDim;

    // EmbeddingGemma uses a different prefix convention than E5 models.
    if (modelId.toLowerCase().includes("embeddinggemma")) {
      this.queryPrefix = "task: search result | query: ";
    }

    try {
      const { pipeline } = await import("@huggingface/transformers");
      this.pipe = await pipeline("feature-extraction", modelId, {
        dtype: "q8",   // int8 quantized ONNX
      });
      console.error(`Embedding model loaded: ${modelId}${targetDim > 0 ? ` (MRL ${targetDim}d)` : ""}`);
    } catch (err) {
      console.error(`Failed to load embedding model: ${err instanceof Error ? err.message : err}`);
      this.pipe = null;
    }
  }

  get available(): boolean { return this.pipe !== null; }
  get modelId(): string { return this._modelId; }

  /**
   * Embed a single query string. Returns a Float32Array.
   *
   * Applies the model-appropriate query prefix (E5: "query: ";
   * EmbeddingGemma: "task: search result | query: "). When targetDim is set
   * and the model outputs more dimensions than targetDim, truncates and
   * re-normalizes — required for MRL models like EmbeddingGemma.
   */
  async embed(text: string): Promise<Float32Array> {
    if (!this.pipe) throw new Error("Embedding model not initialized");

    const output = await this.pipe(this.queryPrefix + text, {
      pooling: "mean",
      normalize: true,
    });

    // dtype: "q8" quantizes internal ONNX weights, but the pipeline dequantizes
    // before pooling/normalization — output.data is always Float32Array.
    // EmbeddingsDb.stmtQuantize also normalizes at search time via
    // vec_normalize(), so vectors are double-normalized (harmless for unit vectors).
    let vec = new Float32Array(output.data);

    // MRL truncation: when the DB was built at a lower dimension than the model
    // outputs (e.g. EmbeddingGemma 768d → 256d), truncate and re-normalize so the
    // query vector is in the same space as the stored embeddings.
    if (this.targetDim > 0 && vec.length > this.targetDim) {
      vec = vec.slice(0, this.targetDim);
      let norm = 0;
      for (const v of vec) norm += v * v;
      norm = Math.sqrt(norm);
      if (norm > 1e-10) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    }

    return vec;
  }
}
