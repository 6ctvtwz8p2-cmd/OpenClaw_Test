import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import crypto from "crypto";

export default definePluginEntry({
  id: "agentstub",
  name: "OpenClaw Editor Agent",
  description: "Editor agent: web search → LLM article → draft approval → publish",

  register(api) {
    const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

    const drafts = new Map();

    // ─────────────────────────────────────────────
    // /start
    // ─────────────────────────────────────────────
    api.registerCommand({
      name: "start",
      description: "Start bot",
      handler: () => ({
        text:
          "Editor-agent активирован.\n\n" +
          "Отправь тему через /demo или текстом (если платформа поддерживает before_dispatch).\n" +
          "Я соберу статью и источники, затем отправлю черновик с кнопками.",
        continueAgent: false,
      }),
    });

    // ─────────────────────────────────────────────
    // /demo — тест генерации статьи + кнопки
    // ─────────────────────────────────────────────
    api.registerCommand({
      name: "demo",
      description: "Demo article pipeline",
      handler: async () => {
        const topic = "Искусственный интеллект";

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
Напиши короткую статью на тему: "${topic}".

Используй источники:
${sources.map(s => `[${s.id}] ${s.title} - ${s.url}`).join("\n")}

Правила:
- нейтральный стиль
- структура: заголовки + абзацы
- ссылки вида [1], [2]
`;

        const out = await api.runtime.llm.complete({
          messages: [{ role: "user", content: prompt }],
        });

        const article = out?.text || "Ошибка генерации";

        const draftId = crypto.randomUUID();

        drafts.set(draftId, {
          topic,
          article,
          sources,
        });

        return {
          text:
            article +
            "\n\nИсточники:\n" +
            sources.map(s => `[${s.id}] ${s.url}`).join("\n"),
          presentation: {
            blocks: [
              {
                type: "buttons",
                buttons: [
                  { label: "Опубликовать", value: `editor:publish:${draftId}`, style: "primary" },
                  { label: "Отклонить", value: `editor:reject:${draftId}`, style: "danger" },
                ],
              },
            ],
          },
        };
      },
    });

    // ─────────────────────────────────────────────
    // кнопки (publish / reject)
    // ─────────────────────────────────────────────
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
            text: "❌ Черновик не найден",
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
            text: "✅ Опубликовано",
          });

          drafts.delete(draftId);
          return { handled: true };
        }

        if (action === "reject") {
          await ctx.respond.editMessage({
            text: "✋ Отклонено. (в новом шаблоне можно добавить доработку)",
          });

          return { handled: true };
        }

        return { handled: true };
      },
    });
  },
});
