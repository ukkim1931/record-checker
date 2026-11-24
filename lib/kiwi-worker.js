// Kiwi 형태소 분석기(https://github.com/bab2min/Kiwi)를 브라우저 안(WebAssembly)에서 실행하는 워커.
// 모든 분석은 이 컴퓨터 안에서만 이루어지며 외부로 아무것도 보내지 않습니다.
import { KiwiBuilder } from './kiwi/kiwi-builder.js';

const base = new URL('./kiwi/', import.meta.url).href;
const MODEL = ['combiningRule.txt', 'cong.mdl', 'default.dict', 'dialect.dict', 'extract.mdl', 'nounchr.mdl', 'sj.morph', 'typo.dict'];
const MATCH_ALL = 8388671;
// 띄어 쓰면 오히려 틀리는 명사 접미사(배려심, 창의성, 사고력 등) 앞의 띄어쓰기 제안은 버린다
const SUFFIX = new Set([...'심성력감적형식화물자인가론학법질층관']);
const PARTICLE = new Set([...'이가을를은는의에도과와로만']);
let kiwi = null;

async function init(){
  const builder = await KiwiBuilder.create(base + 'kiwi-wasm.wasm');
  const files = {};
  for (const f of MODEL) files[f] = base + 'model/' + f;
  kiwi = await builder.build({modelFiles: files, loadMultiDict: false});
}

const isWs = c => /\s/.test(c);
function wordBounds(text, p, q){
  let s = p, e = q;
  while (s > 0 && !isWs(text[s - 1])) s--;
  while (e < text.length && !isWs(text[e])) e++;
  return [s, e];
}

// kiwi.space() 결과와 원문을 비교해 어절 단위 수정 제안을 만든다
function spacingIssues(text){
  // 명사+명사(복합어·전문 용어)는 붙여 써도 되므로(한글 맞춤법 제49·50항) 그 사이 띄어쓰기 제안은 하지 않음
  const keep = new Set();
  const tk = kiwi.tokenize(text, MATCH_ALL);
  for (let i = 0; i + 1 < tk.length; i++)
    if (/^NN[GP]$/.test(tk[i].tag) && /^NN[GP]$/.test(tk[i+1].tag) && tk[i].position + tk[i].length === tk[i+1].position) keep.add(tk[i+1].position);
  return diffSpacing(text, kiwi.space(text, false), keep, k => inDictWord(text, k));
}
// 어절 첫머리부터 공백 넣을 자리 k를 넘어서는 부분이 사전에 오른 한 단어(궂은일이, 푸른빛을, 자기소개는)면 true.
// 어절 중간에서 시작하는 단어는 보지 않음 ('빠진부분'의 '진부' 같은 우연한 일치 방지)
function inDictWord(text, k){
  const [s, e] = wordBounds(text, k, k);
  for (let b = Math.min(e, k + 4); b > k; b--){
    const sub = text.slice(s, b);
    if (!/^[가-힣]{2,}$/.test(sub)) continue;
    const tk = kiwi.tokenize(sub, MATCH_ALL);
    if (tk.length === 1 && tk[0].senseId !== 255 && /^NN/.test(tk[0].tag)) return true;
  }
  return false;
}
// 원문과 띄어쓰기 교정문을 비교 (공백 외 글자가 다르면 신뢰하지 않음)
function diffSpacing(text, sp, keep = new Set(), isWord = () => false){
  if (sp === text) return [];
  const n = text.length;
  const ins = new Array(n + 1).fill('');   // ins[i]: 원문 i번째 글자 앞에 새로 넣을 공백
  const del = new Array(n).fill(false);    // del[i]: 원문 i번째 공백을 지움
  let i = 0, j = 0;
  while (i < n || j < sp.length){
    if (i < n && j < sp.length && text[i] === sp[j]){ i++; j++; }
    else if (j < sp.length && isWs(sp[j])){ ins[i] += sp[j]; j++; }
    else if (i < n && isWs(text[i])){ del[i] = true; i++; }
    else return [];
  }
  // 버릴 공백 삽입: 접미사 글자 바로 앞이면서 그 뒤가 조사·끝 (배려심이, 창의성을 → 붙임 / 성적을 → 띄움)
  for (let k = 1; k < n; k++){
    if (!ins[k]) continue;
    if (keep.has(k) || /\d/.test(text[k - 1]) || isWord(k)){ ins[k] = ''; continue; } // 복합 명사, 17세기·3학년, 사전 등재어
    if (!SUFFIX.has(text[k])) continue;
    const after = text[k + 1];
    if (after === undefined || !/[가-힣]/.test(after) || PARTICLE.has(after)) ins[k] = '';
  }
  const regions = [];
  for (let k = 0; k <= n; k++){
    if (!ins[k] && !del[k]) continue;
    const [s, e] = wordBounds(text, Math.max(0, k - 1), Math.min(n, k + 1));
    const last = regions[regions.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else regions.push([s, e]);
  }
  const out = [];
  for (const [s, e] of regions){
    let fix = '';
    for (let k = s; k < e; k++) fix += (k > s ? ins[k] : '') + (del[k] ? '' : text[k]);
    if (e === n) fix += ins[n];
    if (fix !== text.slice(s, e)) out.push({start: s, end: e, fix});
  }
  return out;
}

// ---- 오타 의심: Kiwi 사전에 없는 말 ----
// 사전에 없는 형태소는 senseId 255로 나온다. 고유명사(NNP: 사람 이름 등)는 제외
const isOov = t => t.senseId === 255 && t.tag !== 'NNP' && /^[가-힣]{2,}$/.test(t.str);
const isNoun = w => { const tk = kiwi.tokenize(w, MATCH_ALL); return tk.length === 1 && tk[0].senseId !== 255 && (/^NN/.test(tk[0].tag) || tk[0].tag === 'MAG' && /히$/.test(w)) ? tk[0].score : null; };
const total = s => kiwi.tokenize(s, MATCH_ALL).reduce((a, t) => a + t.score, 0);
// 짧은 활용형(재며·켜져·띄게·보려)은 Kiwi가 문장·단독 분석 모두에서 사전에 없는 말로 잘못 보는 일이 있다.
// 중립적인 틀 문장에 넣어 어느 하나에서라도 사전 형태소만으로 용언+어미로 분석되면 정상으로 본다.
// 3글자 이하만 적용: 긴 오타(분섯하고)가 우연히 분석되어 빠지는 것을 막음
const CARRIERS = [w => w, w => '그것을 ' + w + ' 있다.', w => '그는 ' + w + ' 갔다.', w => '잘 ' + w + ' 함.'];
const wordOk = w => w.length <= 3 && CARRIERS.some(f => {
  const s = f(w), p = s.indexOf(w);
  const tk = kiwi.tokenize(s, MATCH_ALL).filter(t => t.position < p + w.length && p < t.position + t.length);
  return tk.length > 0 && tk.every(t => t.senseId !== 255) && tk.some(t => /^V/.test(t.tag)) && tk.some(t => /^E/.test(t.tag));
});

function typoIssues(text){
  const spans = new Map(); // "start:end" -> [start, end]
  const add = (s, e) => {
    // '정러함'처럼 어미까지 한 덩어리로 나오면 어간(정러)만 남겨 후보를 찾는다
    const m = text.slice(s, e).match(/(?:함|하여|하고|하며|하는|한|했음|했고|됨|되어|되고|된|임|을|를|이|가|은|는|의|에|와|과|로|으로)$/);
    if (m && e - s - m[0].length >= 2) e -= m[0].length;
    spans.set(s + ':' + e, [s, e]);
  };
  for (const t of kiwi.tokenize(text, MATCH_ALL)) if (isOov(t)) add(t.position, t.position + t.length);
  const re = /[가-힣]+/g; let m;
  while ((m = re.exec(text))){
    const tk = kiwi.tokenize(m[0], MATCH_ALL);
    for (const t of tk) if (isOov(t)) add(m.index + t.position, m.index + t.position + t.length);
    // '탐국함' → 탐/NNG 국/NNG 하/XSA 처럼 한 글자 명사 둘로 쪼개진 뒤 접미사가 붙으면 오타 의심
    for (let i = 0; i + 2 < tk.length; i++)
      if (tk[i].tag === 'NNG' && tk[i].length === 1 && tk[i+1].tag === 'NNG' && tk[i+1].length === 1 && tk[i+1].position === tk[i].position + 1 && /^XS/.test(tk[i+2].tag))
        add(m.index + tk[i].position, m.index + tk[i].position + 2);
  }
  // 겹치는 범위는 짧은 쪽을 남김 (설밍 vs 설밍함)
  const list = [...spans.values()].sort((a, b) => (a[1] - a[0]) - (b[1] - b[0]));
  const out = [];
  for (const [s, e] of list){
    if (out.some(o => o.start < e && s < o.end)) continue;
    // 문장 속에서만 사전에 없는 말로 분석된 정상 활용형(쓰며, 켜져, 보려)은 어절만 다시 분석해 거른다
    const [ws, we] = wordBounds(text, s, e);
    if (wordOk(text.slice(ws, we).replace(/[^가-힣]/g, ''))) continue;
    out.push({start: s, end: e, cands: suggestFor(text, s, e)});
  }
  return out;
}
// 자모 하나를 바꿔 사전에 있는 명사가 되는 후보를 찾고, 문장 안에서 가장 자연스러운 순으로 정렬
// 받침의 대표 소리: 소리가 같은 받침끼리 헷갈려 씀 (쫒아→쫓아, 났다→낫다)
const FINAL_SOUND = [0,1,1,1,4,4,4,7,8,1,16,8,8,8,17,8,16,17,17,7,7,21,7,7,1,7,17,7];
function suggestFor(text, s, e){
  const w = text.slice(s, e);
  const seen = new Set(), finals = new Set();
  for (let i = 0; i < w.length; i++){
    const c = w.charCodeAt(i) - 0xAC00; if (c < 0 || c > 11171) continue;
    const L = Math.floor(c / 588), V = Math.floor(c % 588 / 28), T = c % 28;
    const mk = (l, v, t) => w.slice(0, i) + String.fromCharCode(0xAC00 + l * 588 + v * 28 + t) + w.slice(i + 1);
    for (let x = 0; x < 19; x++) if (x !== L) seen.add(mk(x, V, T));
    for (let x = 0; x < 21; x++) if (x !== V) seen.add(mk(L, x, T));
    for (let x = 0; x < 28; x++) if (x !== T){ seen.add(mk(L, V, x)); if (FINAL_SOUND[x] === FINAL_SOUND[T]) finals.add(mk(L, V, x)); }
  }
  // 문맥: 해당 문장(마침표·줄바꿈 기준)
  const a = Math.max(text.lastIndexOf('.', s - 1), text.lastIndexOf('\n', s - 1)) + 1;
  let b = text.slice(e).search(/[.\n]/); b = b < 0 ? text.length : e + b + 1;
  const scored = [];
  for (const c of seen){
    // 짧은 용언 활용형은 소리가 같은 받침으로 바꾼 경우만 후보로 (쫒아→쫓아). 다른 자모까지 열면 엉뚱한 후보가 많음
    const iso = isNoun(c) ?? (finals.has(c) && wordOk(c) ? -12 : null);
    if (iso === null) continue;
    scored.push([c, total(text.slice(a, s) + c + text.slice(e, b)) + iso]);
  }
  return scored.sort((x, y) => y[1] - x[1]).slice(0, 3).map(x => x[0]);
}

// ---- 헷갈리는 말: 사전에 있는 다른 단어로 잘못 쓴 경우 (반듯이/반드시, 틀리다/다르다 등) ----
// 짝이 되는 말로 바꾼 문장이 Kiwi 언어 모델 점수로 확실히 더 자연스러우면 알린다.
// 어절 첫머리에서만 맞춘다. '~'로 시작하면 어미·조사라 앞말에 붙어 있어도 맞춘다.
// [형태들, 설명] — 같은 줄의 형태끼리 같은 위치(순서)로 짝을 이룬다
const CONFUSE = [
  [['반드시','반듯이'], '반드시(꼭) / 반듯이(바르게)'],
  [['다르','틀리'], '다르다(같지 않음) / 틀리다(옳지 않음)'], [['다른','틀린'], null], [['다름','틀림'], null], [['달라','틀려'], null], [['달랐','틀렸'], null],
  [['너머','넘어'], '너머(건너편 공간) / 넘어(넘다)'], [['너머','너무'], '너머(건너편 공간) / 너무(지나치게)'],
  [['맞히','맞추'], '맞히다(정답·과녁) / 맞추다(대조·조정)'], [['맞힘','맞춤'], null], [['맞혀','맞춰'], null], [['맞힌','맞춘'], null], [['맞혔','맞췄'], null],
  [['가리키','가르치'], '가리키다(지시) / 가르치다(교육)'], [['가리켜','가르쳐'], null], [['가리킴','가르침'], null], [['가리킨','가르친'], null],
  [['부치','붙이'], '부치다(보내다) / 붙이다(붙게 하다)'], [['부쳐','붙여'], null], [['부침','붙임'], null],
  [['~로서','~로써'], '로서(자격) / 로써(수단)'],
  [['한창','한참'], '한창(가장 활발한 때) / 한참(오랫동안)'],
  [['띤','띈'], '띠다(빛깔·성질) / 띄다(눈에 보이다)'], [['띠고','띄고'], null], [['띠게','띄게'], null], [['띠며','띄며'], null], [['띠어','띄어'], null], [['띠는','띄는'], null], [['띠지','띄지'], null],
  [['들러','들려'], '들르다(잠깐 머무르다) / 들리다(소리)'], [['들르','들리'], null], [['들렀','들렸'], null],
  [['나아','낳아'], '낫다(병이 낫다·더 좋다) / 낳다(출산·결과를 낳다)'], [['나은','낳은'], null], [['낫도록','낳도록'], null], [['나았','낳았'], null],
  [['어떻게','어떡해'], '어떻게(방법) / 어떡해(어떻게 해)'],
  [['체하','채하'], '체하다(그런 척) / 채(그대로 있는 상태)'], [['채로','체로'], null],
  [['비추','비치'], '비추다(빛을 보내다) / 비치다(빛이 나다·드러나다)'], [['비춰','비쳐'], null], [['비추어','비치어'], null],
  [['결제','결재'], '결제(대금 지급) / 결재(승인)'],
  [['~든지','~던지'], '-든지(선택) / -던지(과거 회상)'], [['~든가','~던가'], null], [['~이든','~이던'], null],
  [['보완','보안'], '보완(부족한 점을 채움) / 보안(안전 유지)'],
  [['자제','자재'], '자제(스스로 억누름) / 자재(재료)'],
  [['매달리','메달리'], '매달리다 / 메달(상패)'],
  [['이따가','있다가'], '이따가(조금 뒤에) / 있다가(머물다가)'],
  [['늘리','늘이'], '늘리다(수·양·크기) / 늘이다(길이)'], [['늘려','늘여'], null], [['늘렸','늘였'], null], [['늘린','늘인'], null], [['늘림','늘임'], null],
  [['매고','메고'], '매다(묶다) / 메다(어깨에 지다)'], [['매어','메어'], null], [['매는','메는'], null], [['맨','멘'], null], [['맸','멨'], null],
  [['드러내','들어내'], '드러내다(보이게 하다) / 들어내다(들어서 옮기다)'], [['드러내어','들어내어'], null], [['드러낸','들어낸'], null],
  [['저리','절이'], '저리다(감각) / 절이다(소금에 담금)'], [['저려','절여'], null],
  [['벌이','벌리'], '벌이다(일을 시작·펼침) / 벌리다(사이를 넓힘)'], [['벌여','벌려'], null],
  [['썩히','썩이'], '썩히다(물건을 썩게 함·재능을 묵힘) / 썩이다(마음을 괴롭힘)'],
  [['갈음','가름'], '갈음(대신함) / 가름(나눔·승부를 가름)'],
  [['조리','졸이'], '조리다(양념이 배게 끓임) / 졸이다(국물을 줄임·마음을 졸임)'],
  [['두껍','두텁'], '두껍다(두께) / 두텁다(신뢰·정)'], [['두꺼워','두터워'], null], [['두꺼운','두터운'], null],
  [['맡아','맞아'], '맡다(책임지다) / 맞다(옳다·맞이하다)', 5], [['맡은','맞은'], null], [['맡고','맞고'], null], [['맡았','맞았'], null],
  [['짓고','짖고'], '짓다(만들다) / 짖다(개가 소리 내다)'], [['지어','짖어'], null], [['지은','짖은'], null],
  [['잊지','잃지'], '잊다(기억 못 함) / 잃다(가진 것이 없어짐)'], [['잊어','잃어'], null], [['잊은','잃은'], null], [['잊었','잃었'], null],
  [['비춤','비침'], '비추다(빛을 보내다) / 비치다(빛이 나다·드러나다)'], [['비춘','비친'], null],
  [['바치','받치'], '바치다(드림·헌신) / 받치다(밑을 괴다)'], [['바쳐','받쳐'], null],
  [['좇','쫓'], '좇다(목표·뜻을 따름) / 쫓다(뒤를 따라감)'],
  // 맞는 쓰임이 흔해 오탐 위험이 큰 짝은 기준 점수를 높임 (세 번째 값)
  [['이루','이르'], '이루다(목표를 이룸) / 이르다(도달·말하다)', 5],
  [['운용','운영'], '운용(돈·제도를 부려 씀) / 운영(조직·사업을 이끎)', 5],
  [['계발','개발'], '계발(재능·능력을 일깨움) / 개발(기술·제품·자원)', 5],
  [['지향','지양'], '지향(목표로 함) / 지양(하지 않음)'],
  [['제고','재고'], '제고(높임) / 재고(다시 생각함)'],
  [['혼동','혼돈'], '혼동(뒤섞어 착각) / 혼돈(뒤죽박죽)'],
  [['일절','일체'], '일절(전혀) / 일체(모든 것)'],
  [['부문','부분'], '부문(분야) / 부분(전체의 일부)'],
  [['방증','반증'], '방증(간접 증거) / 반증(반대 증거)'],
  // 아래는 뜻으로 고르는 짝: Kiwi 점수로는 구별되지 않아 뜻 검사(mlm-worker)만 판정 (기준 99 = Kiwi로는 알리지 않음)
  [['보전','보존'], '보전(온전하게 지킴) / 보존(그대로 남김)', 99],
  [['전승','전수'], '전승(대대로 이어 감) / 전수(기술·지식을 전해 줌)', 99],
  [['출연','출현'], '출연(무대·방송에 나옴) / 출현(나타남)', 99],
  [['결여','결례'], '결여(빠져 없음) / 결례(예의에 어긋남)', 99],
  [['효과','효력'], '효과(보람·결과) / 효력(법·약 등이 미치는 힘)', 99],
  [['상정','산정'], '상정(안건을 올림·가정함) / 산정(셈하여 정함)', 99],
  [['개정','개량'], '개정(문서·제도를 고침) / 개량(물건·방법을 더 좋게 고침)', 99],
  [['재원','제원'], '재원(자금·인재) / 제원(기계의 성능·치수)', 99],
  [['기재','게재'], '기재(문서에 적음) / 게재(신문·잡지에 실음)', 99],
  [['접수','수령'], '접수(받아들임) / 수령(받아 가짐)', 99],
  [['보상','배상'], '보상(손실을 갚음) / 배상(남에게 끼친 손해를 물어 줌)', 99],
  [['임대','임차'], '임대(돈을 받고 빌려줌) / 임차(돈을 내고 빌림)', 99],
  [['억류','억제'], '억류(강제로 붙잡아 둠) / 억제(억눌러 그치게 함)', 99],
  [['혼합','혼동'], '혼합(뒤섞음) / 혼동(구별하지 못함)', 99],
  [['일관','일괄'], '일관(처음부터 끝까지 한결같음) / 일괄(한데 묶음)', 99],
  [['체제','체재'], '체제(조직·제도의 틀) / 체재(머무름·글의 형식)', 99],
  [['수상','시상'], '수상(상을 받음) / 시상(상을 줌)', 99],
  [['재현','재연'], '재현(다시 나타냄) / 재연(연극·사건을 다시 함)', 99],
  [['제정','재정'], '제정(법·제도를 만들어 정함) / 재정(돈의 살림)', 99],
  [['검증','검정'], '검증(사실을 확인함) / 검정(자격·품질을 심사함)', 99],
  [['유래','유례'], '유래(생겨난 내력) / 유례(같거나 비슷한 예)', 99],
  [['돋우','돋구'], '돋우다(높이다·북돋다) / 돋구다(안경 도수를 높임)', 99],
  [['헤치','해치'], '헤치다(물리치며 나아감) / 해치다(손상함)', 99],
  [['걷잡','겉잡'], '걷잡다(쏠려 가는 것을 붙잡음) / 겉잡다(대강 어림잡음)', 99],
  [['삭이','삭히'], '삭이다(분을 가라앉힘) / 삭히다(발효시킴)', 99],
  [['젖히','제치'], '젖히다(뒤로 기울임) / 제치다(앞지름·빼놓음)', 99],
  [['부딪치','부딪히'], '부딪치다(세게 마주 닿음, 능동) / 부딪히다(부딪침을 당함)', 99],
  [['받치','받히'], '받치다(밑을 괴다) / 받히다(들이받음을 당함)', 99],
  [['묻히','무치'], '묻히다(묻게 함) / 무치다(나물을 양념에 버무림)', 99],
  [['규명','구명'], '규명(사실을 밝힘) / 구명(목숨을 구함·깊이 연구함)', 99],
  [['추세','추태'], '추세(흐름) / 추태(더럽고 지저분한 태도)', 99],
  [['심사','심문'], '심사(자세히 살펴 가림) / 심문(따져 물음)', 99],
  [['검증','검진'], '검증(사실을 확인함) / 검진(건강 상태를 살핌)', 99],
  [['제정','개정'], '제정(처음 만들어 정함) / 개정(고쳐 바로잡음)', 99],
  [['제시','제정'], '제시(드러내어 보임) / 제정(제도를 만들어 정함)', 99],
  [['부수','부시'], '부수다(깨뜨림) / 부시다(눈이 부심·그릇을 씻음)', 99],
  [['가늠','가름'], '가늠(헤아려 봄) / 가름(나눔·승부를 정함)', 99],
  [['전가','전이'], '전가(책임을 남에게 넘김) / 전이(자리·상태를 옮김)', 99],
  [['복원','복제'], '복원(원래대로 되돌림) / 복제(그대로 만듦)', 99],
  [['잊어버리','잃어버리'], '잊어버리다(기억 못 함) / 잃어버리다(가진 것이 없어짐)', 99],
];
const CONF_MARGIN = 3; // 시험(40쌍): 틀린 문장 55% 검출, 맞는 문장 오탐 2.5%
const CONF_RULES = [];
for (const [forms, why, margin] of CONFUSE){
  const prev = CONF_RULES[CONF_RULES.length - 1];
  const info = why || prev.why, mg = margin || (why ? CONF_MARGIN : prev.margin); // 설명이 없는 줄은 바로 위 짝의 설명·기준을 이어받음
  const words = forms.map(f => f.replace('~', ''));
  for (let i = 0; i < forms.length; i++)
    for (let j = 0; j < forms.length; j++) if (i !== j)
      CONF_RULES.push({re: new RegExp((forms[i][0] === '~' ? '' : '(?<![가-힣])') + words[i], 'g'), to: words[j], why: info, margin: mg});
}
const sentScore = s => kiwi.analyze(s, MATCH_ALL).score;
function confusableIssues(text){
  const hits = [];
  for (const r of CONF_RULES){
    r.re.lastIndex = 0; let m;
    while ((m = r.re.exec(text))) hits.push({start: m.index, end: m.index + m[0].length, to: r.to, why: r.why, margin: r.margin});
  }
  // 명사 앞의 '-든'은 회상의 '-던'일 가능성 (만들든 음식 → 만들던). 모든·어떻든 등과 '-든 간에'는 제외
  const reDun = /([가-힣]+)든(?=\s[가-힣])/g; let md;
  while ((md = reDun.exec(text))){
    if (/^(?:모|어떻|어쨌|하여튼|여하튼|좌우지간)$/.test(md[1]) || /^\s(?:간에|상관|말든|아니든|안\s|못\s)/.test(text.slice(md.index + md[0].length))) continue;
    const s = md.index + md[1].length;
    hits.push({start: s, end: s + 1, to: '던', why: '-든(선택) / -던(과거 회상)', margin: 4});
  }
  // '-하다' 꼴 모음 오타: 격려험, 공지허고, 수행헌 → 함, 하고, 한 (경험·실험 등 '-험' 명사는 제외)
  const HA = {'허고':'하고','허며':'하며','허여':'하여','헌':'한','험':'함','헤서':'해서','헸':'했'};
  const reHa = /([가-힣]{2,})(허고|허며|허여|헌|험|헤서|헸)(?=[\s.,]|$)/g; let mh;
  while ((mh = reHa.exec(text))){
    if (mh[2] === '험' && /(?:경|위|시|체|실|모|탐|보|응|수|영|효|월|무|변)$/.test(mh[1])) continue;
    const s = mh.index + mh[1].length;
    hits.push({start: s, end: s + mh[2].length, to: HA[mh[2]], why: '‘-하다’의 활용형 오타로 보입니다.', margin: CONF_MARGIN});
  }
  // 같은 자리는 긴 형태 우선 (다른 vs 다르). 같은 형태에 짝이 여럿이면(너머→넘어/너무) 가장 자연스러운 것을 고름
  hits.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const out = [], cands = [], cache = new Map();
  for (let k = 0; k < hits.length; ){
    const first = hits[k], group = [];
    while (k < hits.length && hits[k].start === first.start && hits[k].end === first.end) group.push(hits[k++]);
    while (k < hits.length && hits[k].start < first.end) k++; // 겹치는 짧은 형태는 버림
    // '반듯이 하고/앉아/정리'처럼 자세·모양을 나타내면 '반듯이'가 맞음 (언어 모델이 흔한 '반드시'로 기우는 것을 막음)
    const after = text.slice(first.end);
    const a = Math.max(text.lastIndexOf('.', first.start - 1), text.lastIndexOf('\n', first.start - 1)) + 1;
    let b = after.search(/[.\n]/); b = b < 0 ? text.length : first.end + b + 1;
    const orig = text.slice(a, b);
    if (!cache.has(orig)) cache.set(orig, sentScore(orig));
    let best = null;
    const before = text.slice(Math.max(0, first.start - 8), first.start);
    for (const h of group){
      if (h.to === '반드시' && /^\s?(?:하|앉|서|세|눕|누|놓|펴|걷|접|개|자르|쓰|정리|정돈)/.test(after)) continue;
      // '답을 맞추어 보다'(서로 대조)는 맞춤
      if (/^맞[히힘혀힌혔]/.test(h.to) && /^(?:어|워)?\s?[보봄봐봤볼본]/.test(after)) continue;
      // 정답과 맞지 않음 = 틀리다 (틀린 문제, 계산이 틀림)
      if (/^(?:다른|다르|다름|달라|달랐)$/.test(h.to) && (/(?:문제|답|계산|철자|맞춤법|정답|발음|글자|부분)(?:를|을|가|이)?\s?$/.test(before)
        || /^\s?(?:문제|답|부분|곳|글자|철자|계산|발음|표현)/.test(after))) continue;
      // 목표·뜻·현상을 따르면 '좇다'가 맞음 (꿈을 좇아, 현상을 좇아 탐구함)
      if (h.to === '쫓' && /(?:꿈|목표|이상|뜻|진리|명예|유행|이익|가치|현상|원리|흐름|논리|원칙|이념|선례|관습)(?:을|를)\s?$/.test(before)) continue;
      // 역할·순서를 책임지면 '맡다' (입론을 맡아, 사회를 맡고)
      if (/^맞/.test(h.to) && /(?:역할|입론|반론|변론|발언|진행|사회|임무|책임|담당|부분|파트|대표|회장|반장|모둠장|조장|리더|발표|순서|업무|일|자리|역)(?:을|를)\s?$/.test(before)) continue;
      // 수단의 로써 (증거로써, 대화로써)
      if (h.to === '로서' && /(?:증거|근거|수단|방법|도구|노력|대화|기준|자료|실험|토론|글|말)$/.test(text.slice(Math.max(0, first.start - 4), first.start))) continue;
      const gain = sentScore(text.slice(a, h.start) + h.to + text.slice(h.end, b)) - cache.get(orig);
      cands.push({start: first.start, end: first.end, to: h.to, why: h.why, kgain: gain, margin: h.margin, a, b}); // 뜻 검사(mlm-worker)용 후보
      if (gain > h.margin && (!best || gain > best.gain)) best = {gain, h};
    }
    if (best) out.push({start: first.start, end: first.end, fix: best.h.to, why: best.h.why});
  }
  confCands = cands;
  return out;
}
let confCands = [];

// ---- 실제 단어가 된 오타 (밟혀→밝혀, 새우고→세우고, 말아→맡아) ----
// 내용어(명사·동사·형용사 어간) 글자의 자모를 사람이 흔히 틀리는 방식으로 하나 바꿔 사전에 있는 말이 되면,
// 그 말을 넣은 문장이 언어 모델 점수로 '훨씬' 자연스러울 때만 알린다.
// 시험: 정상 문장 최고 +4.8(삶는→사는), 잡힌 오타 +7.3~+10.9 → 기준 7 (짧은 창과 문장 전체 모두에서 넘어야 함)
const RW_MARGIN = 7;
const VOWEL_SWAP = {0:[2],2:[0],1:[5],5:[1],4:[6],6:[4],8:[12],12:[8],13:[17],17:[13],18:[13],20:[19],19:[20],11:[10,15],10:[11,15],15:[10,11]}; // ㅏㅑ ㅐㅔ ㅓㅕ ㅗㅛ ㅜㅠ ㅡㅜ ㅢㅣ ㅚㅙㅞ
const INIT_SWAP = {0:[15,1],15:[0,1],1:[0,15],3:[16,4],16:[3,4],4:[3,16],7:[17,8],17:[7,8],8:[7,17],12:[14,13],14:[12,13],13:[12,14],9:[10],10:[9]}; // ㄱㅋㄲ ㄷㅌㄸ ㅂㅍㅃ ㅈㅊㅉ ㅅㅆ
const rwClean = new Map(), rwCache = new Map();
const isClean = w => { if (!rwClean.has(w)){ const tk = kiwi.tokenize(w, MATCH_ALL); rwClean.set(w, tk.length > 0 && tk.every(t => t.senseId !== 255 && t.tag !== 'NNP')); } return rwClean.get(w); };
function rwEdits(w, from, to){ // w의 [from, to) 글자만 바꿈
  const out = new Set();
  for (let i = from; i < to; i++){
    const c = w.charCodeAt(i) - 0xAC00; if (c < 0 || c > 11171) continue;
    const L = Math.floor(c / 588), V = Math.floor(c % 588 / 28), T = c % 28;
    const mk = (l, v, t) => w.slice(0, i) + String.fromCharCode(0xAC00 + l * 588 + v * 28 + t) + w.slice(i + 1);
    for (const v of VOWEL_SWAP[V] || []) out.add(mk(L, v, T));
    for (const l of INIT_SWAP[L] || []) out.add(mk(l, V, T));
    for (const t of FINAL_SWAP) if (t !== T) out.add(mk(L, V, t));
  }
  return out;
}
// 너무 흔해서 언어 모델이 늘 선호하는 말은 후보로 쓰지 않음 (읽고→있고, 글의→그의, 모둠→모두)
const RW_STOP = /^(?:있|없|그의|그는|그가|그를|이의|모두|인의|하는|되는|것)/;
const FINAL_SWAP = [0, 1, 4, 7, 8, 9, 10, 11, 16, 17, 19, 20, 21, 2, 27, 25]; // 없음 ㄱ ㄴ ㄷ ㄹ ㄺ ㄻ ㄼ ㅁ ㅂ ㅅ ㅆ ㅇ ㄲ ㅎ ㅌ
function realWordSentence(sent){
  if (rwCache.has(sent)) return rwCache.get(sent);
  const toks = kiwi.tokenize(sent, MATCH_ALL), out = [];
  const words = [...sent.matchAll(/\S+/g)].map(x => [x.index, x.index + x[0].length]);
  let fullBase;
  const re = /[가-힣]{2,}/g; let m;
  while ((m = re.exec(sent))){
    const w = m[0], ws = m.index, we = ws + w.length;
    // 용언(동사·형용사)만: 명사는 드문 전문어(시접, 색각, 봉수제)를 흔한 말로 바꾸려는 오탐이 많았음
    const content = toks.filter(t => t.position >= ws && t.position < we && /^(VV|VA)/.test(t.tag) && t.senseId !== 255);
    if (!content.length || toks.some(t => t.position >= ws && t.position < we && t.tag === 'NNP')) continue;
    const from = Math.min(...content.map(t => t.position)) - ws, to = Math.min(w.length, Math.max(...content.map(t => t.position + t.length)) - ws);
    if (to - from > 3) continue;
    // 문맥은 앞뒤 두 어절까지만 (속도)
    const wi = words.findIndex(([a, b]) => a <= ws && ws < b);
    const a = words[Math.max(0, wi - 2)][0], b = words[Math.min(words.length - 1, wi + 2)][1];
    const base = sentScore(sent.slice(a, b));
    let best = null;
    for (const c of rwEdits(w, from, Math.max(from + 1, to))){
      if (!isClean(c) || RW_STOP.test(c)) continue;
      const g = sentScore(sent.slice(a, ws) + c + sent.slice(we, b)) - base;
      if (g > RW_MARGIN && (!best || g > best.g)) best = {g, c};
    }
    // 짧은 창에서는 흔한 말 쪽으로 기울기 쉬우므로, 문장 전체로도 기준을 넘을 때만 알림
    if (best && sentScore(sent.slice(0, ws) + best.c + sent.slice(we)) - (fullBase ??= sentScore(sent)) > RW_MARGIN)
      out.push({start: ws, end: we, fix: best.c});
  }
  if (rwCache.size > 2000) rwCache.clear();
  rwCache.set(sent, out);
  return out;
}
function realWordIssues(text){
  const out = [], re = /[^.\n?!]+[.?!]?/g; let m;
  while ((m = re.exec(text))){
    if (!/[가-힣]/.test(m[0])) continue;
    for (const r of realWordSentence(m[0])) out.push({start: m.index + r.start, end: m.index + r.end, fix: r.fix});
  }
  return out;
}

// 고유명사(사람 이름·지명 등) 위치: 개인정보 가림에 사용
function properNouns(text){
  return kiwi.tokenize(text, MATCH_ALL).filter(t => t.tag === 'NNP').map(t => ({start: t.position, end: t.position + t.length}));
}

const ready = init();
self.onmessage = async ({data}) => {
  try{
    await ready;
    if (data.type === 'init'){ self.postMessage({id: data.id, ok: true}); return; }
    const text = data.text;
    let spacing = [], nnp = [], typos = [], confuse = [], realword = [];
    confCands = [];
    try{ spacing = spacingIssues(text); }catch(e){}
    try{ nnp = properNouns(text); }catch(e){}
    try{ typos = typoIssues(text); }catch(e){}
    try{ confuse = confusableIssues(text); }catch(e){}
    try{ realword = realWordIssues(text); }catch(e){}
    self.postMessage({id: data.id, ok: true, spacing, nnp, typos, confuse, realword, confCands});
  }catch(e){
    self.postMessage({id: data.id, ok: false, error: String(e && e.message || e)});
  }
};
