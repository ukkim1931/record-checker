// 뜻 검사(헷갈리는 말): 한국어 언어 모델(KLUE-RoBERTa, 이 컴퓨터 안의 파일)로
// 문장 속 어절을 가리고 원래 말과 짝 말 중 어느 쪽이 더 자연스러운지 비교한다.
// 모델·실행 파일은 모두 lib/ 아래에서만 읽고, 외부 서버에는 요청하지 않는다(allowRemoteModels=false + CSP).
import { env, AutoTokenizer, AutoModelForMaskedLM, Tensor } from './tjs/transformers.min.js';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useBrowserCache = false;
env.localModelPath = new URL('./mlm/', import.meta.url).href;
env.backends.onnx.wasm.wasmPaths = new URL('./tjs/', import.meta.url).href;
env.backends.onnx.wasm.numThreads = 1;
// 모델 파일은 GitHub 파일 크기 제한(100MB) 때문에 두 조각(.part0, .part1)으로 나눠 두었다. 불러올 때 이어 붙인다.
const MODEL_PARTS = ['model_quantized.onnx.part0', 'model_quantized.onnx.part1'];
env.useCustomCache = true;
env.customCache = {
  async match(key){
    const k = String(key && key.url || key);
    if (!k.endsWith('onnx/model_quantized.onnx') || /^https?:\/\/huggingface/.test(k)) return undefined;
    const base = new URL('./mlm/klue-roberta/onnx/', import.meta.url);
    const bufs = await Promise.all(MODEL_PARTS.map(async p => { const r = await fetch(new URL(p, base)); if (!r.ok) throw new Error('모델 조각을 불러오지 못함: ' + p); return r.arrayBuffer(); }));
    return new Response(new Blob(bufs), {headers: {'Content-Type': 'application/octet-stream'}});
  },
  async put(){},
};

let tok, model, CLS, SEP, MASK, PAD;
const ready = (async () => {
  tok = await AutoTokenizer.from_pretrained('klue-roberta');
  model = await AutoModelForMaskedLM.from_pretrained('klue-roberta', {dtype: 'q8'});
  [CLS, SEP] = tok.encode('');
  MASK = tok.model.tokens_to_ids.get('[MASK]'); PAD = tok.model.tokens_to_ids.get('[PAD]');
  if (CLS == null || SEP == null || MASK == null || PAD == null) throw new Error('토크나이저 특수 토큰을 찾지 못함');
})();

const enc = s => s ? tok.encode(s, {add_special_tokens: false}) : [];

// 어절(word 또는 짝 말)을 앞뒤 문맥 사이에 넣고, 그 어절의 토큰을 하나씩 가려 맞힐 확률(로그)의 평균.
// 원래 말과 짝 말을 한 번의 계산(배치)으로 처리한다. 길이가 다르면 [PAD]로 채우고 attention_mask=0.
// 공백으로 나뉜 어절은 따로 토큰화해도 문장 전체를 토큰화한 것과 같다(WordPiece 앞처리가 공백에서 끊음)
async function wordScores(pre, words, post){
  const L = enc(pre), R = enc(post);
  const seqs = words.map(w => { const W = enc(w); return {W, ids: [CLS, ...L, ...W, ...R, SEP]}; });
  const rows = [];
  seqs.forEach((q, si) => q.W.forEach((_, i) => rows.push({si, p: 1 + L.length + i, t: q.W[i]})));
  if (!rows.length) return words.map(() => 0);
  const n = Math.max(...seqs.map(q => q.ids.length)), k = rows.length;
  const data = new BigInt64Array(k * n).fill(BigInt(PAD)), mask = new BigInt64Array(k * n);
  rows.forEach((r, ri) => { const ids = seqs[r.si].ids; for (let c = 0; c < ids.length; c++){ data[ri * n + c] = BigInt(c === r.p ? MASK : ids[c]); mask[ri * n + c] = 1n; } });
  const feeds = {input_ids: new Tensor('int64', data, [k, n]), attention_mask: new Tensor('int64', mask, [k, n])};
  const {logits} = await model(feeds);
  const V = logits.dims[2], lg = logits.data, sum = words.map(() => 0), cnt = words.map(() => 0);
  rows.forEach((r, ri) => {
    const o = (ri * n + r.p) * V;
    let mx = -Infinity; for (let v = 0; v < V; v++) if (lg[o + v] > mx) mx = lg[o + v];
    let se = 0; for (let v = 0; v < V; v++) se += Math.exp(lg[o + v] - mx);
    sum[r.si] += lg[o + r.t] - mx - Math.log(se); cnt[r.si]++;
  });
  return sum.map((x, i) => cnt[i] ? x / cnt[i] : 0);
}

self.onmessage = async ({data}) => {
  try{
    await ready;
    if (data.type === 'init'){ self.postMessage({id: data.id, ok: true}); return; }
    // data.items: [{pre, word, post, alts:[word...]}] → 각 항목의 [원래 점수, 짝 점수들]
    const out = [];
    for (const it of data.items){
      const [base, ...alts] = await wordScores(it.pre, [it.word, ...it.alts], it.post);
      out.push({base, alts});
    }
    self.postMessage({id: data.id, ok: true, out});
  }catch(e){
    self.postMessage({id: data.id, ok: false, error: String(e && e.message || e)});
  }
};
