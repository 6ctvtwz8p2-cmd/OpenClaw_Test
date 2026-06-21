import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "agentstub",
  name: "OpenClaw Editor Agent",
  description: "Editor agent with approval workflow",

  register(api) {
    // ─────────────────────────────
    // STATE (in-memory session store)
    // ─────────────────────────────
    const sessions = new Map();
    const getSession = (userId) => {
      if (!sessions.has(userId)) {
        sessions.set(userId, {
          topic: null,
          draft: null,
          feedback: null,
          state: "idle",
        });
      }
      return sessions.get(userId);
    };

    // ─────────────────────────────
    // REMOVE echo hook (IMPORTANT)
    // ─────────────────────────────
    // intentionally NOT using before_dispatch echo
    // so pipeline is not blocked

    // ─────────────────────────────
    // TEXT ENTRY → START PIPELINE
    // ─────────────────────────────
    api.on("before_dispatch", async (event) => {
      const text = String(event?.content ?? "").trim();
      const userId = event?.senderId;

      if (!text || text.startsWith("/")) return;

      const session = getSession(userId);
      session.topic = text;
      session.state = "searching";

      try {
        // 1. SEARCH (Tavily via OpenClaw)
        const searchRes = await api.runtime.webSearch.search({
          args: { query: text },
        });

        const sources = (searchRes?.result?.results || [])
          .slice(0, 5)
          .map((r) => `- ${r.title}\n${r.url}\n${r.content}`)
          .join("\n\n");

        // 2. PROMPT
        const prompt = `
Ты редактор-аналитик.

Напиши статью по теме: "${text}"

Используй ТОЛЬКО следующие источники:
${sources}

ТРЕБОВАНИЯ:
- 6–12 абзацев
- структура: intro → sections → conclusion
- обязательно вставь ссылки
- не выдумывай факты
- стиль: аналитический, понятный

${session.feedback ? `УЧТИ ЗАМЕЧАНИЯ: ${session.feedback}` : ""}
        `.trim();

        // 3. LLM
        const out = await api.runtime.llm.complete({
          messages: [{ role: "user", content: prompt }],
        });

        const article = out.text;

        session.draft = article;
        session.state = "review";

        // 4. SEND DRAFT WITH BUTTONS
        return {
          handled: true,
          text: article,
          presentation: {
            blocks: [
              {
                type: "buttons",
                buttons: [
                  {
                    label: "Опубликовать",
                    value: "editor:publish",
                    style: "primary",
                  },
                  {
                    label: "Отклонить",
                    value: "editor:reject",
                    style: "danger",
                  },
                ],
              },
            ],
          },
        };
      } catch (e) {
        return {
          handled: true,
          text: `Ошибка генерации: ${e.message}`,
        };
      }
    });

    // ─────────────────────────────
    // BUTTON HANDLER
    // ─────────────────────────────
    api.registerInteractiveHandler({
      channel: "telegram",
      namespace: "editor",

      handler: async (ctx) => {
        const userId = ctx.senderId;
        const action = ctx?.callback?.payload;
        const session = getSession(userId);

        // ───────── PUBLISH ─────────
        if (action === "publish") {
          session.state = "published";

          await fetch(
            `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: process.env.TELEGRAM_CHANNEL_ID,
                text: session.draft,
                disable_web_page_preview: true,
              }),
            }
          );

          await ctx.respond.editMessage({
            text: "✅ Статья опубликована в канал",
          });

          return { handled: true };
        }

        // ───────── REJECT ─────────
        if (action === "reject") {
          session.state = "waiting_feedback";

          await ctx.respond.editMessage({
            text: "✋ Напиши, что нужно исправить в статье",
          });

          return { handled: true };
        }

        return { handled: true };
      },
    });

    // ─────────────────────────────
    // FEEDBACK HANDLING (second step)
    // ─────────────────────────────
    api.on("before_dispatch", async (event) => {
      const text = String(event?.content ?? "").trim();
      const userId = event?.senderId;

      if (!text || text.startsWith("/")) return;

      const session = getSession(userId);

      if (session.state !== "waiting_feedback") return;

      session.feedback = text;
      session.state = "regen";

      // re-trigger generation
      return {
        handled: true,
        text: session.topic,
      };
    });
  },
});