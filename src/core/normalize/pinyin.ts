/**
 * 汉字 → 拼音首字母映射与取词（Task 19）。
 *
 * 拼音首字母只进**确定性基线**的排序键，不进唯一性判定。多音字取候选集合
 * （不静默只取一个），无法取拼音的字保留原字符。首字母表覆盖本项目药品 /
 * 收费 / 科室 / 检验语料用字与常见药名用字；表外字按 spec 约定保留原字符。
 */

/** 首字母分组表：每个字母对应一组以该字母开头的汉字。 */
const LETTER_GROUPS: Record<string, string> = {
  a: '阿奥安氨艾胺',
  b: '半博孢吡布必拜比苄波班葆铋贝',
  c: '常床查茶醇',
  d: '丁代啶地多大对德达迪定丹胆淡氮岛',
  e: '厄恩尔二',
  f: '伐复弗扶氟法酚菲芬锋方防风分浮呋服',
  g: '功挂果格杆管肝胍胱苷规钙高广枸',
  h: '化华呼护环红缓黄号',
  j: '净基检甲碱经菌钾剂胶精',
  k: '克卡康考科颗可',
  l: '兰列利力来林拉疗理罗氯铝雷鲁龙莱螺洛粒立乐',
  m: '孟密门米美莫霉麻镁蒙咪',
  n: '内尼尿奈能脲诺鸟钠脑耐囊',
  p: '平扑潘泼泮皮苹片',
  q: '奇歧曲巯青氢前庆齐',
  r: '热瑞乳仁茸软',
  s: '事司斯四松素索术石神酸舒沙双塞氏释散栓思手肾输',
  t: '他唐糖坦特替痛碳汀酮托脱铁天头',
  w: '务危文无维肟韦丸胃温位',
  x: '信先吸消硝溴心辛星西昔酰腺血缬锌学欣息',
  y: '与严乙伊依医药液氧橼验益叶右',
  z: '再唑左止治症重诊状醉酯注镇佐',
}

/** 单字 → 主首字母。由分组表展开。 */
const INITIAL_MAP = new Map<string, string>()
for (const [letter, chars] of Object.entries(LETTER_GROUPS)) {
  for (const ch of chars) {
    if (!INITIAL_MAP.has(ch)) INITIAL_MAP.set(ch, letter)
  }
}

/** 多音字候选集合：取词时保留全部候选，不静默定一个。 */
const POLYPHONIC: Record<string, string[]> = {
  乐: ['l', 'y'],
  枸: ['g', 'j'],
  囊: ['n'],
  查: ['c', 'z'],
  石: ['s', 'd'],
  重: ['z', 'c'],
  阿: ['a', 'e'],
  长: ['c', 'z'],
  行: ['x', 'h'],
  参: ['c', 's'],
  单: ['d', 's'],
  降: ['j', 'x'],
  省: ['s', 'x'],
  校: ['x', 'j'],
  炮: ['p', 'b'],
  奇: ['q', 'j'],
  菌: ['j'],
  血: ['x'],
  塞: ['s'],
  地: ['d'],
  着: ['z'],
}

/** 单字候选首字母集合；表外字返回 [原字符]（保留，不丢弃）。 */
export function initialCandidates(ch: string): string[] {
  if (POLYPHONIC[ch]) return [...POLYPHONIC[ch]]
  const mapped = INITIAL_MAP.get(ch)
  if (mapped) return [mapped]
  return [ch]
}

/**
 * 取拼音首字母主串：多音字取第一候选，表外字保留原字符。
 * 只用于确定性基线的排序键。
 */
export function pinyinInitials(input: string): string {
  let out = ''
  for (const ch of input) {
    if (!/\p{Script=Han}/u.test(ch)) {
      // 非汉字（字母/数字/符号）保留，但只取小写字母参与首字母键。
      out += /[a-zA-Z]/.test(ch) ? ch.toLowerCase() : ''
      continue
    }
    out += initialCandidates(ch)[0]
  }
  return out
}

/**
 * 取全部候选串（多音字笛卡尔展开）；候选组合过多时截断到 limit，
 * 供基线召回做「任一候选命中即算命中」。
 */
export function pinyinCandidateStrings(input: string, limit = 32): string[] {
  let results: string[] = ['']
  for (const ch of input) {
    if (!/\p{Script=Han}/u.test(ch)) {
      const keep = /[a-zA-Z]/.test(ch) ? ch.toLowerCase() : ''
      results = results.map((r) => r + keep)
      continue
    }
    const candidates = initialCandidates(ch)
    const expanded: string[] = []
    for (const r of results) {
      for (const c of candidates) {
        expanded.push(r + c)
        if (expanded.length >= limit) break
      }
      if (expanded.length >= limit) break
    }
    results = expanded
  }
  return results
}

/** 是否全部汉字都能取到拼音首字母（用于判定降级排序键质量）。 */
export function isFullyPinyinMappable(input: string): boolean {
  for (const ch of input) {
    if (/\p{Script=Han}/u.test(ch) && !INITIAL_MAP.has(ch) && !POLYPHONIC[ch]) return false
  }
  return true
}
