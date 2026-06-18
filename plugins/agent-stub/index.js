// agent-stub — каркасный плагин editor-агента на OpenClaw.
//
// ЖИВОЕ (доказывает, что каркас работает, БЕЗ вызова модели):
//   - команда /start — приветствие;
//   - эхо на любое входящее сообщение через хук before_dispatch.
//
// TODO(кандидат) — пайплайн агента: см. блок в конце register().
// Логика намеренно НЕ реализована: это и оценивается у кандидата.

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "agentstub",
  name: "OpenClaw Editor Agent (template)",
  description: "Editor agent: search + draft + approval gate",

  register(api) {
    // 1. Поиск через Tavily
    async function searchWeb(query) {
      const apiKey = process.env.SEARCH_API_KEY;

      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: apiKey,
        },
        body: JSON.stringify({
          query,
          max_results: 5,
        }),
      });

      const data = await res.json();
      return data.results || [];
    }

    // 2. Состояние (очень простое, в памяти)
    const sessions = {};

    // 📩 3. Команда статьи
    api.registerCommand({
      name: "article",
      description: "Создать статью по теме",
      acceptsArgs: false,
      requireAuth: false,

      handler: async (ctx) => {
        const text =
          ctx.message?.text || ctx.update?.message?.text;

        if (!text) {
          return {
            text: "Отправь тему статьи текстом.",
          };
        }

        // сохраняем тему
        sessions[ctx.user?.id || "default"] = {
          topic: text,
          note: "",
        };

        // поиск
        const results = await searchWeb(text);

        const sources = results
          .map((r) => `- ${r.url}`)
          .join("\n");

        // черновик статьи (пока без LLM — просто каркас)
        const draft =
          `📝 ЧЕРНОВИК СТАТЬИ\n\n` +
          `📌 Тема: ${text}\n\n` +
          `🔎 Источники:\n${sources}\n\n` +
          `✍️ Текст:\n` +
          `На основе найденных источников можно раскрыть тему "${text}".\n` +
          `(Здесь позже будет генерация через OpenRouter)`;

        return {
          text: draft,
          blocks: {
            type: "buttons",
            buttons: [
              { text: "Опубликовать", value: "publish" },
              { text: "Отклонить", value: "reject" },
            ],
          },
        };
      },
    });

    // 🎛 4. Обработка кнопок
    api.registerInteractiveHandler({
      channel: "telegram",
      namespace: "agentstub",

      handler: async (ctx) => {
        const action = ctx?.data?.value;
        const userId = ctx.user?.id || "default";
        const session = sessions[userId];

        if (!session) {
          return { text: "Нет активной статьи. Отправь новую тему." };
        }

        // публикация
        if (action === "publish") {
          await api.telegram.sendMessage(
            process.env.TELEGRAM_CHANNEL_ID,
            `📢 СТАТЬЯ\n\nТема: ${session.topic}`
          );

          return { text: "Опубликовано в канал ✅" };
        }

        // отклонение
        if (action === "reject") {
          session.note = "rejected";

          return {
            text:
              "Ок, напиши что исправить или уточнить по статье.",
          };
        }

        return { text: "Неизвестное действие." };
      },
    });

    // стартовая проверка
    api.registerCommand({
      name: "start",
      description: "start",
      handler: async () => ({
        text:
          "OpenClaw Editor Agent запущен.\nОтправь тему статьи текстом.",
      }),
    });
  },
});
    // ── ЖИВОЕ: эхо на любое входящее — доказывает long-polling и обработку без LLM ──
    //    TODO(кандидат): удали этот эхо-хук, когда подключишь реальный пайплайн ниже.
    // ─────────────────────────────────────────────────────────────────────────
    // TODO(кандидат): реализовать пайплайн editor-агента.
    // Ничего из этого в шаблоне не реализовано НАМЕРЕННО.
    //
    //   1. Приём темы из Telegram (текст пользователя).
    //   2. Поиск источников через Tavily.
    //      Ключ: process.env.SEARCH_API_KEY (entrypoint пробрасывает его в TAVILY_API_KEY,
    //      который читает нативный tavily-плагин). Инструменты: web_search / tavily_search.
    //   3. Генерация статьи СО ССЫЛКАМИ на реальные источники через OpenRouter
    //      (api.runtime.llm.complete(...), формат OpenAI). Ключ: OPENROUTER_API_KEY.
    //   4. Публикация ЧЕРНОВИКА в канал (process.env.TELEGRAM_CHANNEL_ID) с inline-кнопками
    //      [Опубликовать] / [Отклонить]:
    //        - кнопки: registerCommand -> presentation.blocks ({type:"buttons", buttons:[...]}),
    //        - нажатия: api.registerInteractiveHandler({channel:"telegram", namespace, handler}).
    //   5. Доработка статьи по замечанию человека.
    //   6. Публикация в канал ТОЛЬКО после явного согласия человека (нажатие кнопки).
    //
    // Правила (см. README): без хардкода ключей; ссылки на реальные источники;
    // без согласования не публиковать.
    // ─────────────────────────────────────────────────────────────────────────
  },
});
