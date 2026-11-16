// Runs against a real storage account, and only when asked:
//   XPOSTS_LIVE_AZURE=1 AZURE_STORAGE_CONNECTION_STRING=… npx vitest run test/azure.live.test.ts
// It writes under a handle no X account can have, and removes what it wrote.

import { createHash, randomBytes } from "node:crypto";

import { BlobServiceClient } from "@azure/storage-blob";
import { afterAll, describe, expect, it } from "vitest";

import { azureStore, SAVES_CONTAINER, STATE_CONTAINER } from "../src/azure";
import type { NewSave } from "../src/store";

const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const live = process.env.XPOSTS_LIVE_AZURE === "1" && !!connectionString;

// Longer than the 15 characters X allows for a handle.
const username = "xposts_live_test_";
const postId = String(BigInt(Date.now()) * 4194304n);
const png = randomBytes(256);
const sha256 = createHash("sha256").update(png).digest("hex");

const save: NewSave = {
  username,
  postId,
  handle: "XPosts_Live_Test_",
  authorName: "Tëst “Author” 😁",
  excerpt: "line one — ünïcode 😁 & <tags>",
  postedAt: "2026-11-16T04:27:37.000Z",
  capturedAt: new Date().toISOString(),
  pngSha256: sha256,
  recordSha256: "0".repeat(64),
  width: 1200,
  height: 344,
  source: "web",
};

describe.runIf(live)("azureStore, against the real account", () => {
  const store = azureStore(connectionString);
  const text = (value: string) => new TextEncoder().encode(value);

  afterAll(async () => {
    const service = BlobServiceClient.fromConnectionString(connectionString!);
    const saves = service.getContainerClient(SAVES_CONTAINER);
    for await (const blob of saves.listBlobsFlat({ prefix: `${username}/` })) await saves.deleteBlob(blob.name);
    const state = service.getContainerClient(STATE_CONTAINER);
    for await (const blob of state.listBlobsFlat({ prefix: "kv/live-test/" })) await state.deleteBlob(blob.name);
    for await (const blob of state.listBlobsFlat({ prefix: "claims/live-test/" })) await state.deleteBlob(blob.name);
    // The test save must not stay on the home page's list.
    const recent = state.getBlockBlobClient("recent.json");
    const list = JSON.parse((await recent.downloadToBuffer()).toString("utf8")) as { username: string }[];
    const kept = JSON.stringify(list.filter((entry) => entry.username !== username));
    await recent.upload(kept, Buffer.byteLength(kept), { blobHTTPHeaders: { blobContentType: "application/json" } });
  });

  it("stores a save once, and reports what Azure states about the blob", async () => {
    const first = await store.createSave(save, { png, record: text("{}"), xeetInput: text("{}") });
    expect(first.created).toBe(true);
    expect(first.save).toMatchObject(save);
    expect(first.save.blob.url).toBe(`https://xposts.blob.core.windows.net/saves/${username}/${postId}.png`);
    expect(first.save.blob.createdOn).toBe(first.save.blob.lastModified);
    expect(first.save.blob.contentMd5).toBe(createHash("md5").update(png).digest("base64"));

    // A second save of the same post changes nothing.
    const second = await store.createSave({ ...save, excerpt: "other" }, { png: randomBytes(8), record: text("{}"), xeetInput: text("{}") });
    expect(second).toEqual({ save: first.save, created: false });

    expect(await store.getSave({ username: username.toUpperCase(), postId })).toEqual(first.save);
    expect(await store.getSave({ username, postId: "1" })).toBeNull();
    expect((await store.listSaves(username)).map((s) => s.postId)).toEqual([postId]);
    expect(await store.listSaves(username)).toEqual([first.save]);
    expect(new Uint8Array((await store.readFile(first.save, "png"))!)).toEqual(new Uint8Array(png));
    expect(await store.readFile(first.save, "xApi")).toBeNull();
    expect((await store.recentSaves(5))[0]).toEqual(first.save);

    // What the archive reports is what anyone reads without credentials.
    const head = await fetch(first.save.blob.url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(new Date(head.headers.get("x-ms-creation-time")!).toISOString()).toBe(first.save.blob.createdOn);
    expect(head.headers.get("content-md5")).toBe(first.save.blob.contentMd5);
    expect(head.headers.get("x-ms-meta-sha256")).toBe(sha256);
    expect(head.headers.get("content-type")).toBe("image/png");
  }, 60_000);

  it("finds a save by post id and by hash once Azure has indexed its tags", async () => {
    let found = null;
    for (let attempt = 0; attempt < 30 && !found; attempt++) {
      found = await store.findBySha256(sha256);
      if (!found) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    expect(found?.postId).toBe(postId);
    expect((await store.findByPostId(postId))?.pngSha256).toBe(sha256);
    expect(await store.findBySha256("f".repeat(64))).toBeNull();
  }, 90_000);

  it("keeps private state and hands out one-time claims", async () => {
    const key = `live-test/${postId}`;
    expect(await store.getState(key)).toBeNull();
    await store.setState(key, "a");
    await store.setState(key, "b");
    expect(await store.getState(key)).toBe("b");
    expect(await store.claim(key)).toBe(true);
    expect(await store.claim(key)).toBe(false);
  });
});
