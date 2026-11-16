import { Hono } from "hono";

import { api } from "./api";
import { auth, sessionMiddleware } from "./auth";
import { pollMentions } from "./mentions";
import { abandonJob, CaptureError, runJob } from "./pipeline";
import type { AppEnv, ArchiveJob, Env } from "./types";
import { notFound, web } from "./web";

const app = new Hono<AppEnv>();
app.use(sessionMiddleware);
app.route("/", auth);
app.route("/", api);
app.route("/", web);
app.notFound(notFound);

/** The queue's `max_retries`: a job that still fails on this attempt is abandoned. */
const MAX_ATTEMPTS = 4;

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<ArchiveJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await runJob(env, message.body);
        message.ack();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // Only a CaptureError that says so is final; anything else may be a passing fault.
        const final = error instanceof CaptureError && !error.retryable;
        console.error(`capture ${message.body.postId}/${message.body.ts} failed (attempt ${message.attempts})`, error);
        if (final || message.attempts >= MAX_ATTEMPTS) {
          await abandonJob(env, message.body, reason);
          message.ack();
        } else {
          message.retry({ delaySeconds: 30 * message.attempts });
        }
      }
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const result = await pollMentions(env);
    if (result.seen) console.log(`mentions: ${result.seen} seen, ${result.queued} queued`);
  },
} satisfies ExportedHandler<Env, ArchiveJob>;
