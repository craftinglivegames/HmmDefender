/**
 * hmm-defender / detect.ts
 * ----------------------
 * Детектор вырожденного повторения («петли») в тексте, который выдаёт модель.
 *
 * Модель периодически «залипает»: рассуждение превращается в
 *   ": hmm: hmm: hmm: hmm: ..."      (заполнитель)
 *   "TheTheThe... inserts section is visible with ..."  (повтор фразы)
 * и генерация не заканчивается — токены тратятся впустую.
 *
 * Модуль чистый: никакого OpenCode, только текст -> вердикт.
 * Благодаря этому его легко тестировать обычным node-тестом.
 */

export type LoopKind = "none" | "filler" | "word-period" | "char-period"

export interface DetectOptions {
  /** Сколько символов с конца текста анализировать. */
  windowChars: number
  /** Минимум «заполнителей» (hmm/um/uh…) в хвосте, чтобы считать петлёй. */
  fillerMinHits: number
  /** Доля заполнителей среди слов хвоста. */
  fillerMinRatio: number
  /** Слова-заполнители (в нижнем регистре, без пунктуации). */
  fillerWords: string[]
  /** Максимальный период повтора в словах. */
  wordPeriodMax: number
  /** Сколько повторов блока считать петлёй (по словам). */
  wordMinRepeats: number
  /** Доля совпавших слов в периоде. */
  wordSimilarity: number
  /** Максимальный период повтора в символах. */
  charPeriodMax: number
  /** Минимальный период в символах (3 — иначе ловим обычные отступы). */
  charPeriodMin: number
  /** Сколько повторов блока считать петлёй (по символам). */
  charMinRepeats: number
  /** Доля совпавших символов в периоде. */
  charSimilarity: number
  /** Минимальная длина повторяющегося участка в символах. */
  minLoopChars: number
  /** Сколько символов с конца текста реально сканировать (длинные сообщения не читаем целиком). */
  maxScanChars: number
}

export const DEFAULT_OPTIONS: DetectOptions = {
  windowChars: 2400,
  fillerMinHits: 8,
  fillerMinRatio: 0.5,
  fillerWords: [
    "hmm",
    "hmmm",
    "hm",
    "hmh",
    "mhm",
    "mm",
    "mmm",
    "mmmm",
    "um",
    "umm",
    "uh",
    "uhh",
    "uhm",
    "erm",
    "er",
    "ehm",
    "huh",
    "хм",
    "хмм",
    "мм",
    "ммм",
    "эм",
    "эмм",
    "тьм",
    "м-м",
  ],
  wordPeriodMax: 64,
  wordMinRepeats: 3,
  wordSimilarity: 0.8,
  charPeriodMax: 384,
  charPeriodMin: 3,
  charMinRepeats: 4,
  charSimilarity: 0.8,
  minLoopChars: 40,
  maxScanChars: 20000,
}

export interface Verdict {
  /** Петля обнаружена. */
  loop: boolean
  /** Тип петли. */
  kind: LoopKind
  /** Насколько уверенно (0..1). */
  ratio: number
  /** Сколько раз повторился блок. */
  repeats: number
  /** Длина периода (слова / символы). */
  period: number
  /** Смещение в тексте, где начинается вырожденный участок (-1 — неизвестно). */
  cut: number
  /** Короткий пример найденного повтора. */
  sample: string
}

const NO_LOOP: Verdict = {
  loop: false,
  kind: "none",
  ratio: 0,
  repeats: 0,
  period: 0,
  cut: -1,
  sample: "",
}

interface Token {
  /** Исходный текст токена. */
  raw: string
  /** Нормализованный (lower-case, без пунктуации) — для сравнения. */
  norm: string
  /** Слово ли это (буквы/цифры), а не одиночный знак. */
  word: boolean
  /** Позиция в исходном тексте. */
  start: number
  /** Конец токена в исходном тексте. */
  end: number
}

const TOKEN_RE = /[\p{L}\p{N}_'’]+|[^\s]/gu

function tokenize(text: string): Token[] {
  const out: Token[] = []
  TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const raw = m[0]
    const word = /[\p{L}\p{N}_]/u.test(raw)
    out.push({
      raw,
      norm: word ? raw.toLowerCase() : raw,
      word,
      start: m.index,
      end: m.index + raw.length,
    })
  }
  return out
}

/** Хвост текста: последние `chars` символов, но не режем середину слова. */
function tailOf(text: string, chars: number): string {
  if (text.length <= chars) return text
  const cut = text.length - chars
  const space = text.indexOf(" ", cut)
  return space === -1 ? text.slice(cut) : text.slice(space + 1)
}

/**
 * Ищет «заполнитель» (hmm, um, uh…) в хвосте текста.
 * Возвращает вердикт и смещение начала вырожденного участка.
 */
function detectFiller(tokens: Token[], o: DetectOptions, filler: Set<string>): Verdict | null {
  if (tokens.length === 0) return null

  // 1) Сплошной хвост из заполнителей (самый частый случай: «: hmm: hmm: hmm:»).
  let lastWord = -1
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i].word) {
      lastWord = i
      break
    }
  }
  if (lastWord >= 0) {
    let i = lastWord
    while (i >= 0) {
      const t = tokens[i]
      if (t.word && !filler.has(t.norm)) break
      i--
    }
    const start = i + 1
    const run = tokens.slice(start, lastWord + 1)
    const runWords = run.filter((t) => t.word)
    const hits = runWords.filter((t) => filler.has(t.norm)).length
    // Начало мусора — первое слово-заполнитель в блоке (пунктуация перед ним остаётся в чистой части).
    const firstFiller = run.findIndex((t) => t.word && filler.has(t.norm))
    const cutIndex = firstFiller >= 0 ? start + firstFiller : start
    const chars = run.length ? run[run.length - 1].end - tokens[cutIndex].start : 0
    if (hits >= o.fillerMinHits && runWords.length > 0 && hits / runWords.length >= o.fillerMinRatio && chars >= o.minLoopChars) {
      return {
        loop: true,
        kind: "filler",
        ratio: hits / runWords.length,
        repeats: hits,
        period: 1,
        cut: tokens[cutIndex].start,
        sample: run
          .slice(0, 24)
          .map((t) => t.raw)
          .join(" "),
      }
    }
  }

  // 2) Заполнители в окне (реже встречается «hmm, hmm ... текст ... hmm, hmm»).
  const window = tokens.slice(-400)
  const words = window.filter((t) => t.word)
  if (words.length >= 8) {
    const hits = words.filter((t) => filler.has(t.norm)).length
    if (hits >= o.fillerMinHits && hits / words.length >= o.fillerMinRatio) {
      // Начало последнего сплошного блока заполнителей.
      let i = words.length - 1
      while (i >= 0 && !filler.has(words[i].norm)) i--
      let j = i
      while (j >= 0 && filler.has(words[j].norm)) j--
      const cut = j + 1 < words.length ? words[j + 1].start : -1
      return {
        loop: true,
        kind: "filler",
        ratio: hits / words.length,
        repeats: hits,
        period: 1,
        cut,
        sample: words
          .slice(Math.max(0, j + 1), Math.min(words.length, j + 10))
          .map((t) => t.raw)
          .join(" "),
      }
    }
  }

  return null
}

/** Повтор блока слов (например, повторяющаяся фраза). */
function detectWordPeriod(words: Token[], o: DetectOptions): Verdict | null {
  const n = words.length
  const maxPeriod = Math.min(o.wordPeriodMax, Math.floor(n / o.wordMinRepeats) - 1)
  for (let p = 1; p <= maxPeriod; p++) {
    const m = p * o.wordMinRepeats
    if (m > n) break
    const base = n - m
    const need = o.wordSimilarity * (m - p)
    let matches = 0
    let ok = true
    for (let i = p; i < m; i++) {
      if (words[base + i].norm === words[base + i - p].norm) matches++
      // Досрочный выход: нужная доля уже недостижима.
      if (matches + (m - i - 1) < need) {
        ok = false
        break
      }
    }
    if (!ok) continue
    const ratio = matches / (m - p)
    if (ratio < o.wordSimilarity) continue
    // Продлеваем петлю назад, пока блоки повторяются.
    let start = base
    let repeats = o.wordMinRepeats
    while (start - p >= 0) {
      let ok = 0
      for (let i = 0; i < p; i++) if (words[start - p + i].norm === words[start + i].norm) ok++
      if (ok / p < o.wordSimilarity) break
      start -= p
      repeats++
    }
    const cut = words[start].start
    const chars = words[n - 1].end - cut
    if (chars < o.minLoopChars) continue
    return {
      loop: true,
      kind: "word-period",
      ratio,
      repeats,
      period: p,
      cut,
      sample: words
        .slice(start, start + Math.min(p, 24))
        .map((t) => t.raw)
        .join(" "),
    }
  }
  return null
}

/** Повтор блока символов (например, «TheTheTheThe…» без пробелов). */
function detectCharPeriod(text: string, o: DetectOptions): Verdict | null {
  const tail = tailOf(text, o.windowChars)
  const lower = tail.toLowerCase()
  const n = lower.length
  const maxPeriod = Math.min(o.charPeriodMax, Math.floor(n / o.charMinRepeats) - 1)
  for (let p = o.charPeriodMin; p <= maxPeriod; p++) {
    const m = p * o.charMinRepeats
    const base = n - m
    const need = o.charSimilarity * (m - p)
    let matches = 0
    let ok = true
    for (let i = p; i < m; i++) {
      if (lower[base + i] === lower[base + i - p]) matches++
      if (matches + (m - i - 1) < need) {
        ok = false
        break
      }
    }
    if (!ok) continue
    const ratio = matches / (m - p)
    if (ratio < o.charSimilarity) continue
    // Продлеваем назад.
    let start = base
    let repeats = o.charMinRepeats
    while (start - p >= 0) {
      let ok = 0
      for (let i = 0; i < p; i++) if (lower[start - p + i] === lower[start + i]) ok++
      if (ok / p < o.charSimilarity) break
      start -= p
      repeats++
    }
    const block = tail.slice(start, start + p)
    // Отступы/пунктуация не считаем петлёй.
    const spaces = (block.match(/\s/g) ?? []).length
    if (block.length > 0 && spaces / block.length > 0.6) continue
    const cut = text.length - tail.length + start
    const chars = text.length - cut
    if (chars < o.minLoopChars) continue
    return {
      loop: true,
      kind: "char-period",
      ratio,
      repeats,
      period: p,
      cut,
      sample: block.slice(0, 80),
    }
  }
  return null
}

/**
 * Главная функция: проверяет текст на вырожденное повторение.
 * `cut` в вердикте — смещение в переданном тексте, где начинается мусор.
 */
export function detectLoop(text: string, options: Partial<DetectOptions> = {}): Verdict {
  const o: DetectOptions = { ...DEFAULT_OPTIONS, ...options }
  if (!text || text.length < o.minLoopChars) return NO_LOOP

  // Длинные сообщения сканируем только с конца — петля всегда в хвосте.
  const offset = Math.max(0, text.length - o.maxScanChars)
  const scan = offset > 0 ? text.slice(offset) : text

  const tokens = tokenize(scan)
  if (tokens.length === 0) return NO_LOOP

  const filler = new Set(o.fillerWords.map((w) => w.toLowerCase()))

  const f = detectFiller(tokens, o, filler)
  if (f) return shift(f, offset)

  const words = tokens.filter((t) => t.word)
  const w = detectWordPeriod(words, o)
  if (w) return shift(w, offset)

  const c = detectCharPeriod(scan, o)
  if (c) return shift(c, offset)

  return NO_LOOP
}

function shift(v: Verdict, offset: number): Verdict {
  if (offset <= 0 || v.cut < 0) return v
  return { ...v, cut: v.cut + offset }
}

/** Убирает вырожденный хвост, оставляя «чистую» часть текста. */
export function truncateLoop(text: string, verdict: Verdict, marker = "[hmm-defender] повторяющийся фрагмент удалён"): string {
  if (!verdict.loop) return text
  const cut = verdict.cut > 0 ? verdict.cut : 0
  const head = text.slice(0, cut).replace(/\s+$/u, "")
  return head.length ? `${head}\n\n${marker}` : marker
}
