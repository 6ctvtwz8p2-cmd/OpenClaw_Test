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
  name: "OpenClaw Editor Agent",
  description: "Full pipeline agent: search → generate → draft → approve → publish",

  register(api) {

    async function searchWeb(query) {
      const apiKey = process.env.SEARCH_API_KEY;

      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({
          query,
          max_results: 5,
        }),
      });

      const data = await res.json();
      return data.results || [];
    }

    async function generateArticle(topic, sources, feedback = "") {
      const apiKey = process.env.OPENROUTER_API_KEY;

      const prompt = `
Ты редактор новостных статей.

Напиши статью на русском языке.

ТЕМА:
${topic}

ИСТОЧНИКИ (используй только их):
${sources.map(s => s.url).join("\n")}

${feedback ? `ИСПРАВЛЕНИЯ ОТ РЕДАКТОРА:\n${feedback}\n` : ""}

ПРАВИЛА:
- не выдумывай факты
- используй только источники
- обязательно вставляй ссылки
- заголовок обязателен
- 3–6 абзацев
- короткий вывод
`;

      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
        }),
      });

      const data = await res.json();
      return data.choices?.[0]?.message?.content || "Ошибка генерации";
    }

    const sessions = {};

    api.registerCommand({
      name: "article",
      description: "Generate article",
      acceptsArgs: false,
      requireAuth: false,

      handler: async (ctx) => {
        const text = ctx.message?.text || ctx.update?.message?.text;

        if (!text) {
          return { text: "Отправь тему статьи текстом." };
        }

        const userId = ctx.user?.id || "default";

        const results = await searchWeb(text);

        const article = await generateArticle(text, results);

        sessions[userId] = {
          topic: text,
          sources: results,
          article,
          feedback: "",
        };

        const sourcesText = results.map(r => `- ${r.url}`).join("\n");

        const draft =
          `📝 ЧЕРНОВИК СТАТЬИ\n\n` +
          `📌 ТЕМА: ${text}\n\n` +
          `🔎 ИСТОЧНИКИ:\n${sourcesText}\n\n` +
          `✍️ СТАТЬЯ:\n${article}`;

        return {
          text: draft,
          blocks: {
            type: "buttons",
            buttons: [
              { text: "Опубликовать", value: "publish" },
              { text: "Отклонить", value: "reject" }
            ]
          }
        };
      }
    });

    api.registerInteractiveHandler({
      channel: "telegram",
      namespace: "agentstub",

      handler: async (ctx) => {
        const action = ctx?.data?.value;
        const userId = ctx.user?.id || "default";
        const session = sessions[userId];

        if (!session) {
          return { text: "Нет активной статьи. Отправь тему заново." };
        }

        if (action === "publish") {
          await api.telegram.sendMessage(
            process.env.TELEGRAM_CHANNEL_ID,
            `📢 СТАТЬЯ\n\n${session.article}`
          );

          return { text: "Опубликовано в канал ✅" };
        }

        if (action === "reject") {
          const feedback = ctx.message?.text || "Нужно улучшить статью";

          session.feedback = feedback;

          const newArticle = await generateArticle(
            session.topic,
            session.sources,
            feedback
          );

          session.article = newArticle;

          const sourcesText = session.sources.map(r => `- ${r.url}`).join("\n");

          return {
            text:
              `📝 ОБНОВЛЁННЫЙ ЧЕРНОВИК\n\n` +
              `📌 ТЕМА: ${session.topic}\n\n` +
              `🔎 ИСТОЧНИКИ:\n${sourcesText}\n\n` +
              `✍️ СТАТЬЯ:\n${newArticle}`,
            blocks: {
              type: "buttons",
              buttons: [
                { text: "Опубликовать", value: "publish" },
                { text: "Отклонить", value: "reject" }
              ]
            }
          };
        }

        return { text: "Неизвестное действие." };
      }
    });

    api.registerCommand({
      name: "start",
      description: "Start bot",
      handler: async () => ({
        text: "OpenClaw Editor Agent запущен. Отправь тему статьи."
      })
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
