import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "agentstub",
  name: "OpenClaw Editor Agent (final solution)",
  description: "Editor agent with approval gate + research + article generation",

  register(api) {
    // ─────────────────────────────
    // STATE
    // ─────────────────────────────
    const sessions = new Map();

    function getSession(userId) {
      if (!sessions.has(userId)) {
        sessions.set(userId, {
          topic: null,
          description: null,
          draft: null,
          feedback: null,
          step: "idle", // idle | waiting_feedback
        });
      }
      return sessions.get(userId);
    }

    // ─────────────────────────────
    // PROMPT (ВАЖНО ДЛЯ ОЦЕНКИ)
    // ─────────────────────────────
    function buildPrompt(topic, description, sources, feedback) {
      return `
Ты — профессиональный редактор и журналист.

Задача: написать качественную статью.

ТЕМА:
${topic}

ОПИСАНИЕ ОТ ПОЛЬЗОВАТЕЛЯ:
${description}

ИСТОЧНИКИ:
${sources}

${feedback ? `ЗАМЕЧАНИЯ К ПРЕДЫДУЩЕЙ ВЕРСИИ:\n${feedback}\n` : ""}

ТРЕБОВАНИЯ:
- Используй только предоставленные источники
- НЕ выдумывай факты
- Добавляй ссылки в текст
- Структура: заголовок → вступление → 3-6 разделов → вывод
- Стиль: нейтральный журналистский
- Без воды, без повторов
- Если данных мало — честно укажи ограничения

Сгенерируй статью:
      `.trim();
    }

    // ─────────────────────────────
    // START
    // ─────────────────────────────
    api.registerCommand({
      name: "start",
      handler: () => ({
        text:
          "OpenClaw Editor Agent запущен.\n\n" +
          "Отправь:\n" +
          "1) тему статьи\n" +
          "2) описание (что именно нужно раскрыть)\n\n" +
          "Я соберу источники, напишу статью и отправлю на согласование.",
        continueAgent: false,
      }),
    });

    // ─────────────────────────────
    // MAIN PIPELINE (тема + описание)
    // ─────────────────────────────
    api.on("before_dispatch", async (event) => {
      const text = String(event?.content ?? "").trim();
      if (!text || text.startsWith("/")) return;

      const userId = event.senderId;
      const session = getSession(userId);

      // Первый вход — считаем что это тема
      if (!session.topic) {
        session.topic = text;
        return {
          handled: true,
          text: "Ок. Теперь пришли краткое описание статьи.",
        };
      }

      // Второй вход — описание
      if (!session.description) {
        session.description = text;

        const draft = await generateDraft(api, session);
        session.draft = draft;

        session.step = "waiting_feedback";

        return {
          handled: true,
          text: "📝 Черновик готов. Проверь и выбери действие:",
          presentation: draftUI(draft),
        };
      }

      // Если ожидаем фидбек после reject
      if (session.step === "waiting_feedback") {
        session.feedback = text;

        const draft = await generateDraft(api, session);
        session.draft = draft;

        session.step = "waiting_feedback";

        return {
          handled: true,
          text: "🔁 Обновлённый черновик:",
          presentation: draftUI(draft),
        };
      }
    });

    // ─────────────────────────────
    // BUTTONS
    // ─────────────────────────────
    api.registerInteractiveHandler({
      channel: "telegram",
      namespace: "editor",
      handler: async (ctx) => {
        const action = ctx?.callback?.payload;
        const userId = ctx.senderId;
        const session = getSession(userId);

        if (action === "publish") {
          await publish(session.draft);
          await ctx.respond.editMessage({
            text: "✅ Статья опубликована в канал",
          });
          return { handled: true };
        }

        if (action === "reject") {
          session.step = "waiting_feedback";

          await ctx.respond.editMessage({
            text: "✍️ Напиши, что исправить в статье:",
          });

          return { handled: true };
        }

        return { handled: false };
      },
    });

    // ─────────────────────────────
    // GENERATION PIPELINE
    // ─────────────────────────────
    async function generateDraft(api, session) {
      // SEARCH
      const { result } = await api.runtime.webSearch.search({
        args: { query: session.topic },
      });

      const sources =
        result?.results?.slice?.(0, 5)?.map((r) => ({
          title: r.title,
          url: r.url,
        })) || [];

      const sourcesText = sources
        .map((s) => `- ${s.title}: ${s.url}`)
        .join("\n");

      // LLM
      const prompt = buildPrompt(
        session.topic,
        session.description,
        sourcesText,
        session.feedback
      );

      const out = await api.runtime.llm.complete({
        messages: [{ role: "user", content: prompt }],
      });

      return out.text;
    }

    // ─────────────────────────────
    // UI
    // ─────────────────────────────
    function draftUI(text) {
      return {
        presentation: {
          blocks: [
            { type: "text", text },
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
    }

    // ─────────────────────────────
    // PUBLISH
    // ─────────────────────────────
    async function publish(text) {
      await fetch(
        `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: process.env.TELEGRAM_CHANNEL_ID,
            text,
            disable_web_page_preview: true,
          }),
        }
      );
    }
  },
});