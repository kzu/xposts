// Mentions of the bot account: each one that points at a post asks for a save,
// and is answered with the image and the link.

import { CaptureError, type Deps } from "./deps";
import { savePath, type Env, type Save } from "./types";
import { fetchMentions, isBotConfigured, replyText, replyWithImage, type Mention } from "./x";

const SINCE_KEY = "mentions.since_id";

/** One poll never handles more mentions than this: a burst waits for the next poll. */
const MAX_PER_POLL = 10;
/** X refuses images over 5 MB; a reply to a larger save carries the link alone. */
const MAX_REPLY_IMAGE_BYTES = 5 * 1024 * 1024;

/** The X calls a poll makes, replaceable in tests. */
export interface Bot {
  fetchMentions: typeof fetchMentions;
  replyWithImage: typeof replyWithImage;
  replyText: typeof replyText;
}

export async function pollMentions(
  env: Env,
  { store, save }: Deps,
  bot: Bot = { fetchMentions, replyWithImage, replyText },
): Promise<{ seen: number; answered: number }> {
  if (!isBotConfigured(env)) return { seen: 0, answered: 0 };

  const sinceId = await store.getState(SINCE_KEY);
  const { mentions, newestId } = await bot.fetchMentions(env, sinceId);

  // The first poll only records where the timeline stands: mentions older than
  // the deployment are not answered.
  if (sinceId === null) {
    if (newestId) await store.setState(SINCE_KEY, newestId);
    return { seen: mentions.length, answered: 0 };
  }

  let answered = 0;
  for (const mention of mentions.slice(0, MAX_PER_POLL)) {
    if (mention.target) {
      let outcome: Save | string;
      try {
        outcome = (await save({ post: mention.target, source: "mention", requestedBy: `x:${mention.authorId}` })).save;
      } catch (error) {
        if (!(error instanceof CaptureError)) throw error;
        // X is down: stop here and leave this mention for the next poll.
        if (error.retryable) break;
        outcome = error.message;
      }
      // Taken before replying, so a poll that is run twice never answers twice.
      if (await store.claim(`replied/${mention.id}`)) {
        await reply(env, store, bot, mention, outcome);
        answered++;
      }
    }
    // Saved per mention, so a failure midway never handles the earlier ones again.
    await store.setState(SINCE_KEY, mention.id);
  }
  return { seen: mentions.length, answered };
}

async function reply(env: Env, store: Deps["store"], bot: Bot, mention: Mention, outcome: Save | string) {
  const to = `@${mention.authorHandle}`;
  if (typeof outcome === "string") {
    const text = `${to} I could not save this post: ${outcome}`.slice(0, 280);
    await bot.replyText(env, { inReplyToId: mention.id, text });
    return;
  }
  const text = `${to} Saved: ${env.PUBLIC_URL}${savePath(outcome)}`;
  const png = await store.readFile(outcome, "png");
  if (png && png.byteLength <= MAX_REPLY_IMAGE_BYTES) {
    const altText = `Saved post by @${outcome.handle}: ${outcome.excerpt}`;
    await bot.replyWithImage(env, { inReplyToId: mention.id, text, png, altText });
  } else {
    await bot.replyText(env, { inReplyToId: mention.id, text });
  }
}
