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

        await api.runtime.sendMessage({
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
        });

        return { handled: true };
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
