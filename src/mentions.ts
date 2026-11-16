// Mentions of the bot account: each one that points at a post asks for a capture.

import { getState, requestCapture, setState } from "./db";
import type { Env } from "./types";
import { fetchMentions, isBotConfigured } from "./x";

const SINCE_KEY = "mentions.since_id";

/** One poll never starts more captures than this: a burst of mentions waits for the next poll. */
const MAX_CAPTURES_PER_POLL = 20;

export async function pollMentions(
  env: Env,
  fetch: typeof fetchMentions = fetchMentions,
): Promise<{ seen: number; queued: number }> {
  if (!isBotConfigured(env)) return { seen: 0, queued: 0 };

  const sinceId = await getState(env.DB, SINCE_KEY);
  const { mentions, newestId } = await fetch(env, sinceId);

  // The first poll only records where the timeline stands: mentions older than
  // the deployment are not answered.
  if (sinceId === null) {
    if (newestId) await setState(env.DB, SINCE_KEY, newestId);
    return { seen: mentions.length, queued: 0 };
  }

  let queued = 0;
  let handled = sinceId;
  for (const mention of mentions) {
    if (queued >= MAX_CAPTURES_PER_POLL) break;
    if (mention.target) {
      const job = { id: mention.id, authorHandle: mention.authorHandle };
      const { capture, created } = await requestCapture(env, {
        postId: mention.target.id,
        source: "mention",
        requestedBy: `x:${mention.authorId}`,
        mention: job,
      });
      // A recent capture is reused; its job still runs, to answer this mention.
      if (!created) await env.ARCHIVE_QUEUE.send({ postId: capture.postId, ts: capture.ts, mention: job });
      queued++;
    }
    handled = mention.id;
    // Saved per mention, so a failure midway never queues the earlier ones again.
    await setState(env.DB, SINCE_KEY, handled);
  }
  return { seen: mentions.length, queued };
}
