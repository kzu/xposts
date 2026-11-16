// The archive, assembled from the environment: what both the Vercel function and the local server run.

import { createApp } from "./app";
import { azureStore } from "./azure";
import { createSaver } from "./capture";
import { loadEnv } from "./env";

const env = loadEnv();
const store = azureStore(env.AZURE_STORAGE_CONNECTION_STRING);
const app = createApp({ store, save: createSaver(env, store) });

export const handle = (request: Request) => app.fetch(request, env);
export const publicUrl = env.PUBLIC_URL;
