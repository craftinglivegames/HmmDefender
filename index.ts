/**
 * hmm-defender
 * ----------
 * Защита от вырожденного «залипания» модели (петли вида «hmm, hmm, hmm: hmm, hmm: …»).
 *
 * Что делает плагин:
 *   1. Следит за потоком рассуждения модели (события `session.reasoning.delta`).
 *   2. Как только в потоке найдено вырожденное повторение — обрывает генерацию
 *      (`ctx.session.interrupt`) и просит модель продолжить с конкретного шага.
 *   3. Перед следующим запросом чинит историю: повторяющийся кусок вырезается из
 *      сообщений модели, чтобы она не «заразилась» своим же мусором.
 *   4. Добавляет в системный промпт короткое правило, запрещающее залипание.
 *
 * Настройки: файл `config.json` рядом с плагином (см. README) или объект `options`
 * в секции `plugins` файла opencode.json.
 */

import { Plugin } from "@opencode/plugin"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { DEFAULT_OPTIONS, detectLoop, truncateLoop, type DetectOptions, type Verdict } from "./detect"

const here = path.dirname(fileURLToPath(import.meta.url))

const PREVENTION =
  "Loop guard (anti-repetition): never repeat yourself. Do not emit the same filler sound " +
  '("hmm", "uh", "um") more than twice in a row, and never repeat an entire phrase or sentence verbatim. ' +
  "If you are stuck or unsure what to do next, name ONE concrete next step and perform it instead of thinking in circles."

const REPAIR_NOTE =
  "Loop guard: your previous output degenerated into a repeating loop (for example \"hmm, hmm, hmm...\"). " +
  "The repetitive fragment was removed from the conversation. Do not reproduce it. " +
  "Continue from the remaining context with a concrete action or a direct answer."

const CORRECTIVE =
  "Your previous reasoning degenerated into a repeating loop and was interrupted by the loop guard. " +
  "Do not repeat filler or the same phrase over and over. Continue the task from where it stopped: " +
  "state the single next concrete step and do it."

/** Общий для всех экземпляров плагина журнал спасений (плагин грузится по одному каталогу на проект). */
const globalHandled = new Set<string>()

interface Options extends Partial<DetectOptions> {
  enabled?: boolean
  interrupt?: boolean
  resume?: boolean
  prevention?: boolean
  pollText?: boolean
  maxRescues?: number
  log?: boolean
  logPath?: string
  resumeDelayMs?: number
  pollIntervalMs?: number
  checkEvery?: number
  debug?: boolean
}

interface SessionState {
  /** ключ сообщения -> накопленный текст рассуждения (хвост) */
  buffers: Map<string, string>
  /** ключ сообщения -> сколько символов всего пришло (для правильного учёта прироста) */
  totals: Map<string, number>
  /** ключ сообщения -> до какого места уже проверяли */
  checked: Map<string, number>
  /** ключи сообщений, по которым уже вмешались */
  handled: Set<string>
  stepActive: boolean
  stepStartedAt: number
  lastStepAt: number
  interruptedAt: number
  rescues: number
  repairs: number
  loops: number
}

function newState(): SessionState {
  return {
    buffers: new Map(),
    totals: new Map(),
    checked: new Map(),
    handled: new Set(),
    stepActive: false,
    stepStartedAt: 0,
    lastStepAt: 0,
    interruptedAt: 0,
    rescues: 0,
    repairs: 0,
    loops: 0,
  }
}

function readConfig(): Options {
  try {
    const raw = fs.readFileSync(path.join(here, "config.json"), "utf8")
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? (parsed as Options) : {}
  } catch {
    return {}
  }
}

export default Plugin.define({
  id: "hmm-defender",
  async setup(ctx) {
    const raw = { ...readConfig(), ...((ctx.options ?? {}) as Options) }
    const opts: Options = {
      ...DEFAULT_OPTIONS,
      enabled: raw.enabled !== false,
      interrupt: raw.interrupt !== false,
      resume: raw.resume !== false,
      prevention: raw.prevention !== false,
      pollText: raw.pollText === true,
      maxRescues: typeof raw.maxRescues === "number" ? raw.maxRescues : 3,
      log: raw.log !== false,
      logPath: raw.logPath ?? path.join(here, "hmm-defender.log"),
      resumeDelayMs: typeof raw.resumeDelayMs === "number" ? raw.resumeDelayMs : 2500,
      pollIntervalMs: typeof raw.pollIntervalMs === "number" ? raw.pollIntervalMs : 3000,
      checkEvery: typeof raw.checkEvery === "number" ? raw.checkEvery : 256,
      debug: raw.debug === true,
      ...raw,
    }

    const logFile = opts.logPath as string
    const log = (message: string) => {
      if (!opts.log) return
      try {
        fs.mkdirSync(path.dirname(logFile), { recursive: true })
        try {
          if (fs.statSync(logFile).size > 256_000) fs.renameSync(logFile, logFile + ".old")
        } catch {}
        fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`)
      } catch {}
    }
    const debug = (message: string) => {
      if (opts.debug) log(`[debug] ${message}`)
    }

    const states = new Map<string, SessionState>()
    const state = (sessionID: string): SessionState => {
      let s = states.get(sessionID)
      if (!s) {
        s = newState()
        states.set(sessionID, s)
      }
      return s
    }

    const myDirectory = (ctx.location?.directory ?? "").replace(/[\\/]+$/u, "").toLowerCase()
    const inMyLocation = (ev: any): boolean => {
      const dir = ev?.location?.directory
      if (!dir) return true
      if (!myDirectory) return true
      return dir.replace(/[\\/]+$/u, "").toLowerCase() === myDirectory
    }

    // ---------------------------------------------------------------- спасение

    const rescue = async (sessionID: string, key: string, verdict: Verdict, source: string) => {
      const st = state(sessionID)
      const globalKey = `${sessionID}:${key}`
      if (st.handled.has(key) || globalHandled.has(globalKey)) return
      st.handled.add(key)
      globalHandled.add(globalKey)
      st.loops++
      log(
        `петля (${verdict.kind}, ratio=${verdict.ratio.toFixed(2)}, повторов=${verdict.repeats}, ` +
          `период=${verdict.period}, источник=${source}) в сессии ${sessionID}: ${JSON.stringify(verdict.sample.slice(0, 120))}`,
      )
      if (st.rescues >= (opts.maxRescues as number)) {
        log(`достигнут лимит спасений (${opts.maxRescues}) для сессии ${sessionID} — дальше не вмешиваемся`)
        return
      }
      st.rescues++
      st.interruptedAt = Date.now()

      if (opts.interrupt) {
        // Сначала прерываем без продолжения цикла: так обрывается именно текущая генерация.
        let done = false
        try {
          await ctx.session.interrupt({ sessionID })
          done = true
          log(`генерация прервана в сессии ${sessionID}`)
        } catch (e) {
          try {
            await ctx.session.interrupt({ sessionID, continue: false })
            done = true
            log(`генерация прервана (continue=false) в сессии ${sessionID}`)
          } catch (e2) {
            log(`не удалось прервать генерацию: ${String(e2)}`)
          }
        }
        if (!done) {
          try {
            await ctx.session.interrupt({ sessionID, continue: true })
            log(`генерация прервана (continue=true) в сессии ${sessionID}`)
          } catch {}
        }
      }

      if (opts.resume) scheduleResume(sessionID)
    }

    const scheduleResume = (sessionID: string) => {
      const delay = opts.resumeDelayMs as number
      setTimeout(async () => {
        const st = state(sessionID)
        if (st.lastStepAt > st.interruptedAt) return // цикл продолжился сам — вмешиваться не нужно
        // После прерывания сессия обычно простаивает, поэтому сообщение нужно
        // поставить в очередь (delivery: "queue"). Пробуем несколько способов.
        const attempts: Array<() => Promise<unknown>> = [
          () => ctx.session.synthetic({ sessionID, text: CORRECTIVE, delivery: "queue" }),
          () => ctx.session.prompt({ sessionID, text: CORRECTIVE, delivery: "queue" }),
          () => ctx.session.synthetic({ sessionID, text: CORRECTIVE }),
          () => ctx.session.prompt({ sessionID, text: CORRECTIVE }),
        ]
        for (const attempt of attempts) {
          try {
            await attempt()
            log(`отправлено уточнение для продолжения в сессии ${sessionID}`)
            return
          } catch (e) {
            debug(`попытка продолжения не удалась: ${String(e)}`)
          }
        }
        log(`не удалось продолжить сессию ${sessionID}: все способы не сработали`)
      }, delay)
    }

    // ---------------------------------------------------------------- события

    const checkBuffer = async (sessionID: string, key: string, text: string, total: number) => {
      const st = state(sessionID)
      const last = st.checked.get(key) ?? 0
      const grown = total - last
      const cheap = /(?:\b(?:hmm|hm|um|uh|erm|er|ehm|хм|мм|эм)\b){4,}/iu.test(text.slice(-400))
      if (!cheap && grown < (opts.checkEvery as number)) return
      st.checked.set(key, total)
      const verdict = detectLoop(text, opts)
      debug(`проверка ${sessionID} ${key}: символов=${text.length} прирост=${grown} вердикт=${verdict.kind}/${verdict.loop}`)
      if (!verdict.loop) return
      await rescue(sessionID, key, verdict, "reasoning")
    }

    const onEvent = async (ev: any) => {
      const type = ev?.type as string
      const data = ev?.data ?? {}
      const sessionID = data.sessionID as string | undefined
      if (!sessionID) return
      if (!inMyLocation(ev)) return
      const st = state(sessionID)

      switch (type) {
        case "session.step.started": {
          st.stepActive = true
          st.stepStartedAt = Date.now()
          st.lastStepAt = Date.now()
          st.buffers.clear()
          st.totals.clear()
          st.checked.clear()
          break
        }
        case "session.step.ended": {
          st.stepActive = false
          st.buffers.clear()
          st.totals.clear()
          st.checked.clear()
          break
        }
        case "session.reasoning.started": {
          const key = `${data.assistantMessageID ?? ""}:${data.ordinal ?? 0}`
          st.buffers.set(key, "")
          st.totals.set(key, 0)
          st.checked.set(key, 0)
          break
        }
        case "session.reasoning.delta": {
          const key = `${data.assistantMessageID ?? ""}:${data.ordinal ?? 0}`
          const delta = typeof data.delta === "string" ? data.delta : ""
          if (!delta) break
          const buffer = (st.buffers.get(key) ?? "") + delta
          // Держим только хвост: петля всегда в конце, память не растёт.
          st.buffers.set(key, buffer.length > 20000 ? buffer.slice(-20000) : buffer)
          const total = (st.totals.get(key) ?? 0) + delta.length
          st.totals.set(key, total)
          await checkBuffer(sessionID, key, st.buffers.get(key) as string, total)
          break
        }
        case "session.reasoning.ended": {
          const key = `${data.assistantMessageID ?? ""}:${data.ordinal ?? 0}`
          st.buffers.delete(key)
          st.totals.delete(key)
          st.checked.delete(key)
          break
        }
      }
    }

    let controller: AbortController | undefined
    if (ctx.event && typeof ctx.event.subscribe === "function") {
      controller = new AbortController()
      void (async () => {
        try {
          for await (const ev of ctx.event.subscribe({ signal: controller.signal })) {
            try {
              await onEvent(ev)
            } catch (e) {
              log(`ошибка обработки события: ${String(e)}`)
            }
          }
        } catch (e) {
          log(`поток событий прерван: ${String(e)}`)
        }
      })()
      log(`hmm-defender запущен (каталог: ${ctx.location?.directory ?? "?"})`)
    } else {
      log("hmm-defender: нет доступа к потоку событий — работает только чистка истории")
    }

    // ------------------------------------------------------------- чистка истории

    const repairMessages = (messages: any[]): number => {
      let count = 0
      for (const msg of messages) {
        if (!msg || msg.role !== "assistant") continue
        const blocks = Array.isArray(msg.content) ? msg.content : null
        if (!blocks) continue
        for (const block of blocks) {
          if (!block || (block.type !== "text" && block.type !== "reasoning")) continue
          if (typeof block.text !== "string" || block.text.length < 40) continue
          const verdict = detectLoop(block.text, opts)
          if (!verdict.loop) continue
          const cleaned = truncateLoop(block.text, verdict)
          try {
            block.text = cleaned
            if (block.text === cleaned) count++
          } catch {}
        }
      }
      return count
    }

    if (ctx.session && typeof ctx.session.hook === "function") {
      await ctx.session.hook("context", (event: any) => {
        try {
          if (opts.prevention && Array.isArray(event.system)) {
            event.system.push({ type: "text", text: PREVENTION })
          }
          const repaired = repairMessages(event.messages ?? [])
          if (repaired > 0) {
            const st = state(event.sessionID)
            st.repairs += repaired
            log(`история почищена: ${repaired} блок(ов) в сессии ${event.sessionID}`)
            if (Array.isArray(event.system)) event.system.push({ type: "text", text: REPAIR_NOTE })
          }
        } catch (e) {
          log(`ошибка в hook context: ${String(e)}`)
        }
      })
    }

    // ----------------------------------------------- опрос текстового вывода

    let pollTimer: ReturnType<typeof setInterval> | undefined
    if (opts.pollText && ctx.session && typeof ctx.session.context === "function") {
      pollTimer = setInterval(async () => {
        for (const [sessionID, st] of states) {
          if (!st.stepActive) continue
          if (Date.now() - st.stepStartedAt < 4000) continue
          try {
            const res: any = await ctx.session.context({ sessionID })
            const list = Array.isArray(res) ? res : (res?.messages ?? [])
            for (let i = list.length - 1; i >= 0; i--) {
              const item = list[i]
              const info = item?.info ?? item
              if (info?.role !== "assistant" && info?.type !== "assistant") continue
              const blocks = item?.parts ?? info?.content ?? []
              for (const block of blocks as any[]) {
                if (!block || (block.type !== "text" && block.type !== "reasoning")) continue
                if (typeof block.text !== "string" || block.text.length < 40) continue
                const verdict = detectLoop(block.text, opts)
                if (!verdict.loop) continue
                await rescue(sessionID, `${info?.id ?? "text"}:poll`, verdict, "poll")
              }
              break
            }
          } catch {}
        }
      }, opts.pollIntervalMs as number)
    }

    // ------------------------------------------------------------------ tools

    if (ctx.tool && typeof ctx.tool.transform === "function") {
      await ctx.tool.transform((editor: any) => {
        editor.namespace({
          name: "hmm_defender",
          description: "Диагностика защиты от залипания модели (hmm-defender).",
        })
        editor.add({
          name: "hmm_defender_check",
          description: "Проверить текст на вырожденное повторение (петлю вида «hmm, hmm, hmm: …»).",
          input: {
            type: "object",
            properties: { text: { type: "string", description: "Текст для проверки" } },
            required: ["text"],
            additionalProperties: false,
          },
          options: { codemode: true },
          execute: async (input: any) => {
            const text = String(input?.text ?? "")
            const verdict = detectLoop(text, opts)
            return {
              content: JSON.stringify(
                {
                  loop: verdict.loop,
                  kind: verdict.kind,
                  ratio: Number(verdict.ratio.toFixed(3)),
                  repeats: verdict.repeats,
                  period: verdict.period,
                  cut: verdict.cut,
                  sample: verdict.sample.slice(0, 200),
                  length: text.length,
                },
                null,
                2,
              ),
            }
          },
        })
        editor.add({
          name: "hmm_defender_status",
          description: "Состояние защиты от залипания: сколько петель найдено, сколько раз модель спасено.",
          input: { type: "object", properties: {}, additionalProperties: false },
          options: { codemode: true },
          execute: async () => {
            const sessions = [...states.entries()].map(([id, s]) => ({
              sessionID: id,
              loops: s.loops,
              rescues: s.rescues,
              repairs: s.repairs,
              stepActive: s.stepActive,
            }))
            return {
              content: JSON.stringify(
                {
                  enabled: opts.enabled,
                  directory: ctx.location?.directory ?? null,
                  options: {
                    interrupt: opts.interrupt,
                    resume: opts.resume,
                    prevention: opts.prevention,
                    pollText: opts.pollText,
                    maxRescues: opts.maxRescues,
                    fillerMinHits: opts.fillerMinHits,
                    fillerMinRatio: opts.fillerMinRatio,
                    wordSimilarity: opts.wordSimilarity,
                    charSimilarity: opts.charSimilarity,
                  },
                  totals: {
                    loops: sessions.reduce((a, s) => a + s.loops, 0),
                    rescues: sessions.reduce((a, s) => a + s.rescues, 0),
                    repairs: sessions.reduce((a, s) => a + s.repairs, 0),
                  },
                  sessions,
                  log: logFile,
                },
                null,
                2,
              ),
            }
          },
        })
      })
    }

    return () => {
      try {
        if (pollTimer) clearInterval(pollTimer)
        controller?.abort()
      } catch {}
    }
  },
})
