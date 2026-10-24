/**
 * Тесты детектора петель.
 *
 * Запуск:  node test/detect.test.mjs
 * (Node 22.18+ / 24 умеет запускать TypeScript напрямую — без сборки.)
 */
import fs from "node:fs"
import path from "node:path"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { detectLoop, truncateLoop } from "../detect.ts"

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name) => fs.readFileSync(path.join(here, "fixtures", name), "utf8")

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (e) {
    failed++
    console.log(`  FAIL ${name}\n       ${e.message}`)
  }
}

function expectLoop(text, kind) {
  const v = detectLoop(text)
  assert.equal(v.loop, true, `ожидалась петля, получено: ${JSON.stringify(v)}`)
  if (kind) assert.equal(v.kind, kind, `ожидался тип ${kind}, получен ${v.kind}`)
  return v
}

function expectNoLoop(text) {
  const v = detectLoop(text)
  assert.equal(v.loop, false, `петля не ожидалась, получено: ${JSON.stringify(v)}\nтекст: ${JSON.stringify(text.slice(0, 200))}`)
  return v
}

console.log("hmm-defender / detectLoop")

// --- то, с чего всё началось -------------------------------------------------
check("ловит «hmm, hmm, hmm: hmm, hmm: …» из сообщения пользователя", () => {
  expectLoop("hmm, hmm, hmm: hmm, hmm: hmm, hmm: hmm, hmm, hmm: hmm, hmm,", "filler")
})

check("ловит «: hmm: hmm: …» (реальное рассуждение из живой сессии)", () => {
  const text = ": hmm: ".repeat(80)
  const v = expectLoop(text, "filler")
  assert.ok(v.cut >= 0, "ожидалось смещение начала мусора")
})

check("ловит повтор фразы («…inserts section is visible…»)", () => {
  const block =
    'The inserts section is visible with the frequency chips ("Перед каждой | Через 2 | Через 3 | ...") ✓ ' +
    'and "Проверить сейчас" at image (214, 1197) → device '
  expectLoop(block.repeat(6))
})

check("ловит повтор без пробелов («TheTheThe…»)", () => {
  expectLoop("The".repeat(60), "char-period")
})

check("ловит повтор одного слова", () => {
  expectLoop("работа работа работа работа работа работа работа работа работа", "word-period")
})

// --- реальные образцы из живых сессий (fixtures) ------------------------------
check("fixture: сплошные «: hmm: hmm:»", () => {
  expectLoop(fixture("filler-loop.txt"), "filler")
})

check("fixture: повторяющаяся фраза", () => {
  expectLoop(fixture("phrase-loop.txt"))
})

check("fixture: повторяющийся блок слов", () => {
  expectLoop(fixture("word-loop.txt"))
})

check("fixture: обычное рассуждение не считается петлёй", () => {
  expectNoLoop(fixture("normal-reasoning.txt"))
})

// --- защита от ложных срабатываний -------------------------------------------
check("не считает петлёй пару «hmm» в обычной речи", () => {
  expectNoLoop("Hmm, hmm: what if the platform passes a scalar string instead? Let me check the query compiler behaviour.")
  expectNoLoop("Ну, хм, надо подумать. Проверим сначала структуру, потом данные.")
})

check("не считает петлёй обычный текст с повторами", () => {
  expectNoLoop(
    "Проверяю конфигурацию. Открываю файл index.ts. Читаю содержимое. Вношу правки. " +
      "Проверяю конфигурацию. Открываю файл index.ts. Читаю содержимое. Вношу правки. " +
      "Проверяю конфигурацию. Открываю файл index.ts.",
  )
  expectNoLoop(
    "The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog. " +
      "Pack my box with five dozen liquor jugs. How vexingly quick daft zebras jump!",
  )
})

check("не считает петлёй код с отступами", () => {
  const code = [
    "function main() {",
    "    const a = 1",
    "    const b = 2",
    "    return a + b",
    "}",
    "",
    "class Foo {",
    "    bar() {",
    "        return 42",
    "    }",
    "}",
  ].join("\n")
  expectNoLoop(code)
})

check("не считает петлёй markdown-таблицу", () => {
  expectNoLoop(["| колонка | значение |", "| --- | --- |", "| а | 1 |", "| б | 2 |", "| в | 3 |"].join("\n"))
})

check("не считает петлёй список похожих строк", () => {
  expectNoLoop(
    ["- `ctx.session.interrupt({ sessionID, continue })`", "- `ctx.session.prompt({ sessionID, text })`", "- `ctx.session.synthetic({ sessionID, text })`"].join(
      "\n",
    ),
  )
})

check("не считает петлёй короткий текст", () => {
  expectNoLoop("hmm, hmm, hmm")
  expectNoLoop("ok")
})

check("truncateLoop убирает мусор и оставляет чистую часть", () => {
  const text = "Полезное начало ответа.\n\n" + ": hmm: ".repeat(60)
  const v = detectLoop(text)
  assert.equal(v.loop, true)
  const cut = truncateLoop(text, v)
  assert.ok(cut.startsWith("Полезное начало ответа."), "чистая часть должна сохраниться")
  assert.ok(!cut.includes(": hmm:"), "хвост должен быть удалён")
})

check("truncateLoop не трогает чистый текст", () => {
  const text = "Обычный ответ без повторов."
  assert.equal(truncateLoop(text, detectLoop(text)), text)
})

console.log(`\n${passed} ok, ${failed} fail`)
process.exit(failed ? 1 : 0)
