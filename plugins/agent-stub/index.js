// agent-stub — каркасный плагин editor-агента на OpenClaw.
//
// ЖИВОЕ (доказывает, что каркас работает, БЕЗ вызова модели):
//   - команда /start — приветствие;
//   - эхо на любое входящее сообщение через хук before_dispatch.
//
// TODO(кандидат) — пайплайн агента: см. блок в конце register().
// Логика намеренно НЕ реализована: это и оценивается у кандидата.

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import crypto from "crypto";

export default definePluginEntry({
  id: "agentstub",
  name: "OpenClaw Editor Agent",
  description: "Editor agent: web search → LLM article → draft approval → publish",

  register(api) {
    const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

    const drafts = new Map();
    const awaitingFeedback = new Map();

    api.registerCommand({
      name: "start",
      description: "Start bot",
      handler: () => ({
        text:
          "Editor-agent активирован.\n\n" +
          "Отправь тему → я соберу статью + источники → отправлю черновик.\n" +
          "Дальше ты можешь опубликовать или отклонить.",
        continueAgent: false,
      }),
    });

    api.on("message", async (event) => {
      const text = String(event?.content ?? "").trim();
      const chatId = event?.chatId || event?.senderId;

      if (!text || text.startsWith("/")) return;

      const draftId = awaitingFeedback.get(chatId);

      if (draftId) {
        awaitingFeedback.delete(chatId);

        const draft = drafts.get(draftId);
        if (!draft) return;

        return runPipeline(api, chatId, draft.topic, text, true, draftId);
      }

      return runPipeline(api, chatId, text);
    });

    async function runPipeline(api, chatId, topic, feedback = null, isRewrite = false, existingDraftId = null) {
      try {
        const searchRes = await api.runtime.webSearch.search({
          args: { query: topic },
        });

        const results = searchRes?.result?.results || [];

        const sources = results.slice(0, 5).map((r, i) => ({
          id: i + 1,
          title: r.title,
          url: r.url,
          content: r.content,
        }));

        const prompt = `
Ты редактор новостного агентства.

Напиши структурированную статью на тему: "${topic}".

Используй источники:
${sources.map(s => `[${s.id}] ${s.title} - ${s.url}`).join("\n")}

Правила:
- нейтральный стиль
- структура: заголовки + абзацы
- обязательно ссылки вида [1], [2]
- используй только данные из источников

${feedback ? `\nЗамечания пользователя:\n${feedback}` : ""}
`;

        const out = await api.runtime.llm.complete({
          messages: [{ role: "user", content: prompt }],
        });

        const article = out?.text || "Ошибка генерации статьи";

        const draftId = existingDraftId || crypto.randomUUID();

        const draft = {
          chatId,
          topic,
          article,
          sources,
        };

        drafts.set(draftId, draft);

        const message = {
          channel: "telegram",
          to: TELEGRAM_CHANNEL_ID,
          content: {
            text:
              article +
              "\n\nИсточники:\n" +
              sources.map(s => `[${s.id}] ${s.url}`).join("\n"),
            presentation: {
              blocks: [
                {
                  type: "buttons",
                  buttons: [
                    {
                      label: "Опубликовать",
                      value: `editor:publish:${draftId}`,
                      style: "primary",
                    },
                    {
                      label: "Отклонить",
                      value: `editor:reject:${draftId}`,
                      style: "danger",
                    },
                  ],
                },
              ],
            },
          },
        };

        const sent = await api.runtime.sendMessage(message);

        return { handled: true, sent };
      } catch (err) {
        return {
          handled: true,
          error: true,
          message: err?.message || "Pipeline error",
        };
      }
    }

    api.registerInteractiveHandler({
      channel: "telegram",
      namespace: "editor",
      handler: async (ctx) => {
        const payload = ctx?.callback?.payload;
        const chatId = ctx?.callback?.chatId;

        if (!payload) return { handled: true };

        const [action, , draftId] = payload.split(":");

        const draft = drafts.get(draftId);

        if (!draft) {
          await ctx.respond.editMessage({
            text: "❌ Черновик не найден или устарел",
          });
          return { handled: true };
        }

        if (action === "publish") {
          await api.runtime.sendMessage({
            channel: "telegram",
            to: TELEGRAM_CHANNEL_ID,
            content: {
              text: draft.article,
            },
          });

          await ctx.respond.editMessage({
            text: "✅ Статья опубликована",
          });

          drafts.delete(draftId);
          return { handled: true };
        }

        if (action === "reject") {
          awaitingFeedback.set(chatId, draftId);

          await ctx.respond.editMessage({
            text: "✋ Отклонено. Напиши, что нужно исправить.",
          });

          return { handled: true };
        }

        return { handled: true };
      },
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
