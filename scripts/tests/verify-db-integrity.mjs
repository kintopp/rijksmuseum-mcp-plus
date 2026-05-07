// One-shot integrity verifier for data/vocabulary.db + data/embeddings.db
// after a manual DB swap. Confirms:
//   - sqlite-vec loads against embeddings.db
//   - vec0 KNN (vec_artworks) returns the seed at distance ~0 for self-query
//   - vec0 KNN (vec_desc_artworks) likewise
//   - vec_distance_cosine path agrees with vec0 path on top hit
//   - cross-DB JOIN on art_id resolves the seed to a real artwork row
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

const VOCAB = "data/vocabulary.db";
const EMB = "data/embeddings.db";

const vocab = new Database(VOCAB, { readonly: true });
const emb = new Database(EMB, { readonly: true });
sqliteVec.load(emb);

// 1. Pick a seed art_id that has both an artwork embedding and a desc embedding
const seed = emb
  .prepare(
    `SELECT ae.art_id, ae.object_number, ae.embedding AS art_emb, de.embedding AS desc_emb
     FROM artwork_embeddings ae
     JOIN desc_embeddings de ON de.art_id = ae.art_id
     LIMIT 1`
  )
  .get();
if (!seed) throw new Error("No artwork has both art + desc embeddings");
console.log(`seed art_id=${seed.art_id} object_number=${seed.object_number}`);

// 2. vec0 KNN on vec_artworks — top-1 should be self at distance ~ 0
const knnArt = emb
  .prepare(
    `SELECT artwork_id, distance FROM vec_artworks
     WHERE embedding MATCH vec_int8(?) AND k = 3
     ORDER BY distance`
  )
  .all(seed.art_emb);
console.log("vec_artworks top-3:", knnArt);
if (knnArt[0].artwork_id !== seed.art_id) throw new Error("vec_artworks self-query did not return seed at top-1");
if (knnArt[0].distance > 0.001) throw new Error(`vec_artworks self-distance suspiciously large: ${knnArt[0].distance}`);

// 3. vec0 KNN on vec_desc_artworks — top-1 should be self
const knnDesc = emb
  .prepare(
    `SELECT artwork_id, distance FROM vec_desc_artworks
     WHERE embedding MATCH vec_int8(?) AND k = 3
     ORDER BY distance`
  )
  .all(seed.desc_emb);
console.log("vec_desc_artworks top-3:", knnDesc);
if (knnDesc[0].artwork_id !== seed.art_id) throw new Error("vec_desc_artworks self-query did not return seed at top-1");

// 4. vec_distance_cosine path agreement (regular table)
const cos = emb
  .prepare(
    `SELECT art_id, vec_distance_cosine(vec_int8(embedding), vec_int8(?)) AS distance
     FROM artwork_embeddings
     ORDER BY distance LIMIT 3`
  )
  .all(seed.art_emb);
console.log("artwork_embeddings (cosine) top-3:", cos);
if (cos[0].art_id !== seed.art_id) throw new Error("vec_distance_cosine self-query disagreement");

// 5. Cross-DB JOIN via attachment — resolve seed to artworks row
vocab.prepare(`ATTACH '${EMB}' AS emb`).run();
const xref = vocab
  .prepare(
    `SELECT a.art_id, a.title FROM artworks a
     JOIN emb.artwork_embeddings e ON e.art_id = a.art_id
     WHERE a.art_id = ?`
  )
  .get(seed.art_id);
console.log(`cross-DB resolve: art_id=${seed.art_id} -> title="${xref?.title ?? "<missing>"}"`);
if (!xref) throw new Error("seed art_id not resolvable in vocabulary.artworks");

console.log("\nAll integrity checks passed.");
