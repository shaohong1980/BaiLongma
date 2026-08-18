// iching-data.js —— 易经易学看板的数据源
//   · 八卦（先天八卦顺序，与 voice-bagua 卦环一致）：名称 / 卦符 / 自然 / 五行 / 家庭 / 德性 / 方位
//   · 六十四卦（文王序）：序号 / 卦名 / Unicode 卦符(U+4DC0 起按文王序一一对应) / 上卦 / 下卦 / 卦辞
//
// 六爻（6 条爻线）由上下卦三爻拼出：下卦在下（初爻~三爻），上卦在上（四爻~上爻）。
// 爻线编码自下而上，1=阳爻(──) 0=阴爻(- -)。

export const TRIGRAMS = [
  { name: '乾', sym: '☰', nature: '天', element: '金', family: '父', virtue: '健', dirLater: '西北', dirEarlier: '南', lines: '111' },
  { name: '兑', sym: '☱', nature: '泽', element: '金', family: '少女', virtue: '悦', dirLater: '西', dirEarlier: '东南', lines: '110' },
  { name: '离', sym: '☲', nature: '火', element: '火', family: '中女', virtue: '丽', dirLater: '南', dirEarlier: '东', lines: '101' },
  { name: '震', sym: '☳', nature: '雷', element: '木', family: '长男', virtue: '动', dirLater: '东', dirEarlier: '东北', lines: '100' },
  { name: '坤', sym: '☷', nature: '地', element: '土', family: '母', virtue: '顺', dirLater: '西南', dirEarlier: '北', lines: '000' },
  { name: '艮', sym: '☶', nature: '山', element: '土', family: '少男', virtue: '止', dirLater: '东北', dirEarlier: '西北', lines: '001' },
  { name: '坎', sym: '☵', nature: '水', element: '水', family: '中男', virtue: '险', dirLater: '北', dirEarlier: '西', lines: '010' },
  { name: '巽', sym: '☴', nature: '风', element: '木', family: '长女', virtue: '入', dirLater: '东南', dirEarlier: '西南', lines: '011' },
];

const TRIGRAM_BY_NAME = new Map(TRIGRAMS.map(t => [t.name, t]));

// 六十四卦（文王序）· 卦辞为《周易》通行本原文（简化标点）
// sym 直接由 U+4DC0 + 序号 推得，故此处只存 name / upper / lower / judgment。
const RAW_HEXAGRAMS = [
  ['乾', '乾', '乾', '元亨，利贞。'],
  ['坤', '坤', '坤', '元亨，利牝马之贞。君子有攸往，先迷后得主，利。'],
  ['屯', '坎', '震', '元亨利贞，勿用有攸往，利建侯。'],
  ['蒙', '艮', '坎', '亨。匪我求童蒙，童蒙求我。初筮告，再三渎，渎则不告。利贞。'],
  ['需', '坎', '乾', '有孚，光亨，贞吉，利涉大川。'],
  ['讼', '乾', '坎', '有孚窒惕，中吉，终凶。利见大人，不利涉大川。'],
  ['师', '坤', '坎', '贞，丈人吉，无咎。'],
  ['比', '坎', '坤', '吉。原筮，元永贞，无咎。不宁方来，后夫凶。'],
  ['小畜', '巽', '乾', '亨。密云不雨，自我西郊。'],
  ['履', '乾', '兑', '履虎尾，不咥人，亨。'],
  ['泰', '坤', '乾', '小往大来，吉，亨。'],
  ['否', '乾', '坤', '否之匪人，不利君子贞，大往小来。'],
  ['同人', '乾', '离', '同人于野，亨。利涉大川，利君子贞。'],
  ['大有', '离', '乾', '元亨。'],
  ['谦', '坤', '艮', '亨，君子有终。'],
  ['豫', '震', '坤', '利建侯行师。'],
  ['随', '兑', '震', '元亨利贞，无咎。'],
  ['蛊', '艮', '巽', '元亨，利涉大川。先甲三日，后甲三日。'],
  ['临', '坤', '兑', '元亨利贞。至于八月有凶。'],
  ['观', '巽', '坤', '盥而不荐，有孚颙若。'],
  ['噬嗑', '离', '震', '亨，利用狱。'],
  ['贲', '艮', '离', '亨，小利有攸往。'],
  ['剥', '艮', '坤', '不利有攸往。'],
  ['复', '坤', '震', '亨。出入无疾，朋来无咎。反复其道，七日来复，利有攸往。'],
  ['无妄', '乾', '震', '元亨利贞。其匪正有眚，不利有攸往。'],
  ['大畜', '艮', '乾', '利贞。不家食吉，利涉大川。'],
  ['颐', '艮', '震', '贞吉。观颐，自求口实。'],
  ['大过', '兑', '巽', '栋桡。利有攸往，亨。'],
  ['坎', '坎', '坎', '习坎，有孚，维心亨，行有尚。'],
  ['离', '离', '离', '利贞，亨。畜牝牛吉。'],
  ['咸', '兑', '艮', '亨，利贞。取女吉。'],
  ['恒', '震', '巽', '亨，无咎，利贞。利有攸往。'],
  ['遁', '乾', '艮', '亨，小利贞。'],
  ['大壮', '震', '乾', '利贞。'],
  ['晋', '离', '坤', '康侯用锡马蕃庶，昼日三接。'],
  ['明夷', '坤', '离', '利艰贞。'],
  ['家人', '巽', '离', '利女贞。'],
  ['睽', '离', '兑', '小事吉。'],
  ['蹇', '坎', '艮', '利西南，不利东北。利见大人，贞吉。'],
  ['解', '震', '坎', '利西南。无所往，其来复吉。有攸往，夙吉。'],
  ['损', '艮', '兑', '有孚，元吉，无咎，可贞，利有攸往。曷之用？二簋可用享。'],
  ['益', '巽', '震', '利有攸往，利涉大川。'],
  ['夬', '兑', '乾', '扬于王庭，孚号有厉。告自邑，不利即戎，利有攸往。'],
  ['姤', '乾', '巽', '女壮，勿用取女。'],
  ['萃', '兑', '坤', '亨，王假有庙。利见大人，亨，利贞。用大牲吉，利有攸往。'],
  ['升', '坤', '巽', '元亨，用见大人，勿恤，南征吉。'],
  ['困', '兑', '坎', '亨，贞，大人吉，无咎。有言不信。'],
  ['井', '坎', '巽', '改邑不改井，无丧无得，往来井井。汔至，亦未繘井，羸其瓶，凶。'],
  ['革', '兑', '离', '巳日乃孚，元亨利贞，悔亡。'],
  ['鼎', '离', '巽', '元吉，亨。'],
  ['震', '震', '震', '亨。震来虩虩，笑言哑哑，震惊百里，不丧匕鬯。'],
  ['艮', '艮', '艮', '艮其背，不获其身；行其庭，不见其人。无咎。'],
  ['渐', '巽', '艮', '女归吉，利贞。'],
  ['归妹', '震', '兑', '征凶，无攸利。'],
  ['丰', '震', '离', '亨，王假之。勿忧，宜日中。'],
  ['旅', '离', '艮', '小亨，旅贞吉。'],
  ['巽', '巽', '巽', '小亨。利有攸往，利见大人。'],
  ['兑', '兑', '兑', '亨，利贞。'],
  ['涣', '巽', '坎', '亨。王假有庙，利涉大川，利贞。'],
  ['节', '坎', '兑', '亨。苦节，不可贞。'],
  ['中孚', '巽', '兑', '豚鱼吉。利涉大川，利贞。'],
  ['小过', '震', '艮', '亨，利贞。可小事，不可大事。飞鸟遗之音，不宜上，宜下，大吉。'],
  ['既济', '坎', '离', '亨小，利贞。初吉终乱。'],
  ['未济', '离', '坎', '亨。小狐汔济，濡其尾，无攸利。'],
];

export const HEXAGRAMS = RAW_HEXAGRAMS.map(([name, upper, lower, judgment], i) => {
  const upperT = TRIGRAM_BY_NAME.get(upper);
  const lowerT = TRIGRAM_BY_NAME.get(lower);
  return {
    n: i + 1,
    name,
    sym: String.fromCodePoint(0x4DC0 + i), // ䷀..䷿ 文王序一一对应
    upper: upperT.name,
    upperSym: upperT.sym,
    lower: lowerT.name,
    lowerSym: lowerT.sym,
    element: upperT.element,           // 五行以卦气论，用上卦表显（展示用）
    judgment,
    lines: lowerT.lines + upperT.lines, // 自下而上 6 爻：下卦三爻 + 上卦三爻
  };
});

export function getHexagram(n) {
  const i = (Number(n) || 1) - 1;
  return HEXAGRAMS[i] || HEXAGRAMS[0];
}

// 起卦：掷三枚铜钱一次得一个爻。3 背为老阳(动爻 9)，3 字为老阴(动爻 6)，
// 一背二字为少阳(7)，一字二背为少阴(8)。自下而上成卦。
export function castHexagram() {
  const lines = [];
  const moving = [];
  for (let pos = 0; pos < 6; pos++) {
    const backs = (Math.random() < 0.5 ? 1 : 0) + (Math.random() < 0.5 ? 1 : 0) + (Math.random() < 0.5 ? 1 : 0);
    let value; // 6=老阴 7=少阳 8=少阴 9=老阳
    if (backs === 3) value = 9;       // 三背 → 老阳（动）
    else if (backs === 0) value = 6;  // 三字 → 老阴（动）
    else if (backs === 2) value = 7;  // 一背二字 → 少阳
    else value = 8;                   // 一字二背 → 少阴
    lines.push(value);
    if (value === 6 || value === 9) moving.push({ pos, value });
  }
  // 本卦爻象（动爻取其相反 → 变卦）
  const change = (v) => (v === 6 || v === 9 ? (v === 6 ? 7 : 8) : v);
  const binary = lines.map(v => (v % 2 === 1 ? '1' : '0')).join('');
  const binaryChanged = lines.map(v => (change(v) % 2 === 1 ? '1' : '0')).join('');
  return {
    values: lines,
    moving,
    binary,
    binaryChanged,
    hexagram: findHexagramByBinary(binary),
    changed: findHexagramByBinary(binaryChanged),
    ts: Date.now(),
  };
}

export function findHexagramByBinary(binary) {
  const key = String(binary || '');
  return HEXAGRAMS.find(h => h.lines === key) || HEXAGRAMS[0];
}
