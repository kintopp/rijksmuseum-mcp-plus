/**
 * Query-time EmbeddingGemma 2 text encoder (transformers.js, ONNX on CPU).
 *
 * Loads the text tower only: the stored image vectors already cover the image side,
 * and the feature-extraction pipeline would also load the vision and audio encoders
 * (~+325 MB RSS for nothing).
 */
import { logInfo, logError } from "../utils/log.js";

const QUERY_PREFIX = "task: search result | query: ";
export const GEMMA_MODEL_ID = "onnx-community/embeddinggemma-2-ONNX";
/** Pinned so a re-export upstream can't silently shift the query space away from gemma.db. */
export const GEMMA_MODEL_REVISION = "daa72c51243991dfcaf9f9137d2c573d8f7790c0";

export class GemmaModel {
  // transformers.js model/tokenizer types are too broad to express usefully.
  private model: any = null;
  private tokenizer: any = null;

  async init(): Promise<void> {
    const dtype = process.env.GEMMA_MODEL_DTYPE ?? "q8";
    // onnxruntime sizes its pool from the visible cores, not the cgroup quota —
    // on Railway that oversubscribes and triples latency. Always set it.
    const threads = Number(process.env.GEMMA_THREADS ?? 2);
    try {
      const { AutoConfig, AutoModel, AutoTokenizer, env } = await import("@huggingface/transformers");
      if (process.env.HF_HOME) {
        env.cacheDir = process.env.HF_HOME;
        env.useFSCache = true;
      }
      const opts = { revision: GEMMA_MODEL_REVISION };
      const config: any = await AutoConfig.from_pretrained(GEMMA_MODEL_ID, opts);
      config.vision_config = config.audio_config = null;
      this.model = await AutoModel.from_pretrained(GEMMA_MODEL_ID, {
        ...opts,
        config,
        dtype: dtype as any,
        device: "cpu",
        session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 },
      });
      this.tokenizer = await AutoTokenizer.from_pretrained(GEMMA_MODEL_ID, opts);
      logInfo(`Gemma model loaded: ${GEMMA_MODEL_ID} (${dtype}, ${threads} threads)`);
    } catch (err) {
      logError("Failed to load Gemma model", err, { modelId: GEMMA_MODEL_ID });
      this.model = this.tokenizer = null;
    }
  }

  get available(): boolean { return this.model !== null && this.tokenizer !== null; }

  /** Embed a search query (L2-normalised, 768d). */
  async embed(text: string): Promise<Float32Array> {
    if (!this.available) throw new Error("Gemma model not initialized");
    const out = await this.model(await this.tokenizer([QUERY_PREFIX + text]));
    return new Float32Array(out.sentence_embedding.normalize(2, -1).data);
  }
}
