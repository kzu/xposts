// The archive, assembled from the environment: what both the Vercel function and the local server run.

import { createApp } from "./app.js";
import { azureStore } from "./azure.js";
import { createSaver } from "./capture.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const store = azureStore(env.AZURE_STORAGE_CONNECTION_STRING);
const app = createApp({ store, save: createSaver(env, store) });

export const handle = (request: Request) => app.fetch(request, env);
export const publicUrl = env.PUBLIC_URL;
